import { createClient } from "@/lib/supabase/server";
import { MDI_CONFIG } from "@/lib/delivery-intelligence/mdi-config";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";

export type BackgroundJobType =
  | "send_push_notification"
  | "recompute_reputation"
  | "sync_delivery_status"
  | "sync_delivery_cache"
  | "sync_global_delivery_cache"
  | "create_shipment_retry"
  | "process_webhook_side_effects"
  | "refresh_dashboard_metrics"
  | "yalidine_bootstrap_sync"
  // Merchant Delivery Intelligence pipeline
  | "yalidine_history_full_sync"         // one-time full historical parcel + events sync
  | "yalidine_history_incremental_sync"  // scheduled incremental sync (every 4-6 h)
  | "yalidine_history_targeted_sync"     // webhook-triggered single-parcel refresh
  | "yalidine_history_reputation_recompute"   // identity resolution + reputation rebuild
  | "mdi_backfill_delivery_orders"           // one-time backfill: delivery_orders → merchant_shipment_history
  // Marketing Intelligence pipeline
  | "marketing_product_stats_recompute"     // recompute product + wilaya statistics after ingestion
  | "marketing_delivery_outcome_enrich"     // attach MSH delivery outcome to marketing order lines
  | "marketing_intelligence_backfill";      // cursor-based backfill of order_checks → marketing order lines

export type BackgroundJobStatus = "pending" | "processing" | "completed" | "failed";

export type EnqueueBackgroundJobInput = {
  type: BackgroundJobType;
  merchantId?: string | null;
  payload: Record<string, unknown>;
  runAfter?: string;
};

export type BackgroundJobRow = {
  id: string;
  type: BackgroundJobType;
  merchant_id: string | null;
  payload: Record<string, unknown>;
  status: BackgroundJobStatus;
  attempts: number;
  run_after: string;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
  last_error: string | null;
};

export async function enqueueBackgroundJob(input: EnqueueBackgroundJobInput): Promise<string | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("background_jobs")
      .insert({
        type: input.type,
        merchant_id: input.merchantId ?? null,
        payload: input.payload,
        status: "pending",
        run_after: input.runAfter ?? new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      return null;
    }

    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

export async function enqueueBackgroundJobs(inputs: EnqueueBackgroundJobInput[]): Promise<void> {
  if (inputs.length === 0) {
    return;
  }

  try {
    const supabase = createClient();
    const rows = inputs.map((item) => ({
      type: item.type,
      merchant_id: item.merchantId ?? null,
      payload: item.payload,
      status: "pending" as const,
      run_after: item.runAfter ?? new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    await supabase.from("background_jobs").insert(rows);
  } catch {
    // Fail-open for pre-migration environments.
  }
}

export async function claimBackgroundJobs(limit = 25): Promise<BackgroundJobRow[]> {
  const supabase = createClient();
  const nowIso = new Date().toISOString();

  const { data } = await supabase
    .from("background_jobs")
    .select("id,type,merchant_id,payload,status,attempts,run_after,created_at,updated_at,processed_at,last_error")
    .eq("status", "pending")
    .lte("run_after", nowIso)
    .order("run_after", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  const candidates = (data ?? []) as BackgroundJobRow[];
  if (candidates.length === 0) {
    return [];
  }

  const claimed: BackgroundJobRow[] = [];
  for (const job of candidates) {
    // Optimistic transition pending -> processing for exactly one worker.
    // If row already moved, this update is a no-op.
    // eslint-disable-next-line no-await-in-loop
    const { data: claimedRow } = await supabase
      .from("background_jobs")
      .update({
        status: "processing",
        attempts: Number(job.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id,type,merchant_id,payload,status,attempts,run_after,created_at,updated_at,processed_at,last_error")
      .maybeSingle();

    if (claimedRow) {
      claimed.push(claimedRow as BackgroundJobRow);
    }
  }

  return claimed;
}

export async function completeBackgroundJob(jobId: string) {
  const supabase = createClient();
  await supabase
    .from("background_jobs")
    .update({
      status: "completed",
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", jobId);
}

// ── Priority order for MDI job types ─────────────────────────────────────────
// Ordered highest → lowest. Types not in the list are claimed after all listed
// types, preserving FCFS ordering within the same priority tier.
const MDI_JOB_PRIORITY_ORDER: readonly BackgroundJobType[] = [
  "yalidine_history_targeted_sync",
  "yalidine_history_incremental_sync",
  "yalidine_history_full_sync",
  "yalidine_history_reputation_recompute",
] as const;

// ── Result types ──────────────────────────────────────────────────────────────

export type RecoverStuckJobsResult = {
  checked:   number;
  recovered: number;
  failed:    number;
};

// ── Dead job recovery ─────────────────────────────────────────────────────────

/**
 * Finds jobs that are stuck in "processing" for longer than `timeoutMs` and
 * either resets them to "pending" (with incremented attempts) or permanently
 * marks them "failed" when they have exceeded `maxAttempts`.
 *
 * Safety:
 *   - Only touches rows WHERE status = 'processing' AND updated_at < cutoff.
 *   - Each UPDATE is guarded by .eq("status", "processing") to prevent racing
 *     with a worker that just claimed the same row legitimately.
 *   - Never touches completed or failed rows.
 *
 * Called once per background-job processor tick, before claiming new work.
 */
export async function recoverStuckJobs(params?: {
  timeoutMs?:   number;
  maxAttempts?: number;
}): Promise<RecoverStuckJobsResult> {
  const timeoutMs   = params?.timeoutMs   ?? MDI_CONFIG.STUCK_JOB_TIMEOUT_MS;
  const maxAttempts = params?.maxAttempts ?? MDI_CONFIG.STUCK_JOB_MAX_ATTEMPTS;
  const cutoff      = new Date(Date.now() - timeoutMs).toISOString();
  const supabase    = createClient();

  const { data: stuckJobs } = await supabase
    .from("background_jobs")
    .select("id, type, merchant_id, attempts")
    .eq("status", "processing")
    .lt("updated_at", cutoff);

  const jobs = (stuckJobs ?? []) as Array<{
    id: string;
    type: string;
    merchant_id: string | null;
    attempts: number;
  }>;

  if (jobs.length === 0) return { checked: 0, recovered: 0, failed: 0 };

  let recovered = 0;
  let failed    = 0;

  for (const job of jobs) {
    const attempts = Number(job.attempts ?? 0) + 1;

    if (attempts > maxAttempts) {
      // Too many retries — permanently fail the job.
      // eslint-disable-next-line no-await-in-loop
      await supabase
        .from("background_jobs")
        .update({
          status:       "failed",
          attempts,
          last_error:   `stuck_job_recovery: exceeded ${maxAttempts} max attempts`,
          processed_at: new Date().toISOString(),
          updated_at:   new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "processing"); // guard against concurrent claim
      failed++;
      mdiLog({
        level:      "warn",
        component:  "background-jobs",
        event:      "job.stuck.exceeded_attempts",
        jobId:      job.id,
        merchantId: job.merchant_id,
        attempt:    attempts,
        result:     "marked_failed",
      });
    } else {
      // Still has retries remaining — reset to pending.
      // eslint-disable-next-line no-await-in-loop
      await supabase
        .from("background_jobs")
        .update({
          status:     "pending",
          attempts,
          run_after:  new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "processing"); // guard against concurrent claim
      recovered++;
      mdiLog({
        level:      "warn",
        component:  "background-jobs",
        event:      "job.stuck.recovered",
        jobId:      job.id,
        merchantId: job.merchant_id,
        attempt:    attempts,
        result:     "reset_to_pending",
      });
    }
  }

  return { checked: jobs.length, recovered, failed };
}

// ── Priority-aware job claiming ───────────────────────────────────────────────

/**
 * Claims up to `limit` pending background jobs, honouring the MDI priority
 * order defined in MDI_JOB_PRIORITY_ORDER.
 *
 * Strategy: fetch 4× limit candidates (FCFS order), re-sort by priority in
 * TypeScript, then claim the top `limit` using the same optimistic pending →
 * processing guard as claimBackgroundJobs.
 *
 * Anti-starvation: lower-priority jobs are included in the candidate pool and
 * are claimed whenever higher-priority types have no pending work.
 */
export async function claimBackgroundJobsByPriority(
  limit = MDI_CONFIG.DEFAULT_CLAIM_BATCH,
): Promise<BackgroundJobRow[]> {
  const supabase = createClient();
  const nowIso   = new Date().toISOString();
  const fetchCap = Math.min(limit * 4, 200); // never over-fetch beyond 200

  const { data } = await supabase
    .from("background_jobs")
    .select("id,type,merchant_id,payload,status,attempts,run_after,created_at,updated_at,processed_at,last_error")
    .eq("status", "pending")
    .lte("run_after", nowIso)
    .order("run_after",   { ascending: true })
    .order("created_at",  { ascending: true })
    .limit(fetchCap);

  const candidates = (data ?? []) as BackgroundJobRow[];
  if (candidates.length === 0) return [];

  // Re-sort by priority. Within the same priority tier the original FCFS
  // order (run_after ASC, created_at ASC) is preserved by a stable sort.
  candidates.sort((a, b) => {
    const pa = MDI_JOB_PRIORITY_ORDER.indexOf(a.type);
    const pb = MDI_JOB_PRIORITY_ORDER.indexOf(b.type);
    const ra  = pa === -1 ? MDI_JOB_PRIORITY_ORDER.length : pa;
    const rb  = pb === -1 ? MDI_JOB_PRIORITY_ORDER.length : pb;
    return ra - rb;
  });

  const claimed: BackgroundJobRow[] = [];

  for (const job of candidates) {
    if (claimed.length >= limit) break;

    // Optimistic pending → processing transition. If another worker already
    // claimed this row, the UPDATE matches zero rows and maybeSingle() returns
    // null — we skip it and try the next candidate.
    // eslint-disable-next-line no-await-in-loop
    const { data: claimedRow } = await supabase
      .from("background_jobs")
      .update({
        status:     "processing",
        attempts:   Number(job.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id,type,merchant_id,payload,status,attempts,run_after,created_at,updated_at,processed_at,last_error")
      .maybeSingle();

    if (claimedRow) {
      claimed.push(claimedRow as BackgroundJobRow);
    }
  }

  return claimed;
}

export async function failBackgroundJob(jobId: string, errorMessage: string, attempts: number, maxAttempts = 3) {
  const supabase = createClient();
  const shouldRetry = attempts < maxAttempts;
  const nextRunAfter = new Date(
    Date.now() + Math.min(MDI_CONFIG.RETRY_DELAY_MAX_MS, MDI_CONFIG.RETRY_DELAY_BASE_MS * attempts),
  ).toISOString();

  await supabase
    .from("background_jobs")
    .update({
      status: shouldRetry ? "pending" : "failed",
      run_after: shouldRetry ? nextRunAfter : new Date().toISOString(),
      processed_at: shouldRetry ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: errorMessage.slice(0, 1000),
    })
    .eq("id", jobId);
}
