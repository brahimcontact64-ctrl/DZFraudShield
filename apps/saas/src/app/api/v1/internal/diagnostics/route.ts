/**
 * GET /api/v1/internal/diagnostics
 *
 * Internal diagnostics dashboard for the MDI subsystem.
 * Protected by BACKGROUND_JOBS_SECRET or CRON_SECRET.
 *
 * Returns queue state, sync status, in-process metrics, and checkpoint values.
 * No credentials, phone hashes, or personal data are included.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getMdiMetricsSnapshot } from "@/lib/delivery-intelligence/mdi-metrics";

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const expectedSecret = process.env.BACKGROUND_JOBS_SECRET ?? process.env.CRON_SECRET;
  const token          = getBearerToken(req);
  if (!expectedSecret || token !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient();

  // ── Queue state ─────────────────────────────────────────────────────────────
  const [
    { count: qPending },
    { count: qProcessing },
    { count: qFailed24h },
    { data: runningJobs },
    { data: failedJobs },
  ] = await Promise.all([
    supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
    supabase.from("background_jobs").select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("updated_at", new Date(Date.now() - 86_400_000).toISOString()),
    supabase.from("background_jobs")
      .select("id, type, merchant_id, attempts, updated_at")
      .eq("status", "processing")
      .order("updated_at", { ascending: true })
      .limit(20),
    supabase.from("background_jobs")
      .select("id, type, merchant_id, attempts, last_error, updated_at")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  // ── Webhook last received ────────────────────────────────────────────────────
  const { data: lastWebhook } = await supabase
    .from("webhook_event_log")
    .select("event_type, tracking, received_at, processed, skip_reason")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── Sync status by merchant ──────────────────────────────────────────────────
  const { data: syncRows } = await supabase
    .from("merchant_history_sync_status")
    .select(
      "merchant_id, provider," +
      "full_parcels_status, full_parcels_completed_at, full_parcels_total," +
      "full_histories_status, full_histories_completed_at, full_histories_total," +
      "last_parcels_synced_at, last_histories_synced_at," +
      "last_heartbeat_at, last_error," +
      "full_parcels_cursor, full_histories_cursor",
    )
    .order("last_heartbeat_at", { ascending: false })
    .limit(50);

  type SyncRow = {
    merchant_id:             string;
    provider:                string;
    full_parcels_status:     string | null;
    full_parcels_completed_at: string | null;
    full_parcels_total:      number | null;
    full_histories_status:   string | null;
    full_histories_completed_at: string | null;
    full_histories_total:    number | null;
    last_parcels_synced_at:  string | null;
    last_histories_synced_at: string | null;
    last_heartbeat_at:       string | null;
    last_error:              string | null;
    full_parcels_cursor:     string | null;
    full_histories_cursor:   string | null;
  };

  const merchants = ((syncRows ?? []) as unknown as SyncRow[]).map((r) => ({
    merchantId:               r.merchant_id,
    provider:                 r.provider,
    fullSync: {
      parcelsStatus:          r.full_parcels_status,
      parcelsCompletedAt:     r.full_parcels_completed_at,
      parcelsTotal:           r.full_parcels_total,
      historiesStatus:        r.full_histories_status,
      historiesCompletedAt:   r.full_histories_completed_at,
      historiesTotal:         r.full_histories_total,
      // Cursor presence only — not the cursor URL (avoids leaking internal API paths)
      parcelsCursorPresent:   r.full_parcels_cursor !== null,
      historiesCursorPresent: r.full_histories_cursor !== null,
    },
    incrementalSync: {
      lastParcelsSyncedAt:    r.last_parcels_synced_at,
      lastHistoriesSyncedAt:  r.last_histories_synced_at,
    },
    lastHeartbeatAt: r.last_heartbeat_at,
    lastError:       r.last_error,
  }));

  // ── In-process metrics ───────────────────────────────────────────────────────
  const processMetrics = getMdiMetricsSnapshot();

  return NextResponse.json({
    ok:        true,
    timestamp: new Date().toISOString(),
    queue: {
      pending:     qPending   ?? 0,
      processing:  qProcessing ?? 0,
      failed_24h:  qFailed24h ?? 0,
      runningJobs: (runningJobs ?? []).map((j: Record<string, unknown>) => ({
        id:         j.id,
        type:       j.type,
        merchantId: j.merchant_id,
        attempts:   j.attempts,
        updatedAt:  j.updated_at,
      })),
      recentFailed: (failedJobs ?? []).map((j: Record<string, unknown>) => ({
        id:        j.id,
        type:      j.type,
        merchantId: j.merchant_id,
        attempts:  j.attempts,
        lastError: typeof j.last_error === "string" ? j.last_error.slice(0, 300) : null,
        updatedAt: j.updated_at,
      })),
    },
    webhook: {
      lastReceived: lastWebhook
        ? {
            eventType:  (lastWebhook as Record<string, unknown>).event_type,
            tracking:   (lastWebhook as Record<string, unknown>).tracking,
            receivedAt: (lastWebhook as Record<string, unknown>).received_at,
            processed:  (lastWebhook as Record<string, unknown>).processed,
            skipReason: (lastWebhook as Record<string, unknown>).skip_reason,
          }
        : null,
    },
    merchants,
    processMetrics,
  });
}
