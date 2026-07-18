/**
 * provider-bootstrap.ts
 *
 * Provider-agnostic bootstrap: schedules the initial history/cache sync for any
 * provider when a merchant account is first connected or reconnected.
 *
 * Per provider:
 *   - Yalidine  → yalidine_bootstrap_sync  (delivery cache)
 *               + yalidine_history_full_sync (MDI full history, if not already done)
 *   - All others → sync_delivery_cache     (generic delivery cache refresh)
 *     (MDI data for non-Yalidine providers is written inline by runDeliverySync)
 *
 * Callers: account-connect flows, reconnect flows, admin manual trigger.
 * Idempotent: duplicate and already-completed syncs are suppressed automatically.
 */

import { createClient } from "@/lib/supabase/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

const YALIDINE_CACHE_JOB   = "yalidine_bootstrap_sync"    as const;
const YALIDINE_HISTORY_JOB = "yalidine_history_full_sync" as const;
const GENERIC_JOB_TYPE     = "sync_delivery_cache"        as const;
const STALE_LOCK_MS        = 5 * 60_000;

export type BootstrapResult = {
  enqueued:        boolean;
  jobId:           string | null;
  historyJobId:    string | null;
  reason:          string;
};

/**
 * Schedule provider cache sync + MDI history sync for a merchant.
 *
 * Safe to call every time an account is connected or updated —
 * duplicate and already-completed jobs are suppressed automatically.
 */
export async function scheduleProviderSync(
  merchantId: string,
  provider:   string,
  source:     string = "account_connect",
): Promise<BootstrapResult> {
  const isYalidine = provider === "yalidine";
  const supabase   = createClient();

  // ── 1. Check for an actively running Yalidine sync ────────────────────────
  if (isYalidine) {
    const { data: syncRow } = await supabase
      .from("merchant_delivery_sync_status")
      .select("status, last_heartbeat_at")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .maybeSingle();

    if (syncRow) {
      const row = syncRow as { status: string; last_heartbeat_at: string | null };
      if (row.status === "running") {
        const lastHb = row.last_heartbeat_at
          ? new Date(row.last_heartbeat_at).getTime()
          : 0;
        if (Date.now() - lastHb < STALE_LOCK_MS) {
          return { enqueued: false, jobId: null, historyJobId: null, reason: "sync_running" };
        }
      }
    }
  }

  // ── 2. Cache/bootstrap sync ───────────────────────────────────────────────
  const cacheJobType = isYalidine ? YALIDINE_CACHE_JOB : GENERIC_JOB_TYPE;

  const { count: cacheCount } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("type", cacheJobType)
    .in("status", ["pending", "processing"]);

  let cacheJobId: string | null = null;
  if ((cacheCount ?? 0) === 0) {
    cacheJobId = await enqueueBackgroundJob({
      type:       cacheJobType,
      merchantId,
      payload:    { source, provider },
    });
    if (cacheJobId) {
      console.log(
        `[provider-bootstrap:${merchantId}] enqueued ${cacheJobType}` +
        ` source=${source} provider=${provider}`,
      );
    }
  }

  // ── 3. MDI history full sync (Yalidine only) ──────────────────────────────
  // Non-Yalidine providers: MDI data flows inline via runDeliverySync dual-write.
  // Yalidine: separate dedicated pipeline; skip if already completed.
  let historyJobId: string | null = null;
  if (isYalidine) {
    const { data: syncStatus } = await supabase
      .from("merchant_history_sync_status")
      .select("full_parcels_status, full_histories_status")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .maybeSingle();

    const statusRow = syncStatus as {
      full_parcels_status:   string | null;
      full_histories_status: string | null;
    } | null;

    const alreadyCompleted =
      statusRow?.full_parcels_status   === "completed" &&
      statusRow?.full_histories_status === "completed";

    if (!alreadyCompleted) {
      const { count: histCount } = await supabase
        .from("background_jobs")
        .select("id", { count: "exact", head: true })
        .eq("merchant_id", merchantId)
        .eq("type", YALIDINE_HISTORY_JOB)
        .in("status", ["pending", "processing"]);

      if ((histCount ?? 0) === 0) {
        historyJobId = await enqueueBackgroundJob({
          type:       YALIDINE_HISTORY_JOB,
          merchantId,
          payload:    { source, provider },
        });
        if (historyJobId) {
          console.log(
            `[provider-bootstrap:${merchantId}] enqueued ${YALIDINE_HISTORY_JOB}` +
            ` source=${source}`,
          );
        }
      }
    }
  }

  const enqueued = cacheJobId !== null || historyJobId !== null;
  return {
    enqueued,
    jobId:        cacheJobId,
    historyJobId,
    reason:       enqueued ? "enqueued" : "already_handled",
  };
}
