/**
 * /admin/merchant-intelligence
 *
 * Merchant Intelligence — enterprise business decision engine.
 * All data derived from real platform tables. No fabricated values.
 *
 * Tabs:
 *   overview   — platform-wide KPIs + merchant rankings
 *   merchants  — per-merchant searchable deep-dive
 *   categories — category analytics + ad recommendations
 *   wilayas    — wilaya performance + provider ranking per wilaya
 *   delivery   — delivery provider comparison
 *   insights   — auto-generated business insights + threshold alerts
 */

import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
  FlowList,
  Sparkline,
} from "@/components/admin/admin-ui";
import { getMerchantIntelligenceData } from "@/lib/merchant-intelligence/merchant-overview";
import { getCategoryIntelligence } from "@/lib/merchant-intelligence/category-intelligence";
import { getWilayaIntelligence } from "@/lib/merchant-intelligence/wilaya-intelligence";
import { getProviderIntelligence } from "@/lib/merchant-intelligence/provider-intelligence";
import { generateInsightsAndAlerts } from "@/lib/merchant-intelligence/insight-engine";

export const dynamic = "force-dynamic";

// ── Tab type ──────────────────────────────────────────────────────────────────

type Tab = "overview" | "merchants" | "categories" | "wilayas" | "delivery" | "insights";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview",    label: "Overview" },
  { key: "merchants",   label: "Merchants" },
  { key: "categories",  label: "Categories" },
  { key: "wilayas",     label: "Wilayas" },
  { key: "delivery",    label: "Delivery" },
  { key: "insights",    label: "Insights" },
];

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPct(rate: number): string {
  return (rate * 100).toFixed(1) + "%";
}

function fmtCurrency(n: number): string {
  if (n === 0) return "0 DA";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M DA";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K DA";
  return n.toFixed(0) + " DA";
}

function fmtNumber(n: number): string {
  return n.toLocaleString("fr-DZ");
}

function fmtGrowth(rate: number): string {
  if (rate === 0) return "±0%";
  const sign = rate > 0 ? "+" : "";
  return sign + (rate * 100).toFixed(1) + "%";
}

function fmtDays(d: number | null): string {
  if (d == null) return "—";
  return d.toFixed(1) + " d";
}

// ── Status badge ─────────────────────────────────────────────────────────────

function statusTone(
  status: string,
): "emerald" | "amber" | "rose" | "sky" | "neutral" {
  if (status === "active") return "emerald";
  if (status === "trial") return "sky";
  if (status === "suspended" || status === "expired") return "amber";
  if (status === "disabled") return "rose";
  return "neutral";
}

// ── Score colour ──────────────────────────────────────────────────────────────

function scoreTone(score: number): string {
  if (score >= 75) return "text-emerald-300";
  if (score >= 50) return "text-amber-300";
  return "text-rose-300";
}

// ── Ad recommendation badge ───────────────────────────────────────────────────

function adTone(
  rec: string,
): "emerald" | "sky" | "amber" | "rose" {
  if (rec === "increase") return "emerald";
  if (rec === "maintain") return "sky";
  if (rec === "reduce") return "amber";
  return "rose";
}

function adLabel(rec: string): string {
  if (rec === "increase") return "↑ Increase Ads";
  if (rec === "maintain") return "→ Maintain";
  if (rec === "reduce") return "↓ Reduce Ads";
  return "⏸ Pause Ads";
}

// ── Severity badge ────────────────────────────────────────────────────────────

function severityTone(
  s: string,
): "rose" | "amber" | "sky" {
  if (s === "critical") return "rose";
  if (s === "warning") return "amber";
  return "sky";
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminMerchantIntelligencePage({
  searchParams,
}: {
  searchParams?: { tab?: string; q?: string };
}) {
  const supabase = createClient();
  const tab = ((await searchParams)?.tab ?? "overview") as Tab;
  const q = ((await searchParams)?.q ?? "").toLowerCase().trim();

  // ── Load data per active tab ──────────────────────────────────────────────

  const { summaries, platform } = await getMerchantIntelligenceData(supabase);

  const categories = tab === "categories" || tab === "insights"
    ? await getCategoryIntelligence(supabase)
    : [];

  const wilayas = tab === "wilayas" || tab === "insights"
    ? await getWilayaIntelligence(supabase)
    : [];

  const providers = tab === "delivery" || tab === "insights"
    ? await getProviderIntelligence(supabase)
    : [];

  const { insights, alerts } =
    tab === "insights"
      ? generateInsightsAndAlerts({ summaries, categories, providers, wilayas })
      : { insights: [], alerts: [] };

  // ── Merchant search filter ────────────────────────────────────────────────

  const filteredMerchants = q
    ? summaries.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.merchantId.toLowerCase().includes(q),
      )
    : summaries;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="rounded-2xl border border-slate-700/40 bg-slate-800/20 p-5">
        <div className="space-y-2">
          <AdminBadge tone="violet">Merchant Intelligence</AdminBadge>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Business Intelligence
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-400">
            Real-time decision engine built on platform data. Every metric derived from live orders, shipments, and customer behaviour.
          </p>
        </div>
      </div>

      {/* ── Platform KPIs (always visible) ── */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
        <AdminMetricCard
          label="Total Merchants"
          value={fmtNumber(platform.totalMerchants)}
          delta={`${platform.activeMerchants} active`}
          tone="sky"
        />
        <AdminMetricCard
          label="Total Shipments"
          value={fmtNumber(platform.totalShipments)}
          delta={`${fmtPct(platform.platformDeliverySuccessRate)} success rate`}
          tone="gold"
        />
        <AdminMetricCard
          label="Gross COD Revenue"
          value={fmtCurrency(platform.platformGrossRevenueDzd)}
          delta="Sum of all COD amounts"
          tone="emerald"
        />
        <AdminMetricCard
          label="Collected Revenue"
          value={fmtCurrency(platform.platformCollectedRevenueDzd)}
          delta="Paid COD only"
          tone="emerald"
        />
        <AdminMetricCard
          label="Order Checks"
          value={fmtNumber(platform.totalOrderChecks)}
          delta={`${fmtPct(platform.platformBlockRate)} block rate`}
          tone="amber"
        />
        <AdminMetricCard
          label="Fraud Blocks"
          value={fmtNumber(platform.totalBlockedOrders)}
          delta="BLOCK or CRITICAL risk level"
          tone="rose"
        />
      </section>

      {/* ── Tab bar ── */}
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-700/40 pb-0">
        {TABS.map(({ key, label }) => (
          <a
            key={key}
            href={`?tab=${key}`}
            className={[
              "shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              tab === key
                ? "border-[#D6A74C] text-[#F7DEAB]"
                : "border-transparent text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            {label}
          </a>
        ))}
      </nav>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* TAB: OVERVIEW                                                   */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {tab === "overview" && (
        <div className="space-y-6">

          {/* Top providers platform-wide */}
          {platform.topProviders.length > 0 && (
            <AdminPanel className="space-y-4">
              <AdminSectionHeader
                eyebrow="Platform"
                title="Delivery provider rankings"
                description="All merchants combined, by shipment volume."
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/40 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      <th className="pb-3 pr-6">Provider</th>
                      <th className="pb-3 pr-6">Shipments</th>
                      <th className="pb-3 pr-6">Success Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/20">
                    {platform.topProviders.map((p) => (
                      <tr key={p.provider}>
                        <td className="py-2.5 pr-6 font-medium text-slate-200 capitalize">{p.provider}</td>
                        <td className="py-2.5 pr-6 text-slate-300">{fmtNumber(p.orders)}</td>
                        <td className="py-2.5 pr-6">
                          <span className={p.successRate >= 0.65 ? "text-emerald-300" : p.successRate >= 0.5 ? "text-amber-300" : "text-rose-300"}>
                            {fmtPct(p.successRate)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminPanel>
          )}

          {/* Top wilayas platform-wide */}
          <div className="grid gap-4 xl:grid-cols-2">
            {platform.topWilayas.length > 0 && (
              <AdminPanel className="space-y-4">
                <AdminSectionHeader
                  eyebrow="Platform"
                  title="Top wilayas by shipment volume"
                />
                <FlowList
                  emptyLabel="No wilaya data yet."
                  items={platform.topWilayas.map((w) => ({
                    title: w.wilaya,
                    subtitle: `${fmtNumber(w.orders)} shipments`,
                    meta: fmtPct(w.successRate),
                    tone: w.successRate >= 0.65 ? "emerald" : w.successRate >= 0.5 ? "amber" : "rose",
                  }))}
                />
              </AdminPanel>
            )}

            {/* Merchant growth leaders */}
            <AdminPanel className="space-y-4">
              <AdminSectionHeader
                eyebrow="Platform"
                title="Fastest-growing merchants (MoM orders)"
              />
              <FlowList
                emptyLabel="No growth data yet."
                items={[...summaries]
                  .filter((m) => m.orderGrowthRate > 0 && m.totalOrders >= 5)
                  .sort((a, b) => b.orderGrowthRate - a.orderGrowthRate)
                  .slice(0, 8)
                  .map((m) => ({
                    title: m.name,
                    subtitle: `${fmtNumber(m.totalOrders)} total orders`,
                    meta: fmtGrowth(m.orderGrowthRate),
                    tone: "emerald" as const,
                  }))}
              />
            </AdminPanel>
          </div>

          {/* Merchant revenue ranking */}
          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              eyebrow="Platform"
              title="Merchant revenue ranking"
              description="Gross COD amount across all shipments, most recent sample."
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/40 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <th className="pb-3 pr-6">Merchant</th>
                    <th className="pb-3 pr-6">Status</th>
                    <th className="pb-3 pr-6">Orders</th>
                    <th className="pb-3 pr-6">Shipments</th>
                    <th className="pb-3 pr-6">Gross Revenue</th>
                    <th className="pb-3 pr-6">Delivery Rate</th>
                    <th className="pb-3 pr-6">Block Rate</th>
                    <th className="pb-3">Health</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/20">
                  {[...summaries]
                    .sort((a, b) => b.grossRevenueDzd - a.grossRevenueDzd)
                    .slice(0, 20)
                    .map((m) => (
                      <tr key={m.merchantId}>
                        <td className="py-2.5 pr-6">
                          <div className="font-medium text-slate-200">{m.name}</div>
                          {m.topProvider && (
                            <div className="text-[11px] text-slate-500 capitalize">{m.topProvider}</div>
                          )}
                        </td>
                        <td className="py-2.5 pr-6">
                          <AdminBadge tone={statusTone(m.accountStatus)}>
                            {m.accountStatus}
                          </AdminBadge>
                        </td>
                        <td className="py-2.5 pr-6 text-slate-300">{fmtNumber(m.totalOrders)}</td>
                        <td className="py-2.5 pr-6 text-slate-300">{fmtNumber(m.totalShipments)}</td>
                        <td className="py-2.5 pr-6 text-amber-300 font-medium">{fmtCurrency(m.grossRevenueDzd)}</td>
                        <td className="py-2.5 pr-6">
                          <span className={m.deliverySuccessRate >= 0.65 ? "text-emerald-300" : m.deliverySuccessRate >= 0.5 ? "text-amber-300" : "text-rose-300"}>
                            {m.totalShipments > 0 ? fmtPct(m.deliverySuccessRate) : "—"}
                          </span>
                        </td>
                        <td className="py-2.5 pr-6">
                          <span className={m.blockRate <= 0.1 ? "text-slate-400" : m.blockRate <= 0.2 ? "text-amber-300" : "text-rose-300"}>
                            {m.totalOrders > 0 ? fmtPct(m.blockRate) : "—"}
                          </span>
                        </td>
                        <td className="py-2.5">
                          <span className={scoreTone(m.scores.health) + " font-semibold"}>
                            {m.scores.health}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </AdminPanel>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* TAB: MERCHANTS                                                  */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {tab === "merchants" && (
        <div className="space-y-4">

          {/* Search */}
          <form method="GET" className="flex gap-3">
            <input type="hidden" name="tab" value="merchants" />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search merchant name or ID…"
              className="w-full max-w-sm rounded-xl border border-slate-700/50 bg-slate-800/50 px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-slate-700/50 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700"
            >
              Search
            </button>
          </form>

          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              eyebrow={`${filteredMerchants.length} merchants`}
              title="Per-merchant intelligence"
              description="Delivery success, revenue, fraud exposure, and composite business scores."
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/40 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <th className="pb-3 pr-5">Merchant</th>
                    <th className="pb-3 pr-5">Orders</th>
                    <th className="pb-3 pr-5">Shipments</th>
                    <th className="pb-3 pr-5">Delivery</th>
                    <th className="pb-3 pr-5">Gross Rev.</th>
                    <th className="pb-3 pr-5">MoM Orders</th>
                    <th className="pb-3 pr-5">Avg Basket</th>
                    <th className="pb-3 pr-5">Block Rate</th>
                    <th className="pb-3 pr-5 text-right">Health</th>
                    <th className="pb-3 pr-5 text-right">Delivery</th>
                    <th className="pb-3 text-right">Trust</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/20">
                  {filteredMerchants.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="py-10 text-center text-sm text-slate-500">
                        No merchants found.
                      </td>
                    </tr>
                  ) : (
                    filteredMerchants.map((m) => (
                      <tr key={m.merchantId}>
                        <td className="py-3 pr-5">
                          <div className="font-medium text-slate-200">{m.name}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <AdminBadge tone={statusTone(m.accountStatus)}>
                              {m.accountStatus}
                            </AdminBadge>
                            {m.topProvider && (
                              <span className="text-[11px] text-slate-500 capitalize">{m.topProvider}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-5">
                          <div className="text-slate-300">{fmtNumber(m.totalOrders)}</div>
                          {m.orderTrend.some((v) => v > 0) && (
                            <div className="mt-1 h-6 w-16 text-[#D6A74C]">
                              <Sparkline values={m.orderTrend} className="h-full w-full" />
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-5 text-slate-300">{fmtNumber(m.totalShipments)}</td>
                        <td className="py-3 pr-5">
                          <span className={m.deliverySuccessRate >= 0.65 ? "text-emerald-300" : m.deliverySuccessRate >= 0.5 ? "text-amber-300" : "text-rose-300"}>
                            {m.totalShipments > 0 ? fmtPct(m.deliverySuccessRate) : "—"}
                          </span>
                        </td>
                        <td className="py-3 pr-5 text-amber-300 font-medium">
                          {fmtCurrency(m.grossRevenueDzd)}
                        </td>
                        <td className="py-3 pr-5">
                          <span className={m.orderGrowthRate > 0 ? "text-emerald-300" : m.orderGrowthRate < 0 ? "text-rose-300" : "text-slate-400"}>
                            {fmtGrowth(m.orderGrowthRate)}
                          </span>
                        </td>
                        <td className="py-3 pr-5 text-slate-300">
                          {m.avgBasketDzd > 0 ? fmtCurrency(m.avgBasketDzd) : "—"}
                        </td>
                        <td className="py-3 pr-5">
                          <span className={m.blockRate <= 0.1 ? "text-slate-400" : m.blockRate <= 0.2 ? "text-amber-300" : "text-rose-300"}>
                            {m.totalOrders > 0 ? fmtPct(m.blockRate) : "—"}
                          </span>
                        </td>
                        <td className="py-3 pr-5 text-right">
                          <span className={scoreTone(m.scores.health) + " font-bold"}>
                            {m.scores.health}
                          </span>
                        </td>
                        <td className="py-3 pr-5 text-right">
                          <span className={scoreTone(m.scores.delivery) + " font-bold"}>
                            {m.scores.delivery}
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <span className={scoreTone(m.scores.trust) + " font-bold"}>
                            {m.scores.trust}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </AdminPanel>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* TAB: CATEGORIES                                                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {tab === "categories" && (
        <div className="space-y-4">
          {categories.length === 0 ? (
            <AdminPanel>
              <p className="py-12 text-center text-sm text-slate-500">
                No category data yet. Categories are populated from product order lines once marketing intelligence ingestion has run.
              </p>
            </AdminPanel>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <AdminMetricCard
                  label="Categories tracked"
                  value={fmtNumber(categories.length)}
                  tone="sky"
                />
                <AdminMetricCard
                  label="Total category orders"
                  value={fmtNumber(categories.reduce((s, c) => s + c.totalOrders, 0))}
                  tone="gold"
                />
                <AdminMetricCard
                  label="Category gross revenue"
                  value={fmtCurrency(categories.reduce((s, c) => s + c.grossRevenueDzd, 0))}
                  tone="emerald"
                />
              </div>

              <AdminPanel className="space-y-4">
                <AdminSectionHeader
                  eyebrow="Category intelligence"
                  title="Category performance + advertising recommendations"
                  description="Based on product order lines. Success rate = delivered ÷ (delivered + returned + refused + no-answer + cancelled)."
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700/40 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        <th className="pb-3 pr-5">Category</th>
                        <th className="pb-3 pr-5">Orders</th>
                        <th className="pb-3 pr-5">Gross Rev.</th>
                        <th className="pb-3 pr-5">Avg Order</th>
                        <th className="pb-3 pr-5">Delivered</th>
                        <th className="pb-3 pr-5">Returned</th>
                        <th className="pb-3 pr-5">Refused</th>
                        <th className="pb-3 pr-5">Success</th>
                        <th className="pb-3 pr-5">Best Wilaya</th>
                        <th className="pb-3">Ad Recommendation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/20">
                      {categories.map((cat) => (
                        <tr key={cat.categoryName}>
                          <td className="py-3 pr-5 font-medium text-slate-200">{cat.categoryName}</td>
                          <td className="py-3 pr-5 text-slate-300">{fmtNumber(cat.totalOrders)}</td>
                          <td className="py-3 pr-5 text-amber-300">{fmtCurrency(cat.grossRevenueDzd)}</td>
                          <td className="py-3 pr-5 text-slate-300">{fmtCurrency(cat.avgOrderValueDzd)}</td>
                          <td className="py-3 pr-5 text-emerald-300">{fmtNumber(cat.deliveredOrders)}</td>
                          <td className="py-3 pr-5 text-amber-300">{fmtNumber(cat.returnedOrders)}</td>
                          <td className="py-3 pr-5 text-rose-300">{fmtNumber(cat.refusedOrders)}</td>
                          <td className="py-3 pr-5">
                            <span className={cat.deliverySuccessRate >= 0.65 ? "text-emerald-300" : cat.deliverySuccessRate >= 0.5 ? "text-amber-300" : "text-rose-300"}>
                              {fmtPct(cat.deliverySuccessRate)}
                            </span>
                          </td>
                          <td className="py-3 pr-5 text-slate-400 text-xs">
                            {cat.topWilayas[0]?.wilaya ?? "—"}
                          </td>
                          <td className="py-3">
                            <div className="space-y-1">
                              <AdminBadge tone={adTone(cat.adRecommendation)}>
                                {adLabel(cat.adRecommendation)}
                              </AdminBadge>
                              <p className="text-[11px] text-slate-500 max-w-xs leading-relaxed">
                                {cat.adRecommendationReason}
                              </p>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </AdminPanel>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* TAB: WILAYAS                                                    */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {tab === "wilayas" && (
        <div className="space-y-4">
          {wilayas.length === 0 ? (
            <AdminPanel>
              <p className="py-12 text-center text-sm text-slate-500">
                No wilaya delivery data yet. Data populates once shipment history sync has run.
              </p>
            </AdminPanel>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <AdminMetricCard
                  label="Wilayas with data"
                  value={fmtNumber(wilayas.length)}
                  tone="sky"
                />
                <AdminMetricCard
                  label="Highest success rate"
                  value={fmtPct(Math.max(...wilayas.map((w) => w.deliverySuccessRate)))}
                  delta={wilayas.sort((a, b) => b.deliverySuccessRate - a.deliverySuccessRate)[0]?.wilaya ?? ""}
                  tone="emerald"
                />
                <AdminMetricCard
                  label="Lowest success rate"
                  value={fmtPct(Math.min(...wilayas.map((w) => w.deliverySuccessRate)))}
                  delta={wilayas.sort((a, b) => a.deliverySuccessRate - b.deliverySuccessRate)[0]?.wilaya ?? ""}
                  tone="rose"
                />
              </div>

              <AdminPanel className="space-y-4">
                <AdminSectionHeader
                  eyebrow="Wilaya intelligence"
                  title="Wilaya-level delivery performance"
                  description="From shipment history. Avg delivery time = date_expedition → date_last_status (delivered shipments only)."
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700/40 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        <th className="pb-3 pr-5">Wilaya</th>
                        <th className="pb-3 pr-5">Shipments</th>
                        <th className="pb-3 pr-5">Delivered</th>
                        <th className="pb-3 pr-5">Returned</th>
                        <th className="pb-3 pr-5">Refused</th>
                        <th className="pb-3 pr-5">Success</th>
                        <th className="pb-3 pr-5">Avg COD</th>
                        <th className="pb-3 pr-5">Avg Days</th>
                        <th className="pb-3">Best Provider</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/20">
                      {[...wilayas]
                        .sort((a, b) => b.totalShipments - a.totalShipments)
                        .map((w) => (
                          <tr key={w.wilaya}>
                            <td className="py-2.5 pr-5 font-medium text-slate-200">{w.wilaya}</td>
                            <td className="py-2.5 pr-5 text-slate-300">{fmtNumber(w.totalShipments)}</td>
                            <td className="py-2.5 pr-5 text-emerald-300">{fmtNumber(w.deliveredShipments)}</td>
                            <td className="py-2.5 pr-5 text-amber-300">{fmtNumber(w.returnedShipments)}</td>
                            <td className="py-2.5 pr-5 text-rose-300">{fmtNumber(w.refusedShipments)}</td>
                            <td className="py-2.5 pr-5">
                              <span className={w.deliverySuccessRate >= 0.65 ? "text-emerald-300" : w.deliverySuccessRate >= 0.5 ? "text-amber-300" : "text-rose-300"}>
                                {fmtPct(w.deliverySuccessRate)}
                              </span>
                            </td>
                            <td className="py-2.5 pr-5 text-slate-300">{fmtCurrency(w.avgCodAmountDzd)}</td>
                            <td className="py-2.5 pr-5 text-slate-400">{fmtDays(w.avgDeliveryTimeDays)}</td>
                            <td className="py-2.5">
                              {w.bestProvider ? (
                                <span className="capitalize text-sky-300">
                                  {w.bestProvider}
                                  {w.bestProviderSuccessRate != null && (
                                    <span className="ml-1 text-slate-500">({fmtPct(w.bestProviderSuccessRate)})</span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </AdminPanel>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* TAB: DELIVERY                                                   */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {tab === "delivery" && (
        <div className="space-y-4">
          {providers.length === 0 ? (
            <AdminPanel>
              <p className="py-12 text-center text-sm text-slate-500">
                No delivery provider data yet. Data populates once shipment history sync has run.
              </p>
            </AdminPanel>
          ) : (
            <>
              {/* Provider summary cards */}
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {providers.map((p) => (
                  <AdminPanel key={p.provider} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-100 capitalize">{p.provider}</h3>
                      <AdminBadge tone={p.deliverySuccessRate >= 0.65 ? "emerald" : p.deliverySuccessRate >= 0.5 ? "amber" : "rose"}>
                        {fmtPct(p.deliverySuccessRate)} success
                      </AdminBadge>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">Shipments</p>
                        <p className="mt-0.5 font-semibold text-slate-200">{fmtNumber(p.totalShipments)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">Merchants</p>
                        <p className="mt-0.5 font-semibold text-slate-200">{fmtNumber(p.merchantCount)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">Delivered</p>
                        <p className="mt-0.5 font-semibold text-emerald-300">{fmtNumber(p.deliveredShipments)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">Returned</p>
                        <p className="mt-0.5 font-semibold text-amber-300">{fmtNumber(p.returnedShipments)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">Return Rate</p>
                        <p className="mt-0.5 font-semibold text-amber-300">{fmtPct(p.returnRate)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">Avg Delivery</p>
                        <p className="mt-0.5 font-semibold text-slate-300">{fmtDays(p.avgDeliveryTimeDays)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide">COD Collected</p>
                        <p className="mt-0.5 font-semibold text-sky-300">{fmtPct(p.codSuccessRate)}</p>
                      </div>
                    </div>

                    {p.topWilayas.length > 0 && (
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide mb-1.5">Best wilayas</p>
                        <div className="space-y-1">
                          {p.topWilayas.slice(0, 3).map((w) => (
                            <div key={w.wilaya} className="flex items-center justify-between text-xs">
                              <span className="text-slate-300">{w.wilaya}</span>
                              <span className="text-emerald-300">{fmtPct(w.successRate)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {p.worstWilayas.length > 0 && (
                      <div>
                        <p className="text-[11px] text-slate-500 uppercase tracking-wide mb-1.5">Worst wilayas</p>
                        <div className="space-y-1">
                          {p.worstWilayas.slice(0, 3).map((w) => (
                            <div key={w.wilaya} className="flex items-center justify-between text-xs">
                              <span className="text-slate-300">{w.wilaya}</span>
                              <span className="text-rose-300">{fmtPct(w.successRate)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </AdminPanel>
                ))}
              </div>

              {/* Head-to-head comparison table */}
              {providers.length >= 2 && (
                <AdminPanel className="space-y-4">
                  <AdminSectionHeader
                    eyebrow="Provider comparison"
                    title="Head-to-head delivery metrics"
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700/40 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          <th className="pb-3 pr-6">Provider</th>
                          <th className="pb-3 pr-6">Shipments</th>
                          <th className="pb-3 pr-6">Success</th>
                          <th className="pb-3 pr-6">Return Rate</th>
                          <th className="pb-3 pr-6">Avg Days</th>
                          <th className="pb-3">COD Collected</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/20">
                        {providers.map((p) => (
                          <tr key={p.provider}>
                            <td className="py-2.5 pr-6 font-medium text-slate-200 capitalize">{p.provider}</td>
                            <td className="py-2.5 pr-6 text-slate-300">{fmtNumber(p.totalShipments)}</td>
                            <td className="py-2.5 pr-6">
                              <span className={p.deliverySuccessRate >= 0.65 ? "text-emerald-300" : p.deliverySuccessRate >= 0.5 ? "text-amber-300" : "text-rose-300"}>
                                {fmtPct(p.deliverySuccessRate)}
                              </span>
                            </td>
                            <td className="py-2.5 pr-6 text-amber-300">{fmtPct(p.returnRate)}</td>
                            <td className="py-2.5 pr-6 text-slate-300">{fmtDays(p.avgDeliveryTimeDays)}</td>
                            <td className="py-2.5 text-sky-300">{fmtPct(p.codSuccessRate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </AdminPanel>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* TAB: INSIGHTS                                                   */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {tab === "insights" && (
        <div className="space-y-6">

          {/* Alert summary */}
          {alerts.length > 0 && (
            <AdminPanel className="space-y-4">
              <AdminSectionHeader
                eyebrow="Active alerts"
                title="Business alerts requiring attention"
                description={`${alerts.length} threshold breach${alerts.length !== 1 ? "es" : ""} detected from current platform data.`}
              />
              <div className="space-y-3">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <AdminBadge tone={severityTone(alert.severity)}>
                        {alert.severity.toUpperCase()}
                      </AdminBadge>
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-semibold text-slate-100">{alert.title}</p>
                        <p className="text-sm text-slate-400 leading-relaxed">{alert.body}</p>
                        {alert.merchantName && (
                          <p className="text-[11px] text-slate-500">Merchant: {alert.merchantName}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </AdminPanel>
          )}

          {/* All insights */}
          {insights.length === 0 ? (
            <AdminPanel>
              <p className="py-12 text-center text-sm text-slate-500">
                No insights generated yet. Insights require sufficient platform data (order checks, shipment history, and product order lines).
              </p>
            </AdminPanel>
          ) : (
            <AdminPanel className="space-y-4">
              <AdminSectionHeader
                eyebrow={`${insights.length} insights`}
                title="Automatic business insights"
                description="Generated from real platform data. All percentage thresholds are configurable."
              />
              <div className="space-y-3">
                {insights.map((insight) => (
                  <div
                    key={insight.id}
                    className="rounded-xl border border-slate-700/30 bg-slate-800/30 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <AdminBadge tone={severityTone(insight.severity)}>
                        {insight.type.replace(/_/g, " ")}
                      </AdminBadge>
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-semibold text-slate-200">{insight.title}</p>
                        <p className="text-sm text-slate-400 leading-relaxed">{insight.body}</p>
                        {insight.merchantName && (
                          <p className="text-[11px] text-slate-500">Merchant: {insight.merchantName}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </AdminPanel>
          )}
        </div>
      )}

    </div>
  );
}
