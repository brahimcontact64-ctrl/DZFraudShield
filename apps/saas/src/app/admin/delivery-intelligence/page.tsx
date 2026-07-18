import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
} from "@/components/admin/admin-ui";
import { fetchProviderHealthSummary } from "@/lib/admin/provider-health";
import type { ProviderOverallHealth } from "@/lib/admin/provider-health";
import { DeliveryMonitor } from "./monitor";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "overview" | "shipments" | "events" | "webhooks";

type SyncStatusRow = {
  merchant_id: string;
  provider: string;
  full_parcels_status: string | null;
  full_parcels_completed_at: string | null;
  full_parcels_total: number | null;
  full_histories_status: string | null;
  full_histories_completed_at: string | null;
  full_histories_total: number | null;
  last_parcels_synced_at: string | null;
  last_histories_synced_at: string | null;
  last_heartbeat_at: string | null;
  last_error: string | null;
};

type MerchantRow = { id: string; name: string };

type AccountRow = {
  id: string;
  merchant_id: string;
  provider: string;
  provider_name: string | null;
  account_label: string | null;
  active: boolean;
  connection_status: string | null;
  failure_streak: number | null;
  last_sync_at: string | null;
  last_error_message: string | null;
};

type ShipmentRow = {
  id: string;
  merchant_id: string;
  provider: string;
  tracking: string;
  phone_source: string | null;
  wilaya_name: string | null;
  commune_name: string | null;
  last_status: string | null;
  normalized_outcome: string | null;
  cod_amount: number | null;
  date_creation: string | null;
  date_last_status: string | null;
  first_seen_at: string;
  last_synced_at: string;
};

type EventRow = {
  id: string;
  tracking: string;
  merchant_id: string;
  provider: string;
  status: string | null;
  reason: string | null;
  date_status: string | null;
  source: string | null;
  synced_at: string | null;
};

type WebhookEventRow = {
  id: string;
  merchant_id: string | null;
  provider: string | null;
  event_type: string | null;
  tracking: string | null;
  processed: boolean | null;
  skip_reason: string | null;
  error: string | null;
  received_at: string;
};

// ── Badge helpers ─────────────────────────────────────────────────────────────

function syncTone(status: string | null): "emerald" | "sky" | "rose" | "amber" | "neutral" {
  if (status === "completed") return "emerald";
  if (status === "running")   return "sky";
  if (status === "failed")    return "rose";
  if (status === "pending")   return "amber";
  return "neutral";
}

function outcomeTone(outcome: string | null): "emerald" | "rose" | "amber" | "neutral" {
  if (outcome === "DELIVERED") return "emerald";
  if (outcome === "REFUSED" || outcome === "RETURNED") return "rose";
  if (outcome === "NO_ANSWER" || outcome === "PENDING") return "amber";
  return "neutral";
}

function sourceTone(src: string | null): "emerald" | "sky" | "violet" | "neutral" {
  if (src === "woocommerce")    return "emerald";
  if (src === "yalidine_real")  return "sky";
  if (src === "yalidine_masked") return "violet";
  return "neutral";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function DeliveryIntelligencePage({
  searchParams,
}: {
  searchParams?: {
    tab?: string;
    page?: string;
    merchant?: string;
  };
}) {
  const supabase = createClient();
  const tab = (searchParams?.tab ?? "overview") as Tab;
  const page = Math.max(1, parseInt(searchParams?.page ?? "1", 10));
  const PAGE_SIZE = 30;
  const offset = (page - 1) * PAGE_SIZE;

  // ── Data fetching (tab-aware to avoid redundant queries) ──────────────────

  // Always needed: overview counts, sync status, merchants list
  const [
    { count: shipmentCount },
    { count: eventCount },
    { count: reputationCount },
    { count: pendingJobCount },
    { count: failedJobCount },
    { data: syncRows },
    { data: merchantRows },
    { data: accountRows },
    { data: lastWebhookRows },
    { data: lastFullSyncRows },
    { data: lastIncrementalRows },
  ] = await Promise.all([
    supabase.from("merchant_shipment_history").select("id", { count: "exact", head: true }),
    supabase.from("shipment_status_events").select("id", { count: "exact", head: true }),
    supabase.from("customer_reputation").select("identity_id", { count: "exact", head: true }),
    supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "failed")
      .gte("updated_at", new Date(Date.now() - 86_400_000).toISOString()),
    supabase
      .from("merchant_history_sync_status")
      .select(
        "merchant_id, provider," +
        "full_parcels_status, full_parcels_completed_at, full_parcels_total," +
        "full_histories_status, full_histories_completed_at, full_histories_total," +
        "last_parcels_synced_at, last_histories_synced_at," +
        "last_heartbeat_at, last_error"
      )
      .order("last_heartbeat_at", { ascending: false }),
    supabase.from("merchants").select("id, name"),
    supabase
      .from("merchant_delivery_accounts")
      .select("id, merchant_id, provider, provider_name, account_label, active, connection_status, failure_streak, last_sync_at, last_error_message")
      .order("active", { ascending: false }),
    supabase.from("webhook_event_log").select("received_at").order("received_at", { ascending: false }).limit(1),
    supabase.from("merchant_history_sync_status").select("full_parcels_completed_at").not("full_parcels_completed_at", "is", null).order("full_parcels_completed_at", { ascending: false }).limit(1),
    supabase.from("merchant_history_sync_status").select("last_parcels_synced_at").not("last_parcels_synced_at", "is", null).order("last_parcels_synced_at", { ascending: false }).limit(1),
  ]);

  const syncStatuses = (syncRows ?? []) as unknown as SyncStatusRow[];
  const merchants    = (merchantRows ?? []) as unknown as MerchantRow[];
  const accounts     = (accountRows ?? []) as unknown as AccountRow[];
  const merchantById = new Map(merchants.map((m) => [m.id, m.name]));

  const healthSummary = await fetchProviderHealthSummary();

  const lastWebhookAt      = (lastWebhookRows ?? [])[0]?.received_at ?? null;
  const lastFullSyncAt     = (lastFullSyncRows ?? [])[0]?.full_parcels_completed_at ?? null;
  const lastIncrementalAt  = (lastIncrementalRows ?? [])[0]?.last_parcels_synced_at ?? null;

  // Tab-specific data
  let shipments: ShipmentRow[] = [];
  let events: EventRow[] = [];
  let webhooks: WebhookEventRow[] = [];
  let shipmentTotal = 0;
  let eventTotal = 0;
  let webhookTotal = 0;

  if (tab === "shipments") {
    const { data: sData, count: sCount } = await supabase
      .from("merchant_shipment_history")
      .select(
        "id, merchant_id, provider, tracking, phone_source, wilaya_name, commune_name," +
        "last_status, normalized_outcome, cod_amount, date_creation, date_last_status," +
        "first_seen_at, last_synced_at",
        { count: "exact" }
      )
      .order("last_synced_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    shipments = (sData ?? []) as unknown as ShipmentRow[];
    shipmentTotal = sCount ?? 0;
  }

  if (tab === "events") {
    const { data: eData, count: eCount } = await supabase
      .from("shipment_status_events")
      .select(
        "id, tracking, merchant_id, provider, status, reason, date_status, source, synced_at",
        { count: "exact" }
      )
      .order("synced_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    events = (eData ?? []) as EventRow[];
    eventTotal = eCount ?? 0;
  }

  if (tab === "webhooks") {
    const { data: wData, count: wCount } = await supabase
      .from("webhook_event_log")
      .select(
        "id, merchant_id, provider, event_type, tracking, processed, skip_reason, error, received_at",
        { count: "exact" }
      )
      .order("received_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    webhooks = (wData ?? []) as WebhookEventRow[];
    webhookTotal = wCount ?? 0;
  }

  const totalPages = Math.max(
    1,
    Math.ceil(
      tab === "shipments" ? shipmentTotal / PAGE_SIZE
      : tab === "events"  ? eventTotal   / PAGE_SIZE
      : tab === "webhooks" ? webhookTotal / PAGE_SIZE
      : 1
    )
  );

  // ── Helpers ───────────────────────────────────────────────────────────────

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview",  label: "Overview" },
    { key: "shipments", label: `Shipments (${(shipmentCount ?? 0).toLocaleString()})` },
    { key: "events",    label: `Status Events (${(eventCount ?? 0).toLocaleString()})` },
    { key: "webhooks",  label: "Webhooks" },
  ];

  function tabHref(t: Tab) {
    return `/admin/delivery-intelligence?tab=${t}`;
  }

  function pageHref(p: number) {
    return `/admin/delivery-intelligence?tab=${tab}&page=${p}`;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="space-y-2">
        <AdminBadge tone="violet">MDI Pipeline</AdminBadge>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Delivery Intelligence</h1>
        <p className="max-w-3xl text-sm text-slate-300">
          Visibility into the Merchant Delivery Intelligence pipeline — Yalidine shipment history import,
          identity resolution, reputation profiles, and sync health per merchant.
        </p>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 rounded-xl border border-slate-700/40 bg-slate-800/30 p-1">
        {tabs.map(({ key, label }) => (
          <Link
            key={key}
            href={tabHref(key)}
            className={
              tab === key
                ? "rounded-lg bg-slate-700/60 px-4 py-2 text-sm font-semibold text-white"
                : "rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-700/30 hover:text-slate-200"
            }
          >
            {label}
          </Link>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: OVERVIEW
      ════════════════════════════════════════════════════════════════════════ */}
      {tab === "overview" && (
        <div className="space-y-6">

          {/* Metric cards */}
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            <AdminMetricCard
              label="Shipments imported"
              value={(shipmentCount ?? 0).toLocaleString()}
              delta="Rows in merchant_shipment_history"
              tone="gold"
            />
            <AdminMetricCard
              label="Status events"
              value={(eventCount ?? 0).toLocaleString()}
              delta="Rows in shipment_status_events"
              tone="sky"
            />
            <AdminMetricCard
              label="Reputation profiles"
              value={(reputationCount ?? 0).toLocaleString()}
              delta="Rows in customer_reputation"
              tone="violet"
            />
            <AdminMetricCard
              label="Pending jobs"
              value={pendingJobCount ?? 0}
              delta="Background jobs waiting"
              tone={pendingJobCount && pendingJobCount > 50 ? "amber" : "emerald"}
            />
            <AdminMetricCard
              label="Failed jobs (24 h)"
              value={failedJobCount ?? 0}
              delta="Background jobs failed in last 24 h"
              tone={failedJobCount && failedJobCount > 0 ? "rose" : "emerald"}
            />
            <AdminMetricCard
              label="Last full sync"
              value={lastFullSyncAt ? fmtDateShort(lastFullSyncAt) : "Never"}
              delta="Most recent full parcels sync completion"
              tone={lastFullSyncAt ? "emerald" : "amber"}
            />
            <AdminMetricCard
              label="Last incremental sync"
              value={lastIncrementalAt ? fmtDateShort(lastIncrementalAt) : "Never"}
              delta="Most recent incremental sync completion"
              tone={lastIncrementalAt ? "emerald" : "amber"}
            />
            <AdminMetricCard
              label="Last webhook received"
              value={lastWebhookAt ? fmtDateShort(lastWebhookAt) : "Never"}
              delta="Most recent webhook event logged"
              tone={lastWebhookAt ? "sky" : "amber"}
            />
            <AdminMetricCard
              label="Merchants synced"
              value={syncStatuses.length}
              delta="Merchants with a sync status row"
              tone="sky"
            />
          </section>

          {/* Live Sync Monitor */}
          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              eyebrow="Real-time"
              title="Live sync monitor"
              description="Active syncs polling every 10 s. Status updates without page reload."
            />
            <DeliveryMonitor />
          </AdminPanel>

          {/* Provider Health */}
          {healthSummary.providers.length > 0 ? (
            <AdminPanel className="space-y-4">
              <AdminSectionHeader
                eyebrow="Provider connectivity"
                title="Provider health"
                description="Per-provider account status, job queue depth, and sync health."
              />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {healthSummary.providers.map((p) => (
                  <ProviderHealthCard key={p.provider} provider={p} />
                ))}
              </div>
            </AdminPanel>
          ) : null}

          {/* Per-merchant sync table */}
          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              eyebrow="Sync status"
              title="Per-merchant sync state"
              description="Full parcel + history sync status, incremental sync timestamps, and last heartbeat for every merchant in the MDI pipeline."
            />

            {syncStatuses.length === 0 ? (
              <EmptyState
                title="History sync not initialized"
                description="No merchant has started a history sync yet. Trigger a full history sync for a merchant to begin."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-700/40">
                <table className="min-w-[1200px] w-full text-sm">
                  <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                    <tr>
                      <th className="px-3 py-3">Merchant</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3">Parcels sync</th>
                      <th className="px-3 py-3">Parcels total</th>
                      <th className="px-3 py-3">Histories sync</th>
                      <th className="px-3 py-3">Histories total</th>
                      <th className="px-3 py-3">Last parcels sync</th>
                      <th className="px-3 py-3">Last histories sync</th>
                      <th className="px-3 py-3">Last heartbeat</th>
                      <th className="px-3 py-3">Last error</th>
                      <th className="px-3 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncStatuses.map((row) => (
                      <tr
                        key={`${row.merchant_id}-${row.provider}`}
                        className="border-t border-slate-700/30 hover:bg-slate-800/20"
                      >
                        <td className="px-3 py-3">
                          <p className="font-medium text-slate-100">
                            {merchantById.get(row.merchant_id) ?? "Unknown merchant"}
                          </p>
                          <p className="font-mono text-[10px] text-slate-500">
                            {row.merchant_id?.slice(0, 8) ?? ""}…
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone="sky">{row.provider}</AdminBadge>
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone={syncTone(row.full_parcels_status)}>
                            {row.full_parcels_status ?? "—"}
                          </AdminBadge>
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {row.full_parcels_total != null ? row.full_parcels_total.toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone={syncTone(row.full_histories_status)}>
                            {row.full_histories_status ?? "—"}
                          </AdminBadge>
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {row.full_histories_total != null ? row.full_histories_total.toLocaleString() : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.last_parcels_synced_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.last_histories_synced_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.last_heartbeat_at)}
                        </td>
                        <td className="max-w-[180px] px-3 py-3">
                          {row.last_error ? (
                            <span
                              className="block truncate text-xs text-rose-300"
                              title={row.last_error}
                            >
                              {row.last_error.slice(0, 80)}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <SyncActions merchantId={row.merchant_id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AdminPanel>

          {/* Merchants without any sync row */}
          {(() => {
            const syncedIds = new Set(syncStatuses.map((r) => r.merchant_id));
            const unsynced  = merchants.filter((m) => !syncedIds.has(m.id));
            if (unsynced.length === 0) return null;
            return (
              <AdminPanel className="space-y-4">
                <AdminSectionHeader
                  eyebrow="Not initialized"
                  title="Merchants with no sync history"
                  description="These merchants have delivery accounts but have never started an MDI history sync."
                  action={<AdminBadge tone="amber">{unsynced.length} uninitialized</AdminBadge>}
                />
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {unsynced.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-200">{m.name}</p>
                        <p className="font-mono text-[10px] text-slate-500">{m.id?.slice(0, 8) ?? ""}…</p>
                      </div>
                      <SyncActions merchantId={m.id} compact />
                    </div>
                  ))}
                </div>
              </AdminPanel>
            );
          })()}

          {/* Provider accounts */}
          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              eyebrow="Provider connectivity"
              title="Connected delivery accounts"
              description="All merchant delivery accounts. Active accounts feed the MDI pipeline."
            />
            {accounts.length === 0 ? (
              <EmptyState
                title="No delivery accounts found"
                description="Merchants must connect a Yalidine account before history can be imported."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-700/40">
                <table className="min-w-[900px] w-full text-sm">
                  <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                    <tr>
                      <th className="px-3 py-3">Merchant</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3">Label</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Active</th>
                      <th className="px-3 py-3">Failure streak</th>
                      <th className="px-3 py-3">Last sync</th>
                      <th className="px-3 py-3">Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((acc) => (
                      <tr key={acc.id} className="border-t border-slate-700/30 hover:bg-slate-800/20">
                        <td className="px-3 py-3">
                          <p className="text-sm text-slate-200">
                            {merchantById.get(acc.merchant_id) ?? "Unknown"}
                          </p>
                          <p className="font-mono text-[10px] text-slate-500">
                            {acc.merchant_id?.slice(0, 8) ?? ""}…
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone="sky">{acc.provider_name ?? acc.provider}</AdminBadge>
                        </td>
                        <td className="px-3 py-3 text-slate-300">{acc.account_label ?? "—"}</td>
                        <td className="px-3 py-3">
                          <AdminBadge tone={acc.connection_status === "connected" ? "emerald" : "amber"}>
                            {acc.connection_status ?? "unknown"}
                          </AdminBadge>
                        </td>
                        <td className="px-3 py-3">
                          {acc.active
                            ? <AdminBadge tone="emerald">active</AdminBadge>
                            : <AdminBadge tone="neutral">inactive</AdminBadge>}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {acc.failure_streak ?? 0}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(acc.last_sync_at)}
                        </td>
                        <td className="max-w-[160px] px-3 py-3">
                          {acc.last_error_message ? (
                            <span
                              className="block truncate text-xs text-rose-300"
                              title={acc.last_error_message}
                            >
                              {acc.last_error_message.slice(0, 60)}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AdminPanel>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: SHIPMENTS
      ════════════════════════════════════════════════════════════════════════ */}
      {tab === "shipments" && (
        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Imported history"
            title="Shipment history"
            description={`${(shipmentCount ?? 0).toLocaleString()} total rows in merchant_shipment_history. Showing ${PAGE_SIZE} per page.`}
          />

          {shipments.length === 0 ? (
            <EmptyState
              title="No Yalidine shipment history imported yet"
              description="Run a full history sync for a merchant to begin importing shipment data. Go to the Overview tab and trigger a sync."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-slate-700/40">
                <table className="min-w-[1400px] w-full text-sm">
                  <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                    <tr>
                      <th className="px-3 py-3">Tracking</th>
                      <th className="px-3 py-3">Merchant</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3">Phone source</th>
                      <th className="px-3 py-3">Wilaya</th>
                      <th className="px-3 py-3">Commune</th>
                      <th className="px-3 py-3">Last status</th>
                      <th className="px-3 py-3">Outcome</th>
                      <th className="px-3 py-3">COD (DZD)</th>
                      <th className="px-3 py-3">Date creation</th>
                      <th className="px-3 py-3">Date last status</th>
                      <th className="px-3 py-3">First seen</th>
                      <th className="px-3 py-3">Last synced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipments.map((row) => (
                      <tr key={row.id} className="border-t border-slate-700/30 hover:bg-slate-800/20">
                        <td className="px-3 py-3 font-mono text-xs text-[#D6A74C]">
                          {row.tracking}
                        </td>
                        <td className="px-3 py-3">
                          <span className="text-xs text-slate-300">
                            {merchantById.get(row.merchant_id) ?? row.merchant_id?.slice(0, 8) ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone="sky">{row.provider}</AdminBadge>
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone={sourceTone(row.phone_source)}>
                            {row.phone_source ?? "unknown"}
                          </AdminBadge>
                        </td>
                        <td className="px-3 py-3 text-slate-300">{row.wilaya_name ?? "—"}</td>
                        <td className="px-3 py-3 text-slate-300">{row.commune_name ?? "—"}</td>
                        <td className="px-3 py-3 text-xs text-slate-300">{row.last_status ?? "—"}</td>
                        <td className="px-3 py-3">
                          {row.normalized_outcome ? (
                            <AdminBadge tone={outcomeTone(row.normalized_outcome)}>
                              {row.normalized_outcome}
                            </AdminBadge>
                          ) : (
                            <span className="text-xs text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-slate-300">
                          {row.cod_amount != null ? row.cod_amount.toLocaleString() : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDateShort(row.date_creation)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDateShort(row.date_last_status)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.first_seen_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.last_synced_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} totalPages={totalPages} hrefFn={pageHref} total={shipmentTotal} />
            </>
          )}
        </AdminPanel>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: STATUS EVENTS
      ════════════════════════════════════════════════════════════════════════ */}
      {tab === "events" && (
        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Status history"
            title="Shipment status events"
            description={`${(eventCount ?? 0).toLocaleString()} total status events. Most recent first.`}
          />

          {events.length === 0 ? (
            <EmptyState
              title="No status events imported yet"
              description="Status events are populated during Phase B of the full history sync (histories phase). Run a full sync to populate this table."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-slate-700/40">
                <table className="min-w-[900px] w-full text-sm">
                  <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                    <tr>
                      <th className="px-3 py-3">Tracking</th>
                      <th className="px-3 py-3">Merchant</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Reason</th>
                      <th className="px-3 py-3">Date status</th>
                      <th className="px-3 py-3">Source</th>
                      <th className="px-3 py-3">Synced at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((row) => (
                      <tr key={row.id} className="border-t border-slate-700/30 hover:bg-slate-800/20">
                        <td className="px-3 py-3 font-mono text-xs text-[#D6A74C]">{row.tracking}</td>
                        <td className="px-3 py-3 text-xs text-slate-300">
                          {merchantById.get(row.merchant_id) ?? row.merchant_id?.slice(0, 8) ?? "—"}
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone="sky">{row.provider}</AdminBadge>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-200">{row.status ?? "—"}</td>
                        <td className="max-w-[160px] px-3 py-3">
                          <span className="block truncate text-xs text-slate-400" title={row.reason ?? ""}>
                            {row.reason ?? "—"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.date_status)}
                        </td>
                        <td className="px-3 py-3">
                          <AdminBadge tone="neutral">{row.source ?? "—"}</AdminBadge>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.synced_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} totalPages={totalPages} hrefFn={pageHref} total={eventTotal} />
            </>
          )}
        </AdminPanel>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB: WEBHOOKS
      ════════════════════════════════════════════════════════════════════════ */}
      {tab === "webhooks" && (
        <AdminPanel className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <AdminSectionHeader
              eyebrow="Webhook intake"
              title="Webhook event log"
              description="Delivery provider webhook events. Shows processed, skipped, and failed events."
            />
            <Link
              href="/admin/webhooks"
              className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-700/40"
            >
              Full webhook page →
            </Link>
          </div>

          {webhooks.length === 0 ? (
            <EmptyState
              title="No webhook events received yet"
              description="Webhook events are logged when Yalidine sends delivery status updates to this platform."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-slate-700/40">
                <table className="min-w-[900px] w-full text-sm">
                  <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                    <tr>
                      <th className="px-3 py-3">Received</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3">Event type</th>
                      <th className="px-3 py-3">Tracking</th>
                      <th className="px-3 py-3">Merchant</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Skip / error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {webhooks.map((row) => (
                      <tr key={row.id} className="border-t border-slate-700/30 hover:bg-slate-800/20">
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-400">
                          {fmtDate(row.received_at)}
                        </td>
                        <td className="px-3 py-3">
                          {row.provider
                            ? <AdminBadge tone="sky">{row.provider}</AdminBadge>
                            : <span className="text-slate-500">—</span>}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-200">{row.event_type ?? "—"}</td>
                        <td className="px-3 py-3 font-mono text-xs text-[#D6A74C]">{row.tracking ?? "—"}</td>
                        <td className="px-3 py-3 text-xs text-slate-300">
                          {row.merchant_id
                            ? (merchantById.get(row.merchant_id) ?? `${row.merchant_id.slice(0, 8)}…`)
                            : "—"}
                        </td>
                        <td className="px-3 py-3">
                          {row.error
                            ? <AdminBadge tone="rose">failed</AdminBadge>
                            : row.skip_reason
                              ? <AdminBadge tone="amber">skipped</AdminBadge>
                              : row.processed
                                ? <AdminBadge tone="emerald">processed</AdminBadge>
                                : <AdminBadge tone="neutral">pending</AdminBadge>}
                        </td>
                        <td className="max-w-[180px] px-3 py-3">
                          <span
                            className="block truncate text-xs text-slate-400"
                            title={row.skip_reason ?? row.error ?? ""}
                          >
                            {row.skip_reason ?? row.error ?? "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} totalPages={totalPages} hrefFn={pageHref} total={webhookTotal} />
            </>
          )}
        </AdminPanel>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 px-6 py-12 text-center">
      <p className="text-base font-semibold text-slate-300">{title}</p>
      <p className="mt-2 text-sm text-slate-500">{description}</p>
    </div>
  );
}

function SyncActions({
  merchantId,
  compact = false,
}: {
  merchantId: string;
  compact?: boolean;
}) {
  const btnBase = compact
    ? "rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition"
    : "rounded-lg border px-3 py-1.5 text-xs font-semibold transition";

  return (
    <div className="flex flex-wrap gap-1.5">
      <form
        method="POST"
        action="/api/v1/admin/delivery-intelligence/sync/full"
        onSubmit={undefined}
      >
        <input type="hidden" name="merchantId" value={merchantId} />
        <button
          type="submit"
          className={`${btnBase} border-sky-400/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20`}
        >
          Full sync
        </button>
      </form>
      <form
        method="POST"
        action="/api/v1/admin/delivery-intelligence/sync/incremental"
      >
        <input type="hidden" name="merchantId" value={merchantId} />
        <button
          type="submit"
          className={`${btnBase} border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20`}
        >
          Incremental
        </button>
      </form>
    </div>
  );
}

function ProviderHealthCard({
  provider: p,
}: {
  provider: {
    provider:      string;
    accounts:      { total: number; active: number; connected: number; failing: number };
    jobs:          { pending: number; processing: number; failedLast24h: number };
    sync:          { merchantsSynced: number; runningSyncs: number; lastHeartbeatAt: string | null; lastError: string | null };
    overallHealth: ProviderOverallHealth;
  };
}) {
  const healthTone: Record<ProviderOverallHealth, { bg: string; dot: string; label: string }> = {
    healthy:  { bg: "border-emerald-500/20 bg-emerald-500/5",  dot: "bg-emerald-400", label: "Healthy"  },
    degraded: { bg: "border-amber-500/20  bg-amber-500/5",   dot: "bg-amber-400",   label: "Degraded" },
    down:     { bg: "border-rose-500/20   bg-rose-500/5",    dot: "bg-rose-400",    label: "Down"     },
    unknown:  { bg: "border-slate-700/40  bg-slate-800/20",  dot: "bg-slate-500",   label: "Unknown"  },
  };
  const tone = healthTone[p.overallHealth];

  return (
    <div className={`rounded-xl border px-4 py-3 space-y-3 ${tone.bg}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-100 capitalize">{p.provider}</span>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-300">
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {tone.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-base font-semibold text-slate-100">{p.accounts.active}</p>
          <p className="text-[10px] text-slate-500">Active accts</p>
        </div>
        <div>
          <p className="text-base font-semibold text-slate-100">{p.sync.merchantsSynced}</p>
          <p className="text-[10px] text-slate-500">Merchants synced</p>
        </div>
        <div>
          <p className={`text-base font-semibold ${p.jobs.failedLast24h > 0 ? "text-rose-300" : "text-slate-100"}`}>
            {p.jobs.failedLast24h}
          </p>
          <p className="text-[10px] text-slate-500">Failed 24 h</p>
        </div>
      </div>
      {p.sync.runningSyncs > 0 ? (
        <p className="text-[11px] text-sky-300">
          {p.sync.runningSyncs} sync{p.sync.runningSyncs === 1 ? "" : "s"} running
        </p>
      ) : null}
      {p.accounts.failing > 0 ? (
        <p className="text-[11px] text-amber-300">
          {p.accounts.failing} account{p.accounts.failing === 1 ? "" : "s"} with high failure streak
        </p>
      ) : null}
      {p.jobs.pending + p.jobs.processing > 0 ? (
        <p className="text-[11px] text-slate-400">
          {p.jobs.pending + p.jobs.processing} job{p.jobs.pending + p.jobs.processing === 1 ? "" : "s"} queued
        </p>
      ) : null}
      {p.sync.lastError ? (
        <p
          className="truncate text-[11px] text-rose-300"
          title={p.sync.lastError}
        >
          {p.sync.lastError.slice(0, 70)}
        </p>
      ) : null}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  hrefFn,
  total,
}: {
  page: number;
  totalPages: number;
  hrefFn: (p: number) => string;
  total: number;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-4 pt-1">
      <p className="text-xs text-slate-400">
        Page {page} of {totalPages} ({total.toLocaleString()} total)
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={hrefFn(page - 1)}
            className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/40"
          >
            ← Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={hrefFn(page + 1)}
            className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/40"
          >
            Next →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
