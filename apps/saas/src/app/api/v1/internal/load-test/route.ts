/**
 * POST /api/v1/internal/load-test
 *
 * Developer-only load testing utilities for the MDI subsystem.
 * BLOCKED in production (NODE_ENV === "production" returns 403).
 * Protected by BACKGROUND_JOBS_SECRET or CRON_SECRET in other environments.
 *
 * Measures: execution time, queue latency, DB query round-trip time.
 * Read-only operations only — never writes permanent data to production tables.
 *
 * Body:
 *   { "scenario": "queue_latency" | "db_read_throughput" | "webhook_burst" | "merchant_scale" }
 *   { "merchants": 10 }   — for merchant_scale
 *   { "count": 100 }      — for webhook_burst
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

function memoryUsageMb(): Record<string, number> {
  const m = process.memoryUsage();
  return {
    heapUsedMb:  Math.round(m.heapUsed  / 1024 / 1024),
    heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
    rssMb:       Math.round(m.rss       / 1024 / 1024),
    externalMb:  Math.round(m.external  / 1024 / 1024),
  };
}

// ── Scenario: queue_latency ───────────────────────────────────────────────────
// Measures time to count pending jobs and read the top 25.
async function runQueueLatency(): Promise<Record<string, unknown>> {
  const supabase = createClient();
  const memBefore = memoryUsageMb();
  const t0 = Date.now();

  let queryCount = 0;

  const t1 = Date.now();
  const { count: pendingCount } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  queryCount++;
  const pendingQueryMs = Date.now() - t1;

  const t2 = Date.now();
  const { data: topJobs } = await supabase
    .from("background_jobs")
    .select("id, type, merchant_id, status, run_after, created_at")
    .eq("status", "pending")
    .order("run_after",  { ascending: true })
    .order("created_at", { ascending: true })
    .limit(25);
  queryCount++;
  const selectQueryMs = Date.now() - t2;

  const totalMs = Date.now() - t0;
  const memAfter = memoryUsageMb();

  return {
    scenario:       "queue_latency",
    totalMs,
    pendingQueryMs,
    selectQueryMs,
    pendingJobs:    pendingCount ?? 0,
    sampleSize:     (topJobs ?? []).length,
    dbQueryCount:   queryCount,
    memoryBefore:   memBefore,
    memoryAfter:    memAfter,
    heapDeltaMb:    memAfter.heapUsedMb - memBefore.heapUsedMb,
  };
}

// ── Scenario: db_read_throughput ──────────────────────────────────────────────
// Measures time to read shipment history and sync status tables.
async function runDbReadThroughput(): Promise<Record<string, unknown>> {
  const supabase = createClient();
  const memBefore = memoryUsageMb();
  const t0 = Date.now();

  let queryCount = 0;

  const reads = await Promise.all([
    supabase.from("merchant_shipment_history")
      .select("id", { count: "exact", head: true }),
    supabase.from("shipment_status_events")
      .select("id", { count: "exact", head: true }),
    supabase.from("merchant_history_sync_status")
      .select("merchant_id, provider, last_heartbeat_at")
      .limit(100),
    supabase.from("webhook_event_log")
      .select("id", { count: "exact", head: true })
      .gte("received_at", new Date(Date.now() - 86_400_000).toISOString()),
    supabase.from("customer_reputation")
      .select("id", { count: "exact", head: true }),
  ]);
  queryCount += reads.length;

  const totalMs = Date.now() - t0;
  const memAfter = memoryUsageMb();

  return {
    scenario:              "db_read_throughput",
    totalMs,
    avgQueryMs:            Math.round(totalMs / reads.length),
    dbQueryCount:          queryCount,
    shipmentHistoryRows:   reads[0].count ?? 0,
    statusEventRows:       reads[1].count ?? 0,
    syncStatusMerchants:   (reads[2].data ?? []).length,
    webhooksLast24h:       reads[3].count ?? 0,
    reputationRows:        reads[4].count ?? 0,
    memoryBefore:          memBefore,
    memoryAfter:           memAfter,
  };
}

// ── Scenario: webhook_burst ───────────────────────────────────────────────────
// Simulates N concurrent webhook log reads (read-only — no writes).
async function runWebhookBurst(count: number): Promise<Record<string, unknown>> {
  const cap = Math.min(count, 100); // never more than 100 concurrent reads
  const supabase = createClient();
  const memBefore = memoryUsageMb();
  const t0 = Date.now();

  const promises = Array.from({ length: cap }, () =>
    supabase
      .from("webhook_event_log")
      .select("event_id, tracking, processed, received_at")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );

  const results = await Promise.allSettled(promises);
  const totalMs = Date.now() - t0;
  const memAfter = memoryUsageMb();

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const errored   = results.filter((r) => r.status === "rejected").length;

  return {
    scenario:       "webhook_burst",
    concurrency:    cap,
    totalMs,
    avgPerQueryMs:  Math.round(totalMs / cap),
    succeeded,
    errored,
    throughputQps:  Math.round((cap / totalMs) * 1000),
    memoryBefore:   memBefore,
    memoryAfter:    memAfter,
  };
}

// ── Scenario: merchant_scale ──────────────────────────────────────────────────
// Reads sync status for N merchants to estimate scheduler overhead.
async function runMerchantScale(merchants: number): Promise<Record<string, unknown>> {
  const cap = Math.min(merchants, 10_000);
  const supabase = createClient();
  const memBefore = memoryUsageMb();
  const t0 = Date.now();

  const { data, count } = await supabase
    .from("merchant_history_sync_status")
    .select("merchant_id, provider, last_parcels_synced_at", { count: "exact" })
    .limit(cap);

  const totalMs = Date.now() - t0;
  const memAfter = memoryUsageMb();

  const withCheckpoint  = (data ?? []).filter(
    (r: Record<string, unknown>) => r.last_parcels_synced_at !== null,
  ).length;

  return {
    scenario:            "merchant_scale",
    requestedMerchants:  merchants,
    actualRows:          (data ?? []).length,
    totalTableRows:      count ?? 0,
    totalMs,
    withCheckpoint,
    withoutCheckpoint:   (data ?? []).length - withCheckpoint,
    memoryBefore:        memBefore,
    memoryAfter:         memAfter,
    estimatedSchedulerMs: Math.round(totalMs * 2), // gate 1 + gate 3 per merchant
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Load testing is disabled in production" }, { status: 403 });
  }

  const expectedSecret = process.env.BACKGROUND_JOBS_SECRET ?? process.env.CRON_SECRET;
  const token          = getBearerToken(req);
  if (expectedSecret && token !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body     = await req.json().catch(() => ({})) as Record<string, unknown>;
  const scenario = String(body.scenario ?? "queue_latency");
  const count    = Number(body.count    ?? 10);
  const merchants = Number(body.merchants ?? 100);

  try {
    let result: Record<string, unknown>;

    switch (scenario) {
      case "queue_latency":      result = await runQueueLatency();               break;
      case "db_read_throughput": result = await runDbReadThroughput();           break;
      case "webhook_burst":      result = await runWebhookBurst(count);          break;
      case "merchant_scale":     result = await runMerchantScale(merchants);     break;
      default:
        return NextResponse.json({
          error:    "Unknown scenario",
          available: ["queue_latency", "db_read_throughput", "webhook_burst", "merchant_scale"],
        }, { status: 400 });
    }

    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
