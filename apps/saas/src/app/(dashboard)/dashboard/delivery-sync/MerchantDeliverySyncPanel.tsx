"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { MerchantDeliverySyncStatus } from "@/lib/delivery-intelligence/merchant-delivery-sync";
import { formatTimeOnly } from "@/lib/format-date";

const TOTAL_ORIGINS    = 58;
const POLL_INTERVAL_MS = 2_000;
const STALE_LOCK_MS    = 5 * 60_000;

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

// ── Shared sub-components (dark-card style, matches admin panel) ───────────────

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full bg-[#D6A74C] transition-all duration-700 ease-in-out"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

// Used outside the dark card — light theme colours that read on white background.
function StatusBadge({ status, isWaiting }: { status: string; isWaiting: boolean }) {
  if (isWaiting) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 bg-amber-50 text-amber-700 ring-amber-200">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Waiting
      </span>
    );
  }
  const map: Record<string, { label: string; cls: string }> = {
    idle:      { label: "Idle",      cls: "bg-slate-100 text-slate-500 ring-slate-200" },
    running:   { label: "Running",   cls: "bg-amber-50 text-amber-700 ring-amber-200 animate-pulse" },
    success:   { label: "Success",   cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
    failed:    { label: "Failed",    cls: "bg-rose-50 text-rose-700 ring-rose-200" },
    partial:   { label: "Partial",   cls: "bg-orange-50 text-orange-700 ring-orange-200" },
    cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-500 ring-slate-200" },
  };
  const { label, cls } = map[status] ?? map.idle;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${cls}`}>
      {label}
    </span>
  );
}

// Inside the dark card — same style as admin panel.
function MetricPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-white">
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </p>
    </div>
  );
}

// Highlighted when the value is non-zero (rate-limit activity).
function ActivityPill({ label, value, active }: { label: string; value: string | number; active: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${active ? "border-amber-400/20 bg-amber-500/10" : "border-white/10 bg-white/5"}`}>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`mt-0.5 text-base font-semibold ${active ? "text-amber-200" : "text-slate-400"}`}>
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </p>
    </div>
  );
}

// Quota window pill with mini fill-bar.
function QuotaPill({ label, value, max }: { label: string; value: number | null; max: number }) {
  const pct      = value != null ? Math.round((value / max) * 100) : null;
  const exhausted = value != null && value <= 0;
  const low       = value != null && value > 0 && value <= Math.floor(max * 0.12);
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${exhausted ? "border-rose-400/30 bg-rose-500/10" : "border-white/10 bg-white/5"}`}>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`mt-0.5 text-base font-semibold ${exhausted ? "text-rose-300" : low ? "text-amber-200" : value == null ? "text-slate-500" : "text-white"}`}>
        {value != null ? value.toLocaleString("en-US") : "—"}
      </p>
      {pct != null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all duration-500 ${exhausted ? "bg-rose-500" : low ? "bg-amber-400" : "bg-emerald-400"}`}
            style={{ width: `${Math.max(0, pct)}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function MerchantDeliverySyncPanel({
  initialStatus,
}: {
  initialStatus: MerchantDeliverySyncStatus;
}) {
  const router = useRouter();
  const [status, setStatus]           = useState(initialStatus);
  const [elapsed, setElapsed]         = useState(0);
  const [isStarting, setIsStarting]   = useState(false);
  const [isStopping, setIsStopping]   = useState(false);
  const [startError, setStartError]   = useState<string | null>(null);
  const [isRetrying, setIsRetrying]   = useState(false);
  const [retryError, setRetryError]   = useState<string | null>(null);
  const [isUpdating, setIsUpdating]   = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync server-rendered prop → local state on each refresh.
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  // Derived state.
  const lastHeartbeat      = status.last_heartbeat_at ? new Date(status.last_heartbeat_at).getTime() : 0;
  const isStale            = status.status === "running" && Date.now() - lastHeartbeat > STALE_LOCK_MS;
  const isRunning          = status.status === "running" && !isStale;
  const isActuallyStopping = isStopping || (status.status === "running" && status.cancel_requested);
  const isSecondaryBusy    = isRetrying || isUpdating;

  // Quota-wait detection: any window at 0 while running ⇒ sync is sleeping.
  const isWaiting = isRunning && !isActuallyStopping && (
    status.quota_second === 0 || status.quota_minute === 0 || status.quota_hour === 0
  );
  const waitingWindow =
    status.quota_hour   === 0 ? "hour"   :
    status.quota_minute === 0 ? "minute" :
    status.quota_second === 0 ? "second" : null;

  // ── Polling ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (status.status === "running") {
      pollRef.current = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (isStopping) setIsStopping(false);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.status, router]);

  // ── Elapsed timer ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (status.status === "running" && status.last_sync_started_at) {
      const base = new Date(status.last_sync_started_at).getTime();
      const tick = () => setElapsed(Date.now() - base);
      tick();
      timerRef.current = setInterval(tick, 1_000);
    } else {
      setElapsed(0);
    }
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [status.status, status.last_sync_started_at]);

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleStart = useCallback(async (skipGeo = false) => {
    if (isRunning || isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const resp = await fetch("/api/v1/delivery/merchant-sync/start", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ skipGeo }),
      });
      const json = await resp.json().catch(() => ({})) as Record<string, unknown>;
      if (!resp.ok) {
        setStartError(String(json.error ?? `HTTP ${resp.status}`));
      } else {
        router.refresh();
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start sync");
    } finally {
      setIsStarting(false);
    }
  }, [isRunning, isStarting, router]);

  const handleStop = useCallback(async () => {
    if (isStopping || status.status !== "running") return;
    setIsStopping(true);
    try {
      const resp = await fetch("/api/v1/delivery/merchant-sync/stop", { method: "POST" });
      if (!resp.ok) {
        const json = await resp.json().catch(() => ({})) as Record<string, unknown>;
        console.error("[merchant-sync stop] failed:", json.error ?? resp.status);
        setIsStopping(false);
      }
    } catch (err) {
      console.error("[merchant-sync stop] error:", err instanceof Error ? err.message : String(err));
      setIsStopping(false);
    }
  }, [isStopping, status.status]);

  const handleRetry = useCallback(async () => {
    if (isRunning || isSecondaryBusy || isStarting) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      const resp = await fetch("/api/v1/delivery/merchant-sync/retry", { method: "POST" });
      const json = await resp.json().catch(() => ({})) as Record<string, unknown>;
      if (!resp.ok) {
        setRetryError(String(json.error ?? `HTTP ${resp.status}`));
      } else {
        router.refresh();
      }
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Failed to start retry");
    } finally {
      setIsRetrying(false);
    }
  }, [isRunning, isSecondaryBusy, isStarting, router]);

  const handleUpdatePrices = useCallback(async () => {
    if (isRunning || isSecondaryBusy || isStarting) return;
    setIsUpdating(true);
    setUpdateError(null);
    try {
      const resp = await fetch("/api/v1/delivery/merchant-sync/start", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ skipGeo: true }),
      });
      const json = await resp.json().catch(() => ({})) as Record<string, unknown>;
      if (!resp.ok) {
        setUpdateError(String(json.error ?? `HTTP ${resp.status}`));
      } else {
        router.refresh();
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Failed to start price update");
    } finally {
      setIsUpdating(false);
    }
  }, [isRunning, isSecondaryBusy, isStarting, router]);

  // ── Derived display values ──────────────────────────────────────────────────

  const done        = status.origins_synced.length;
  const failedCount = status.origins_failed.length;
  const pct         = Math.round((done / TOTAL_ORIGINS) * 100);
  const isDone      = ["success", "partial", "failed", "cancelled"].includes(status.status);
  const anyBusy     = isRunning || isStarting || isSecondaryBusy;

  let estRemaining: number | null = null;
  if (isRunning && done > 0 && elapsed > 0) {
    estRemaining = ((TOTAL_ORIGINS - done) * elapsed) / done;
  }

  // ── Current-operation label ─────────────────────────────────────────────────
  // More descriptive than admin panel: shows the exact origin number.

  const stageLabel: string =
    isActuallyStopping
      ? "Finishing current operation before stopping…"
      : status.sync_stage === "syncing_geo"
      ? "Syncing geographic data (wilayas, communes, stop desks)…"
      : status.sync_stage === "syncing_prices"
      ? `Fetching prices for origin ${status.current_origin_id ?? "…"} / ${TOTAL_ORIGINS}`
      : isRunning
      ? "Starting…"
      : status.status === "success"
      ? "Completed successfully"
      : status.status === "partial"
      ? `Completed — ${failedCount} origin(s) failed`
      : status.status === "failed"
      ? "Sync failed"
      : status.status === "cancelled"
      ? "Stopped by you"
      : "";

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div>
        <h2 className="text-lg font-bold text-slate-800">Merchant Yalidine Delivery Sync</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Prices fetched from your own Yalidine account — independent of the admin global cache.
          Used at checkout for all your orders.
        </p>
      </div>

      {/* ── Primary action row: Start / Stop / Restart ── */}
      <div className="flex flex-wrap items-center gap-3">
        {isRunning ? (
          isActuallyStopping ? (
            <button
              disabled
              className="flex items-center gap-2 rounded-full bg-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-75"
            >
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-slate-200" />
              Stopping sync…
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-500"
            >
              Stop Sync
            </button>
          )
        ) : (
          <button
            onClick={() => handleStart(false)}
            disabled={isStarting || isSecondaryBusy}
            className="rounded-full bg-[#D6A74C] px-4 py-2 text-sm font-semibold text-[#08111A] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? "Starting…" : isStale ? "Restart Sync" : "Start Sync"}
          </button>
        )}

        <StatusBadge status={status.status} isWaiting={isWaiting} />

        {startError && (
          <p className="text-xs text-rose-600">{startError}</p>
        )}
      </div>

      {/* ── Secondary actions: Retry Failed + Update Prices ── */}
      {!isRunning && (
        <div className="flex flex-wrap items-center gap-3">
          {failedCount > 0 && (
            <button
              onClick={handleRetry}
              disabled={anyBusy}
              className="rounded-full border border-rose-400/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRetrying
                ? "Starting retry…"
                : `Retry ${failedCount} Failed Origin${failedCount !== 1 ? "s" : ""}`}
            </button>
          )}

          <button
            onClick={handleUpdatePrices}
            disabled={anyBusy}
            className="rounded-full border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-700 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUpdating ? "Starting update…" : "Update Prices"}
          </button>

          {retryError  && <p className="text-xs text-rose-600">{retryError}</p>}
          {updateError && <p className="text-xs text-rose-600">{updateError}</p>}
        </div>
      )}

      {/* ── Notices ── */}
      {status.status === "cancelled" && (
        <p className="text-sm text-slate-400">
          Synchronization cancelled.
        </p>
      )}

      {isStale && (
        <p className="text-xs text-amber-600">
          Previous sync appears to have crashed (no heartbeat for over 5 minutes).
          Click <strong>Restart Sync</strong> to begin a fresh run.
        </p>
      )}

      {/* ── Progress panel — dark card, same style as admin ── */}
      {(isRunning || isDone) && (
        <div className="rounded-2xl border border-white/10 bg-[#0C1724] p-4 space-y-4">

          {/* Stage + timing row */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-slate-200">
              {stageLabel}
            </span>
            <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
              {isRunning && elapsed > 0 && (
                <span>Elapsed: {formatDuration(elapsed)}</span>
              )}
              {isRunning && !isActuallyStopping && estRemaining !== null && (
                <span>~{formatDuration(estRemaining)} remaining</span>
              )}
              {status.last_sync_success_at && !isRunning && (
                <span>Finished {formatTimeOnly(status.last_sync_success_at)}</span>
              )}
            </div>
          </div>

          {/* Quota-wait banner — only shown when a window is at 0 */}
          {isWaiting && (
            <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 px-3 py-2.5 ring-1 ring-amber-400/20">
              <span className="inline-block h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-amber-600 border-t-amber-300" />
              <span className="text-xs font-medium text-amber-200">
                Waiting for {waitingWindow} quota reset — sync will resume automatically
              </span>
            </div>
          )}

          {/* Price-sync progress bar (shown once prices are syncing or done) */}
          {(status.sync_stage === "syncing_prices" || (isDone && done + failedCount > 0)) && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-400">
                <span>
                  Origins synced:{" "}
                  <span className="font-semibold text-white">{done}</span>
                  {failedCount > 0 && (
                    <span className="ml-2 text-rose-400">· {failedCount} failed</span>
                  )}
                  <span className="ml-2">/ {TOTAL_ORIGINS}</span>
                </span>
                <span className="font-semibold text-[#D6A74C]">{pct}%</span>
              </div>
              <ProgressBar pct={pct} />
            </div>
          )}

          {/* Geo-sync spinner + indeterminate bar */}
          {status.sync_stage === "syncing_geo" && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-500 border-t-[#D6A74C]" />
                <span>Fetching from Yalidine API…</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-[#D6A74C]/40" />
              </div>
            </div>
          )}

          {/* Failed origins detail */}
          {status.origins_failed.length > 0 && (
            <div className="rounded-xl bg-rose-500/10 px-3 py-2 ring-1 ring-rose-400/20">
              <p className="text-xs font-semibold text-rose-300">
                {status.origins_failed.length} origin(s) skipped — prices may be incomplete
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-rose-400">
                Wilaya IDs: {status.origins_failed.join(", ")}
              </p>
            </div>
          )}

          {/* Geo + price counters — same 4-pill grid as admin */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricPill label="Wilayas"    value={status.wilayas_count} />
            <MetricPill label="Communes"   value={status.communes_count} />
            <MetricPill label="Stop desks" value={status.offices_count} />
            <MetricPill label="Prices"     value={status.prices_count} />
          </div>

          {/* ── Rate-limit activity ── */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Rate-limit activity
            </p>
            <div className="grid grid-cols-3 gap-2">
              <ActivityPill
                label="Pauses"
                value={status.rate_limit_pauses}
                active={status.rate_limit_pauses > 0}
              />
              <ActivityPill
                label="Total wait"
                value={formatDuration(status.rate_limit_pause_total_ms)}
                active={status.rate_limit_pause_total_ms > 0}
              />
              <ActivityPill
                label="429 Retries"
                value={status.retry_count}
                active={status.retry_count > 0}
              />
            </div>
          </div>

          {/* ── Quota remaining ── */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Quota remaining
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <QuotaPill label="/ sec"  value={status.quota_second} max={5} />
              <QuotaPill label="/ min"  value={status.quota_minute} max={50} />
              <QuotaPill label="/ hr"   value={status.quota_hour}   max={1_000} />
              <QuotaPill label="/ day"  value={status.quota_day}    max={10_000} />
            </div>
          </div>

          {/* Error message */}
          {status.error_message && (
            <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-rose-400/20">
              {status.error_message}
            </p>
          )}
        </div>
      )}

      {/* ── Idle state hint ── */}
      {status.status === "idle" && (
        <p className="text-xs text-slate-500">
          No sync has run yet. Click{" "}
          <strong className="text-slate-400">Start Sync</strong>{" "}
          to pull geo data and all {TOTAL_ORIGINS} × {TOTAL_ORIGINS} destination prices
          from your Yalidine account. This sync runs on your own quota — not the admin&apos;s.
        </p>
      )}
    </div>
  );
}
