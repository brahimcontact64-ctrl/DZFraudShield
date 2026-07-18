/**
 * GET /api/v1/admin/delivery-intelligence/progress
 *
 * Live snapshot of active MDI syncs and job queue depth.
 * Intended for polling by the admin monitor client component every 10 s.
 *
 * Returns:
 *   activeSyncs — rows in merchant_history_sync_status that are currently running
 *   queueDepth  — pending + processing counts per MDI job type
 *   metrics     — in-process counters from mdi-metrics.ts (reset on cold start)
 *   generatedAt — ISO timestamp
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getMdiMetricsSnapshot } from "@/lib/delivery-intelligence/mdi-metrics";

export const dynamic = "force-dynamic";

type SyncProgressRow = {
  merchant_id:            string;
  provider:               string;
  full_parcels_status:    string | null;
  full_parcels_total:     number | null;
  full_histories_status:  string | null;
  full_histories_total:   number | null;
  last_heartbeat_at:      string | null;
  last_error:             string | null;
};

type JobCountRow = {
  type:   string;
  status: string;
};

const MDI_JOB_TYPES = [
  "yalidine_history_full_sync",
  "yalidine_history_incremental_sync",
  "yalidine_history_targeted_sync",
  "yalidine_history_reputation_recompute",
  "yalidine_bootstrap_sync",
] as const;

export async function GET() {
  try {
    const supabase = createClient();

    const [
      { data: syncData },
      { data: jobData },
      { data: merchantData },
    ] = await Promise.all([
      supabase
        .from("merchant_history_sync_status")
        .select(
          "merchant_id, provider," +
          "full_parcels_status, full_parcels_total," +
          "full_histories_status, full_histories_total," +
          "last_heartbeat_at, last_error",
        )
        .or("full_parcels_status.eq.running,full_histories_status.eq.running"),
      supabase
        .from("background_jobs")
        .select("type, status")
        .in("type", MDI_JOB_TYPES as unknown as string[])
        .in("status", ["pending", "processing"]),
      supabase
        .from("merchants")
        .select("id, name"),
    ]);

    const syncs     = (syncData ?? []) as unknown as SyncProgressRow[];
    const jobs      = (jobData  ?? []) as JobCountRow[];
    const merchants = (merchantData ?? []) as { id: string; name: string }[];
    const byId      = new Map(merchants.map((m) => [m.id, m.name]));

    // ── Queue depth per job type ──────────────────────────────────────────────
    const queueDepth: Record<string, { pending: number; processing: number }> = {};
    for (const type of MDI_JOB_TYPES) {
      queueDepth[type] = { pending: 0, processing: 0 };
    }
    for (const job of jobs) {
      const entry = queueDepth[job.type];
      if (!entry) continue;
      if (job.status === "pending")    entry.pending++;
      if (job.status === "processing") entry.processing++;
    }

    // ── Active syncs with merchant name ───────────────────────────────────────
    const activeSyncs = syncs.map((s) => ({
      merchantId:          s.merchant_id,
      merchantName:        byId.get(s.merchant_id) ?? null,
      provider:            s.provider,
      parcelsStatus:       s.full_parcels_status,
      parcelsTotal:        s.full_parcels_total,
      historiesStatus:     s.full_histories_status,
      historiesTotal:      s.full_histories_total,
      lastHeartbeatAt:     s.last_heartbeat_at,
      lastError:           s.last_error,
    }));

    return NextResponse.json({
      activeSyncs,
      queueDepth,
      metrics:     getMdiMetricsSnapshot(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
