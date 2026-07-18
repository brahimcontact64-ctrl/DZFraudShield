"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { GlobalDeliverySyncStatus } from "@/lib/delivery-intelligence/global-delivery-cache";

const TOTAL_ORIGINS    = 58;
const POLL_INTERVAL_MS = 2_000;
const STALE_LOCK_MS    = 5 * 60_000; // must match global-delivery-cache.ts

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full bg-[#D6A74C] transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    idle:      { label: "Idle",      cls: "bg-slate-500/20 text-slate-300 ring-slate-400/20" },
    running:   { label: "Running",   cls: "bg-amber-500/20 text-amber-200 ring-amber-400/20 animate-pulse" },
    success:   { label: "Success",   cls: "bg-emerald-500/20 text-emerald-200 ring-emerald-400/20" },
    failed:    { label: "Failed",    cls: "bg-rose-500/20 text-rose-200 ring-rose-400/20" },
    partial:   { label: "Partial",   cls: "bg-orange-500/20 text-orange-200 ring-orange-400/20" },
    cancelled: { label: "Cancelled", cls: "bg-slate-500/20 text-slate-300 ring-slate-400/20" },
  };
  const { label, cls } = map[status] ?? map.idle;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${cls}`}>
      {label}
    </span>
  );
}

function MetricPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-white">{Number(value).toLocaleString("en-US")}</p>
    </div>
  );
}

export function DeliveryCacheSyncPanel({
  initialStatus,
}: {
  initialStatus: GlobalDeliverySyncStatus;
}) {
  const router  = useRouter();
  const [status, setStatus]         = useState<GlobalDeliverySyncStatus>(initialStatus);
  const [elapsed, setElapsed]       = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync prop → state on server refresh
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  // Stale = status is "running" but the heartbeat hasn't been updated in STALE_LOCK_MS.
  const lastHeartbeat = status.last_heartbeat_at ? new Date(status.last_heartbeat_at).getTime() : 0;
  const isStale       = status.status === "running" && Date.now() - lastHeartbeat > STALE_LOCK_MS;
  const isRunning     = status.status === "running" && !isStale;

  // Derive combined "is it actually stopping" state:
  // either we just clicked Stop (isStopping=true) or the DB already reflects cancel_requested
  const isActuallyStopping = isStopping || (status.status === "running" && status.cancel_requested);

  // Any secondary action in-flight (retry or update-prices)
  const isSecondaryBusy = isRetrying || isUpdating;

  // Polling: call router.refresh() so the server component re-renders with fresh Supabase data
  useEffect(() => {
    const isRunning = status.status === "running";

    if (isRunning) {
      pollRef.current = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      // Clear isStopping once the sync has actually stopped
      if (isStopping) setIsStopping(false);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.status, router]);

  // Live elapsed timer — updates every second client-side without waiting for a server refresh
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

  const handleStart = useCallback(async () => {
    if (isRunning || isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const resp = await fetch("/api/v1/admin/delivery-cache/global-sync", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
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
      const resp = await fetch("/api/v1/admin/delivery-cache/stop-sync", { method: "POST" });
      if (!resp.ok) {
        const json = await resp.json().catch(() => ({})) as Record<string, unknown>;
        console.error("[stop-sync] failed:", json.error ?? resp.status);
        setIsStopping(false);
      }
      // On success: keep isStopping=true; it resets when status.status leaves "running"
    } catch (err) {
      console.error("[stop-sync] error:", err instanceof Error ? err.message : String(err));
      setIsStopping(false);
    }
  }, [isStopping, status.status]);

  // Retry only the failed origins — never re-syncs successful origins.
  const handleRetry = useCallback(async () => {
    if (isRunning || isSecondaryBusy || isStarting) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      const resp = await fetch("/api/v1/admin/delivery-cache/retry-failed", { method: "POST" });
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

  // Re-sync all 58 origins incrementally (geo preserved, only changed prices written).
  const handleUpdatePrices = useCallback(async () => {
    if (isRunning || isSecondaryBusy || isStarting) return;
    setIsUpdating(true);
    setUpdateError(null);
    try {
      const resp = await fetch("/api/v1/admin/delivery-cache/update-prices", { method: "POST" });
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

  // ── Derived values ──────────────────────────────────────────────────────────

  const done        = status.origins_synced.length;
  const failedCount = status.origins_failed.length;
  const pct         = Math.round((done / TOTAL_ORIGINS) * 100);

  const isDone        = status.status === "success"
    || status.status === "partial"
    || status.status === "failed"
    || status.status === "cancelled";

  let estRemaining: number | null = null;
  if (isRunning && done > 0 && elapsed > 0) {
    const msPerOrigin = elapsed / done;
    estRemaining = (TOTAL_ORIGINS - done) * msPerOrigin;
  }

  const stageLabel =
    status.sync_stage === "syncing_geo"
      ? "Syncing geography (wilayas, communes, offices)…"
      : status.sync_stage === "syncing_prices"
      ? `Syncing prices — origin wilaya ${status.current_origin_id ?? "…"}`
      : isRunning
      ? "Starting…"
      : null;

  const anyBusy = isRunning || isStarting || isSecondaryBusy;

  return (
    <div className="space-y-4">

      {/* ── Primary action row: Global Sync / Restart / Stop ── */}
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
            onClick={handleStart}
            disabled={isStarting || isSecondaryBusy}
            className="rounded-full bg-[#D6A74C] px-4 py-2 text-sm font-semibold text-[#08111A] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting
              ? "Starting…"
              : isStale
              ? "Restart Sync"
              : "Global Sync"}
          </button>
        )}

        <StatusBadge status={status.status} />

        {startError && (
          <p className="text-xs text-rose-400">{startError}</p>
        )}
      </div>

      {/* ── Secondary actions: Retry Failed + Update Prices ── */}
      {!isRunning && (
        <div className="flex flex-wrap items-center gap-3">

          {/* Retry Failed Origins — visible only when failed origins exist */}
          {failedCount > 0 && (
            <button
              onClick={handleRetry}
              disabled={anyBusy}
              className="rounded-full border border-rose-400/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRetrying
                ? "Starting retry…"
                : `Retry ${failedCount} Failed Origin${failedCount !== 1 ? "s" : ""}`}
            </button>
          )}

          {/* Update Prices — incremental re-sync of all 58 origins, geo preserved */}
          <button
            onClick={handleUpdatePrices}
            disabled={anyBusy}
            className="rounded-full border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUpdating ? "Starting update…" : "Update Prices"}
          </button>

          {retryError  && <p className="text-xs text-rose-400">{retryError}</p>}
          {updateError && <p className="text-xs text-rose-400">{updateError}</p>}
        </div>
      )}

      {/* ── Cancelled notice ── */}
      {status.status === "cancelled" && (
        <p className="text-sm text-slate-400">
          Synchronization cancelled by administrator.
        </p>
      )}

      {/* ── Stale lock warning ── */}
      {isStale && (
        <p className="text-xs text-amber-400">
          Previous sync appears to have crashed (no heartbeat for over 5 minutes). Click <strong>Restart Sync</strong> to begin a fresh run.
        </p>
      )}

      {/* ── Progress panel (visible while running or after completion) ── */}
      {(isRunning || isDone) && (
        <div className="rounded-2xl border border-white/10 bg-[#0C1724] p-4 space-y-4">

          {/* Stage + timing row */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-slate-200 font-medium">
              {isActuallyStopping
                ? "Finishing current operation before stopping…"
                : stageLabel ?? (status.status === "success"
                  ? "Completed successfully"
                  : status.status === "cancelled"
                  ? "Stopped by administrator"
                  : "Finished")}
            </span>
            <div className="flex items-center gap-3 text-slate-400 text-xs font-mono">
              {isRunning && elapsed > 0 && (
                <span>Elapsed: {formatDuration(elapsed)}</span>
              )}
              {isRunning && !isActuallyStopping && estRemaining !== null && (
                <span>~{formatDuration(estRemaining)} remaining</span>
              )}
              {status.last_sync_success_at && !isRunning && (
                <span>Finished {new Date(status.last_sync_success_at).toLocaleTimeString()}</span>
              )}
            </div>
          </div>

          {/* Price-sync progress bar */}
          {(status.sync_stage === "syncing_prices" || (isDone && done + failedCount > 0)) && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-400">
                <span>
                  Origins synced: <span className="text-white font-medium">{done}</span>
                  {failedCount > 0 && (
                    <span className="ml-2 text-rose-400">· {failedCount} failed</span>
                  )}
                  <span className="ml-2">/ {TOTAL_ORIGINS}</span>
                </span>
                <span>{pct}%</span>
              </div>
              <ProgressBar pct={pct} />
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

          {/* Geo-sync spinner */}
          {status.sync_stage === "syncing_geo" && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-500 border-t-[#D6A74C]" />
              <span>Fetching from Yalidine API…</span>
            </div>
          )}

          {/* Metric pills */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricPill label="Wilayas"  value={status.wilayas_count} />
            <MetricPill label="Communes" value={status.communes_count} />
            <MetricPill label="Offices"  value={status.offices_count} />
            <MetricPill label="Prices"   value={status.prices_count} />
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
          No sync has run yet. Click <strong className="text-slate-400">Global Sync</strong> to populate geo data and all 58 origin prices.
        </p>
      )}
    </div>
  );
}
