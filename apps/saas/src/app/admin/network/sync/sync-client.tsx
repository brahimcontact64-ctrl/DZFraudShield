"use client";

import { useState } from "react";

type SyncProvider = "yalidine" | "zr_express" | "all";

type AccountReport = {
  provider: string;
  merchantId: string;
  accountId: string;
  dryRun: boolean;
  ordersImported: number;
  ordersUpdated: number;
  failedRecords: number;
  delivered: number;
  refused: number;
  noAnswer: number;
  returned: number;
  cancelled: number;
  pending: number;
  identitiesCreated: number;
  identitiesUpdated: number;
  identitiesMerged: number;
  durationSeconds: number;
  error?: string;
};

type SyncReport = {
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  dryRun: boolean;
  provider: string | null;
  accountsProcessed: number;
  accounts: AccountReport[];
  totals: {
    ordersImported: number;
    ordersUpdated: number;
    failedRecords: number;
    delivered: number;
    refused: number;
    noAnswer: number;
    returned: number;
    cancelled: number;
    pending: number;
    identitiesCreated: number;
    identitiesUpdated: number;
    identitiesMerged: number;
  };
};

type ScheduledSyncSummary = {
  mode: "full" | "incremental";
  pagesFetched: number;
  parcelsFetched: number;
  parcelsKept: number;
  parcelsDroppedByIncrementalFilter: number;
  ordersInserted: number;
  ordersUpdated: number;
  syncedOrders: number;
  failedOrders: number;
  accountId: string;
  provider: string;
};

type DBReport = {
  id: string;
  provider: string;
  merchant_id: string | null;
  dry_run: boolean;
  orders_imported: number;
  orders_updated: number;
  failed_records: number;
  delivered_count: number;
  refused_count: number;
  no_answer_count: number;
  returned_count: number;
  cancelled_count: number;
  identities_created: number;
  identities_updated: number;
  identities_merged: number;
  duration_seconds: number | null;
  error_message: string | null;
  completed_at: string;
};

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    yalidine: "bg-amber-900/40 text-amber-300 ring-amber-700/40",
    zr_express: "bg-blue-900/40 text-blue-300 ring-blue-700/40",
    all: "bg-emerald-900/40 text-emerald-300 ring-emerald-700/40",
  };
  const cls = colors[provider] ?? "bg-slate-800 text-slate-300 ring-slate-700/40";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${cls}`}>
      {provider}
    </span>
  );
}

function StatusBadge({ ok, dryRun }: { ok: boolean; dryRun: boolean }) {
  if (dryRun) {
    return (
      <span className="inline-flex items-center rounded-full bg-purple-900/40 px-2.5 py-0.5 text-xs font-semibold text-purple-300 ring-1 ring-purple-700/40">
        dry run
      </span>
    );
  }
  return ok ? (
    <span className="inline-flex items-center rounded-full bg-emerald-900/40 px-2.5 py-0.5 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-700/40">
      success
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-red-900/40 px-2.5 py-0.5 text-xs font-semibold text-red-300 ring-1 ring-red-700/40">
      error
    </span>
  );
}

function MetricBox({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-white/5 p-3 ring-1 ring-white/8">
      <span className="text-[11px] uppercase tracking-widest text-slate-400">{label}</span>
      <span className="text-xl font-semibold tabular-nums text-white">{value}</span>
    </div>
  );
}

export function NetworkSyncClient({ initialReports }: { initialReports: DBReport[] }) {
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeReport, setActiveReport] = useState<SyncReport | null>(null);
  const [pastReports, setPastReports] = useState<DBReport[]>(initialReports);
  const [error, setError] = useState<string | null>(null);

  async function triggerSync(provider: SyncProvider) {
    setRunning(true);
    setError(null);
    setActiveReport(null);

    try {
      const res = await fetch("/api/v1/admin/network/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, dryRun, maxPages: 500 }),
      });

      const json = await res.json() as { report?: SyncReport; error?: string };

      if (!res.ok || json.error) {
        setError(json.error ?? "Sync failed");
        return;
      }

      setActiveReport(json.report!);

      // Reload report history
      const reportsRes = await fetch("/api/v1/admin/network/sync");
      const reportsJson = await reportsRes.json() as { reports?: DBReport[] };
      if (reportsJson.reports) {
        setPastReports(reportsJson.reports);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRunning(false);
    }
  }

  async function runScheduledSyncNow() {
    setRunning(true);
    setError(null);
    setActiveReport(null);

    try {
      const startedAt = new Date().toISOString();
      const res = await fetch("/api/v1/admin/network/scheduled-sync-now", {
        method: "POST",
      });

      const json = await res.json() as { summary?: ScheduledSyncSummary[]; error?: string };
      if (!res.ok || json.error) {
        setError(json.error ?? "Scheduled sync failed");
        return;
      }

      const accounts = (json.summary ?? []).map((row) => ({
        merchantId: "scheduled",
        ordersImported: Number(row.ordersInserted ?? 0),
        failedRecords: Number(row.failedOrders ?? 0),
        ...row,
        dryRun: false,
        delivered: 0,
        refused: 0,
        noAnswer: 0,
        returned: 0,
        cancelled: 0,
        pending: 0,
        identitiesCreated: 0,
        identitiesUpdated: 0,
        identitiesMerged: 0,
        durationSeconds: 0,
      }));

      const totals = accounts.reduce(
        (acc, row) => ({
          ordersImported: acc.ordersImported + Number(row.ordersInserted ?? 0),
          ordersUpdated: acc.ordersUpdated + Number(row.ordersUpdated ?? 0),
          failedRecords: acc.failedRecords + Number(row.failedOrders ?? 0),
          delivered: acc.delivered,
          refused: acc.refused,
          noAnswer: acc.noAnswer,
          returned: acc.returned,
          cancelled: acc.cancelled,
          pending: acc.pending,
          identitiesCreated: acc.identitiesCreated,
          identitiesUpdated: acc.identitiesUpdated,
          identitiesMerged: acc.identitiesMerged,
        }),
        {
          ordersImported: 0,
          ordersUpdated: 0,
          failedRecords: 0,
          delivered: 0,
          refused: 0,
          noAnswer: 0,
          returned: 0,
          cancelled: 0,
          pending: 0,
          identitiesCreated: 0,
          identitiesUpdated: 0,
          identitiesMerged: 0,
        }
      );

      setActiveReport({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationSeconds: 0,
        dryRun: false,
        provider: "all",
        accountsProcessed: accounts.length,
        accounts,
        totals,
      });

      const reportsRes = await fetch("/api/v1/admin/network/sync");
      const reportsJson = await reportsRes.json() as { reports?: DBReport[] };
      if (reportsJson.reports) {
        setPastReports(reportsJson.reports);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Controls ── */}
      <div className="rounded-2xl bg-white/5 p-6 ring-1 ring-white/10">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-[#D6A74C]">
          Sync Controls
        </h2>

        <div className="mb-6 flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <div
              onClick={() => setDryRun((v) => !v)}
              className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${dryRun ? "bg-purple-600" : "bg-emerald-600"}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${dryRun ? "left-0.5 translate-x-0" : "left-0.5 translate-x-4"}`}
              />
            </div>
            {dryRun ? "Dry Run (no writes)" : "Live (writes to DB)"}
          </label>
          {dryRun && (
            <span className="text-xs text-purple-400">
              Dry run: orders will be fetched and counted but NOT stored.
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            disabled={running}
            onClick={runScheduledSyncNow}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-400/40 hover:bg-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {running ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-300/30 border-t-emerald-300" />
            ) : null}
            Run Scheduled Sync Now
          </button>
          {(["yalidine", "zr_express", "all"] as SyncProvider[]).map((p) => (
            <button
              key={p}
              disabled={running}
              onClick={() => triggerSync(p)}
              className="inline-flex items-center gap-2 rounded-xl bg-[#D6A74C]/10 px-4 py-2 text-sm font-medium text-[#D6A74C] ring-1 ring-[#D6A74C]/30 hover:bg-[#D6A74C]/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {running ? (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#D6A74C]/40 border-t-[#D6A74C]" />
              ) : null}
              {p === "all" ? "Sync All Providers" : `Sync ${p === "yalidine" ? "Yalidine" : "ZR Express"}`}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-900/30 p-3 text-sm text-red-300 ring-1 ring-red-700/40">
            {error}
          </div>
        )}
      </div>

      {/* ── Latest run result ── */}
      {activeReport && (
        <div className="rounded-2xl bg-white/5 p-6 ring-1 ring-white/10">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-[#D6A74C]">
              Latest Sync Result
            </h2>
            <div className="flex items-center gap-2">
              <ProviderBadge provider={activeReport.provider ?? "all"} />
              <StatusBadge ok={activeReport.totals.failedRecords === 0} dryRun={activeReport.dryRun} />
              <span className="text-xs text-slate-400">{activeReport.durationSeconds}s</span>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            <MetricBox label="Orders" value={activeReport.totals.ordersImported + activeReport.totals.ordersUpdated} />
            <MetricBox label="Imported" value={activeReport.totals.ordersImported} />
            <MetricBox label="Updated" value={activeReport.totals.ordersUpdated} />
            <MetricBox label="Delivered" value={activeReport.totals.delivered} />
            <MetricBox label="Failed" value={activeReport.totals.refused + activeReport.totals.noAnswer + activeReport.totals.returned + activeReport.totals.cancelled} />
            <MetricBox label="Identities +" value={activeReport.totals.identitiesCreated} />
          </div>

          {/* Per-account rows */}
          {activeReport.accounts.length > 0 && (
            <div className="overflow-x-auto rounded-xl ring-1 ring-white/10">
              <table className="w-full text-xs text-slate-300">
                <thead>
                  <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="px-4 py-2">Provider</th>
                    <th className="px-4 py-2">Account</th>
                    <th className="px-4 py-2 text-right">Imported</th>
                    <th className="px-4 py-2 text-right">Updated</th>
                    <th className="px-4 py-2 text-right">Delivered</th>
                    <th className="px-4 py-2 text-right">Refused</th>
                    <th className="px-4 py-2 text-right">NoAnswer</th>
                    <th className="px-4 py-2 text-right">Returned</th>
                    <th className="px-4 py-2 text-right">Identities+</th>
                    <th className="px-4 py-2 text-right">Failed</th>
                    <th className="px-4 py-2 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {activeReport.accounts.map((acc) => (
                    <tr key={acc.accountId} className="border-b border-white/5 hover:bg-white/3">
                      <td className="px-4 py-2"><ProviderBadge provider={acc.provider} /></td>
                      <td className="px-4 py-2 font-mono text-[10px] text-slate-400">{acc.accountId?.slice(0, 8) ?? "N/A"}…</td>
                      <td className="px-4 py-2 text-right tabular-nums">{acc.ordersImported}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{acc.ordersUpdated}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{acc.delivered}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-red-400">{acc.refused}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-orange-400">{acc.noAnswer}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-yellow-400">{acc.returned}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[#D6A74C]">{acc.identitiesCreated}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-red-400">{acc.failedRecords}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{acc.durationSeconds}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Past reports ── */}
      <div className="rounded-2xl bg-white/5 p-6 ring-1 ring-white/10">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-[#D6A74C]">
          Sync History
        </h2>

        {pastReports.length === 0 ? (
          <p className="text-sm text-slate-400">No syncs recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl ring-1 ring-white/10">
            <table className="w-full text-xs text-slate-300">
              <thead>
                <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-widest text-slate-500">
                  <th className="px-4 py-2">Provider</th>
                  <th className="px-4 py-2">Completed</th>
                  <th className="px-4 py-2 text-right">Imported</th>
                  <th className="px-4 py-2 text-right">Updated</th>
                  <th className="px-4 py-2 text-right">Delivered</th>
                  <th className="px-4 py-2 text-right">Refused</th>
                  <th className="px-4 py-2 text-right">Identities+</th>
                  <th className="px-4 py-2 text-right">Failed</th>
                  <th className="px-4 py-2 text-right">Duration</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {pastReports.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 hover:bg-white/3">
                    <td className="px-4 py-2"><ProviderBadge provider={r.provider} /></td>
                    <td className="px-4 py-2 text-slate-400">
                      {new Date(r.completed_at).toLocaleString("fr-DZ")}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.orders_imported}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.orders_updated}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{r.delivered_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-red-400">{r.refused_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-[#D6A74C]">{r.identities_created}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-red-400">{r.failed_records}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.duration_seconds ?? "—"}s</td>
                    <td className="px-4 py-2">
                      <StatusBadge ok={!r.error_message} dryRun={r.dry_run} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
