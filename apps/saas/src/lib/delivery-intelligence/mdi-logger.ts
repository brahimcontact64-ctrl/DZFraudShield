/**
 * mdi-logger.ts
 *
 * Structured JSON logging for the Merchant Delivery Intelligence pipeline.
 *
 * Every log entry is serialised as a single-line JSON object and written to
 * the console channel that matches the severity level so that log aggregators
 * (Vercel logs, Datadog, etc.) can parse and filter them automatically.
 *
 * Contract:
 *   - Never logs credentials, API keys, phone numbers, or personal data.
 *   - Every entry includes a UTC timestamp (ISO-8601).
 *   - `component` and `event` are always present for reliable log filtering.
 */

export type MdiLogLevel = "info" | "warn" | "error";

export type MdiLogContext = {
  /** Severity level (controls which console channel receives the entry). */
  level:        MdiLogLevel;
  /** Module emitting this log (e.g. "full-sync", "webhook", "background-jobs"). */
  component:    string;
  /** Dot-separated event name (e.g. "sync.started", "job.recovered"). */
  event:        string;
  /** The merchant this entry belongs to. */
  merchantId?:  string | null;
  /** Delivery provider code (e.g. "yalidine"). */
  provider?:    string | null;
  /** Parcel tracking number when available. */
  tracking?:    string | null;
  /** Canonical customer identity ID when resolved. */
  identityId?:  string | null;
  /** Background job ID. */
  jobId?:       string | null;
  /** Wall-clock duration of the operation in milliseconds. */
  durationMs?:  number;
  /** High-level outcome ("ok", "skipped", "error", "recovered", …). */
  result?:      string;
  /** Machine-readable error code when result is "error". */
  errorCode?:   string;
  /** Current retry attempt number (1-based). */
  attempt?:     number;
  /** Any additional structured key–value pairs. */
  [key: string]: unknown;
};

/**
 * Emits a structured JSON log line to the appropriate console channel.
 *
 * Usage:
 *   mdiLog({ level: "info",  component: "full-sync", event: "sync.started",   merchantId, provider });
 *   mdiLog({ level: "error", component: "webhook",   event: "hmac.invalid",   errorCode: "signature_mismatch" });
 *   mdiLog({ level: "warn",  component: "jobs",      event: "job.recovered",  jobId, attempt: 2, result: "reset_to_pending" });
 */
export function mdiLog(ctx: MdiLogContext): void {
  const { level, ...fields } = ctx;
  const line = JSON.stringify({ ...fields, timestamp: new Date().toISOString() });
  if (level === "error")     console.error(line);
  else if (level === "warn") console.warn(line);
  else                       console.info(line);
}
