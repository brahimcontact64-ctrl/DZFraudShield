"use client";

import { useEffect, useRef, useState } from "react";

type ActiveSync = {
  merchantId:      string;
  merchantName:    string | null;
  provider:        string;
  parcelsStatus:   string | null;
  parcelsTotal:    number | null;
  historiesStatus: string | null;
  historiesTotal:  number | null;
  lastHeartbeatAt: string | null;
  lastError:       string | null;
};

type QueueEntry = { pending: number; processing: number };

type ProgressPayload = {
  activeSyncs: ActiveSync[];
  queueDepth:  Record<string, QueueEntry>;
  metrics:     Record<string, number>;
  generatedAt: string;
};

const POLL_MS = 10_000;

const JOB_LABELS: Record<string, string> = {
  yalidine_history_full_sync:           "Full sync",
  yalidine_history_incremental_sync:    "Incremental",
  yalidine_history_targeted_sync:       "Targeted",
  yalidine_history_reputation_recompute: "Reputation",
  yalidine_bootstrap_sync:              "Bootstrap",
};

function statusDot(status: string | null) {
  if (status === "running")   return "bg-sky-400";
  if (status === "completed") return "bg-emerald-400";
  if (status === "failed")    return "bg-rose-400";
  if (status === "pending")   return "bg-amber-400";
  return "bg-slate-600";
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function DeliveryMonitor({ initialData }: { initialData?: ProgressPayload }) {
  const [data, setData]     = useState<ProgressPayload | null>(initialData ?? null);
  const [error, setError]   = useState<string | null>(null);
  const [stale, setStale]   = useState(false);
  const timerRef            = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    try {
      const res = await fetch("/api/v1/admin/delivery-intelligence/progress", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ProgressPayload;
      setData(payload);
      setError(null);
      setStale(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
      setStale(true);
    }
  }

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data && !error) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
        Loading live data…
      </div>
    );
  }

  const activeSyncs  = data?.activeSyncs ?? [];
  const queueDepth   = data?.queueDepth  ?? {};
  const updatedAt    = data?.generatedAt ?? null;
  const totalPending = Object.values(queueDepth).reduce((s, v) => s + v.pending + v.processing, 0);

  return (
    <div className="space-y-5">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-rose-400" : "bg-emerald-400 animate-pulse"}`}
          />
          {stale ? "Polling error — retrying" : "Live"} · updated {fmtRelative(updatedAt)}
        </span>
        {error ? (
          <span className="rounded-md bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
            {error}
          </span>
        ) : null}
        {totalPending > 0 ? (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
            {totalPending} job{totalPending === 1 ? "" : "s"} queued
          </span>
        ) : null}
      </div>

      {/* Active syncs */}
      {activeSyncs.length === 0 ? (
        <p className="text-sm text-slate-500">No syncs currently running.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700/40">
          <table className="min-w-[760px] w-full text-sm">
            <thead className="bg-slate-800/60 text-left text-[10px] uppercase tracking-[0.18em] text-slate-500 border-b border-slate-700/40">
              <tr>
                <th className="px-3 py-2.5">Merchant</th>
                <th className="px-3 py-2.5">Provider</th>
                <th className="px-3 py-2.5">Parcels</th>
                <th className="px-3 py-2.5">Histories</th>
                <th className="px-3 py-2.5">Last heartbeat</th>
                <th className="px-3 py-2.5">Error</th>
              </tr>
            </thead>
            <tbody>
              {activeSyncs.map((s) => (
                <tr
                  key={`${s.merchantId}-${s.provider}`}
                  className="border-t border-slate-700/30"
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-slate-100">
                      {s.merchantName ?? "Unknown"}
                    </p>
                    <p className="font-mono text-[10px] text-slate-500">
                      {s.merchantId?.slice(0, 8) ?? ""}…
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-sky-300">{s.provider}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${statusDot(s.parcelsStatus)}`} />
                      <span className="text-xs text-slate-300">{s.parcelsStatus ?? "—"}</span>
                      {s.parcelsTotal != null ? (
                        <span className="text-[10px] text-slate-500">
                          ({s.parcelsTotal.toLocaleString()})
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${statusDot(s.historiesStatus)}`} />
                      <span className="text-xs text-slate-300">{s.historiesStatus ?? "—"}</span>
                      {s.historiesTotal != null ? (
                        <span className="text-[10px] text-slate-500">
                          ({s.historiesTotal.toLocaleString()})
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-400">
                    {fmtRelative(s.lastHeartbeatAt)}
                  </td>
                  <td className="max-w-[200px] px-3 py-2.5">
                    {s.lastError ? (
                      <span
                        className="block truncate text-[11px] text-rose-300"
                        title={s.lastError}
                      >
                        {s.lastError.slice(0, 60)}
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-500">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Queue depth */}
      {Object.keys(queueDepth).length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(queueDepth).map(([type, counts]) => {
            const total = counts.pending + counts.processing;
            if (total === 0) return null;
            return (
              <div
                key={type}
                className="flex items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2"
              >
                <span className="text-[11px] font-medium text-slate-300">
                  {JOB_LABELS[type] ?? type}
                </span>
                {counts.processing > 0 ? (
                  <span className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                    {counts.processing} running
                  </span>
                ) : null}
                {counts.pending > 0 ? (
                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                    {counts.pending} pending
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
