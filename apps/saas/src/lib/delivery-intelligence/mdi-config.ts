/**
 * mdi-config.ts
 *
 * Centralised operational configuration for the Merchant Delivery Intelligence
 * pipeline.  Every timeout, cap, and threshold is read from an environment
 * variable so it can be tuned in production without a deployment.
 *
 * All defaults are identical to the previously-hardcoded values so a
 * deployment without the env vars behaves exactly as before.
 */

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MDI_CONFIG = {
  // ── Dead Job Recovery (Step C) ──────────────────────────────────────────────
  /** Jobs stuck in "processing" longer than this (ms) are reset to "pending". */
  STUCK_JOB_TIMEOUT_MS:   envInt("MDI_STUCK_JOB_TIMEOUT_MS",   10 * 60_000), // 10 min
  /** Attempts ceiling before a stuck job is permanently marked "failed". */
  STUCK_JOB_MAX_ATTEMPTS: envInt("MDI_STUCK_JOB_MAX_ATTEMPTS",  3),

  // ── Background Job Retry ────────────────────────────────────────────────────
  /** Base delay between retries: delay = min(MAX, BASE × attempts). */
  RETRY_DELAY_BASE_MS: envInt("MDI_RETRY_DELAY_BASE_MS", 5_000),
  /** Maximum backoff cap for failed-job retries (ms). */
  RETRY_DELAY_MAX_MS:  envInt("MDI_RETRY_DELAY_MAX_MS",  60_000),

  // ── Queue ───────────────────────────────────────────────────────────────────
  /** Default number of jobs to claim per background-job processor tick. */
  DEFAULT_CLAIM_BATCH: envInt("MDI_CLAIM_BATCH", 25),

  // ── Yalidine API ────────────────────────────────────────────────────────────
  /** Maximum consecutive 429 responses before aborting a fetch call. */
  MAX_RATE_LIMIT_RETRIES: envInt("MDI_MAX_RATE_LIMIT_RETRIES", 5),

  // ── Incremental Sync ────────────────────────────────────────────────────────
  /** Overlap window (ms) subtracted from the last checkpoint before fetching. */
  OVERLAP_MS:           envInt("MDI_OVERLAP_MS",           24 * 60 * 60_000), // 24 h
  /** Safety ceiling on parcels processed in one incremental run. */
  MAX_PARCELS_PER_RUN:  envInt("MDI_MAX_PARCELS_PER_RUN",  5_000),
  /** Minimum wall-clock time between two incremental syncs for the same merchant (ms). */
  MIN_SYNC_INTERVAL_MS: envInt("MDI_MIN_SYNC_INTERVAL_MS", 60 * 60_000),     // 1 h

  // ── Webhook ─────────────────────────────────────────────────────────────────
  /** TTL for the in-process account cache keyed by Yalidine tenant ID (ms). */
  WEBHOOK_CACHE_TTL_MS: envInt("MDI_WEBHOOK_CACHE_TTL_MS", 5 * 60_000),     // 5 min

  // ── Metrics ─────────────────────────────────────────────────────────────────
  /** Maximum number of execution-time samples kept in the rolling window. */
  METRICS_WINDOW_SIZE: envInt("MDI_METRICS_WINDOW_SIZE", 1_000),
} as const;
