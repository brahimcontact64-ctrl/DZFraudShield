/**
 * mdi-metrics.ts
 *
 * In-process metrics accumulator for the Merchant Delivery Intelligence pipeline.
 *
 * Counters accumulate across requests within the same Node.js process lifetime.
 * In a serverless deployment (Vercel) each function instance resets independently;
 * use the /api/v1/internal/diagnostics endpoint for aggregate DB-derived stats.
 *
 * Usage:
 *   incrementMdiCounter("webhooksReceived");
 *   recordMdiExecutionTime(durationMs);
 *   const snap = getMdiMetricsSnapshot();
 */

import { MDI_CONFIG } from "@/lib/delivery-intelligence/mdi-config";

// ── Counter key registry ──────────────────────────────────────────────────────

export type MdiCounterKey =
  | "fullSyncRuns"
  | "incrementalSyncRuns"
  | "targetedSyncRuns"
  | "shipmentsProcessed"
  | "shipmentsUpdated"
  | "eventsWritten"
  | "identitiesResolved"
  | "reputationJobsCreated"
  | "webhooksReceived"
  | "webhooksDuplicate"
  | "webhooksFailed"
  | "backgroundJobsProcessed"
  | "backgroundJobsFailed"
  | "backgroundJobsRetried"
  | "stuckJobsRecovered"
  | "rateLimitHits"
  | "serverErrorHits";

type MdiCounters = Record<MdiCounterKey, number>;

// ── Module-level state ────────────────────────────────────────────────────────

const _counters: MdiCounters = {
  fullSyncRuns:            0,
  incrementalSyncRuns:     0,
  targetedSyncRuns:        0,
  shipmentsProcessed:      0,
  shipmentsUpdated:        0,
  eventsWritten:           0,
  identitiesResolved:      0,
  reputationJobsCreated:   0,
  webhooksReceived:        0,
  webhooksDuplicate:       0,
  webhooksFailed:          0,
  backgroundJobsProcessed: 0,
  backgroundJobsFailed:    0,
  backgroundJobsRetried:   0,
  stuckJobsRecovered:      0,
  rateLimitHits:           0,
  serverErrorHits:         0,
};

/** Rolling window of execution times in milliseconds. */
const _executionTimesMs: number[] = [];

// ── Public API ────────────────────────────────────────────────────────────────

/** Increment a named counter by `by` (default 1). */
export function incrementMdiCounter(key: MdiCounterKey, by = 1): void {
  _counters[key] += by;
}

/** Record one execution time sample into the rolling window. */
export function recordMdiExecutionTime(ms: number): void {
  _executionTimesMs.push(ms);
  if (_executionTimesMs.length > MDI_CONFIG.METRICS_WINDOW_SIZE) {
    _executionTimesMs.shift();
  }
}

/** Return a point-in-time snapshot of all counters plus derived timing stats. */
export function getMdiMetricsSnapshot(): MdiCounters & {
  avgExecutionMs: number;
  maxExecutionMs: number;
  sampleCount:    number;
} {
  const times = _executionTimesMs;
  const avg   = times.length > 0
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 0;
  const max   = times.length > 0 ? Math.max(...times) : 0;
  return { ..._counters, avgExecutionMs: avg, maxExecutionMs: max, sampleCount: times.length };
}
