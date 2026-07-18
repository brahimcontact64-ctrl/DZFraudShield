/**
 * /admin/strategy
 *
 * Business Strategy Engine — per-merchant consultant strategies and
 * interactive decision simulator.
 *
 * Tabs: strategies | simulator
 */

import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
} from "@/components/admin/admin-ui";
import { generateStrategyWithSimulatorData } from "@/lib/strategy-engine/strategy-engine";
import type { MerchantStrategy, StrategyAction } from "@/lib/strategy-engine/types";
import SimulatorPanel from "./simulator-panel";

export const dynamic = "force-dynamic";

type Tab = "strategies" | "simulator";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "strategies", label: "Merchant Strategies" },
  { key: "simulator",  label: "Decision Simulator" },
];

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M DA";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K DA";
  return n.toFixed(0) + " DA";
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

// ── Tones ─────────────────────────────────────────────────────────────────────

function priorityTone(p: string): "rose" | "amber" | "sky" | "neutral" {
  if (p === "critical") return "rose";
  if (p === "high")     return "amber";
  if (p === "medium")   return "sky";
  return "neutral";
}

function categoryIcon(cat: string): string {
  const MAP: Record<string, string> = {
    advertising: "📢",
    delivery:    "🚚",
    products:    "📦",
    pricing:     "💰",
    regional:    "📍",
    customer:    "👤",
    operations:  "⚙️",
  };
  return MAP[cat] ?? "•";
}

function timeToValueTone(t: string): "emerald" | "sky" | "amber" | "neutral" {
  if (t === "immediate") return "emerald";
  if (t === "1-2 weeks") return "sky";
  if (t === "1 month")   return "amber";
  return "neutral";
}

function healthColor(score: number): string {
  if (score >= 75) return "text-emerald-300";
  if (score >= 50) return "text-amber-300";
  return "text-rose-300";
}

// ── Action card ───────────────────────────────────────────────────────────────

function ActionCard({ action }: { action: StrategyAction }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/4 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-base">{categoryIcon(action.category)}</span>
          <span className="text-xs font-bold text-white/40">#{action.rank}</span>
        </div>
        <AdminBadge tone={timeToValueTone(action.timeToValue)}>
          {action.timeToValue}
        </AdminBadge>
      </div>
      <p className="text-sm font-semibold text-white/90">{action.title}</p>
      <p className="text-xs text-white/50">{action.why}</p>
      <div className="flex items-center justify-between pt-1 text-xs">
        <span className="text-amber-300 font-medium">{action.expectedROI}</span>
        <span className="text-white/30">{action.confidence}% conf</span>
      </div>
    </div>
  );
}

// ── Merchant strategy card ────────────────────────────────────────────────────

function MerchantStrategyCard({ s, expanded }: { s: MerchantStrategy; expanded: boolean }) {
  return (
    <div className={`rounded-xl border bg-white/5 p-5 space-y-4 ${
      s.strategicPriority === "critical"
        ? "border-rose-500/30"
        : s.strategicPriority === "high"
        ? "border-amber-500/30"
        : "border-white/10"
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-bold text-white/90">{s.merchantName}</p>
          <div className="flex items-center gap-2 mt-1">
            <AdminBadge tone={priorityTone(s.strategicPriority)}>
              {s.strategicPriority.toUpperCase()}
            </AdminBadge>
            <span className={`text-sm font-bold ${healthColor(s.overallHealthScore)}`}>
              Health {s.overallHealthScore}/100
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-white/40">Expected upside</p>
          <p className="text-sm font-bold text-emerald-300">{fmtCurrency(s.expectedRevenueIncreaseDzd)}</p>
        </div>
      </div>

      {/* Executive summary */}
      <p className="text-xs text-white/60 leading-relaxed">{s.executiveSummary}</p>

      {/* Key metrics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {s.expectedDeliveryImprovement > 0 && (
          <div className="rounded bg-emerald-500/10 border border-emerald-500/20 p-2">
            <p className="text-white/40 text-[10px] uppercase">Delivery improvement</p>
            <p className="text-emerald-300 font-bold">+{fmtPct(s.expectedDeliveryImprovement)}</p>
          </div>
        )}
        {s.expectedRefusalReduction > 0 && (
          <div className="rounded bg-sky-500/10 border border-sky-500/20 p-2">
            <p className="text-white/40 text-[10px] uppercase">Refusal reduction</p>
            <p className="text-sky-300 font-bold">-{fmtPct(s.expectedRefusalReduction)}</p>
          </div>
        )}
      </div>

      {/* Top actions */}
      {s.topActions.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] text-white/30 uppercase tracking-wide font-semibold">
            Top {Math.min(s.topActions.length, 3)} Actions
          </p>
          <div className="space-y-2">
            {s.topActions.slice(0, expanded ? 10 : 3).map((a) => (
              <ActionCard key={a.rank} action={a} />
            ))}
          </div>
        </div>
      )}

      {/* Strategy pillars (expanded only) */}
      {expanded && (
        <div className="space-y-3 pt-2 border-t border-white/10">
          {[
            { label: "Advertising Strategy", text: s.advertisingStrategy },
            { label: "Delivery Strategy", text: s.deliveryStrategy },
            { label: "Pricing Strategy", text: s.pricingStrategy },
            { label: "Regional Strategy", text: s.regionalStrategy },
            { label: "Customer Strategy", text: s.customerStrategy },
            { label: "Growth Strategy", text: s.growthStrategy },
          ].map(({ label, text }) => (
            <div key={label}>
              <p className="text-[10px] text-white/30 uppercase tracking-wide font-semibold mb-1">{label}</p>
              <p className="text-xs text-white/60 leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminStrategyPage({
  searchParams,
}: {
  searchParams?: { tab?: string; expand?: string };
}) {
  const supabase = createClient();
  const resolvedParams = await searchParams;
  const tab = (resolvedParams?.tab ?? "strategies") as Tab;
  const expandId = resolvedParams?.expand ?? null;

  type StratResult = { ok: true; data: Awaited<ReturnType<typeof generateStrategyWithSimulatorData>> } | { ok: false; error: string };
  const stratResult: StratResult = await generateStrategyWithSimulatorData(supabase)
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Strategy Engine failed to load.",
    }));

  if (!stratResult.ok) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-rose-200">
          <p className="font-semibold">Strategy Engine unavailable</p>
          <p className="text-sm mt-1 text-rose-300/70">{stratResult.error}</p>
        </div>
      </div>
    );
  }

  const {
    merchantStrategies,
    merchantsAnalyzed,
    generatedAt,
    simulatorMerchants,
    simulatorProviders,
    simulatorWilayas,
  } = stratResult.data;

  const criticalCount = merchantStrategies.filter((s) => s.strategicPriority === "critical").length;
  const highCount     = merchantStrategies.filter((s) => s.strategicPriority === "high").length;
  const totalUpside   = merchantStrategies.reduce((s, m) => s + m.expectedRevenueIncreaseDzd, 0);

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white/90">Business Strategy Engine</h1>
        <p className="text-xs text-white/40 mt-0.5">
          Per-merchant consultant strategies · {merchantsAnalyzed} merchants analyzed · Generated {new Date(generatedAt).toLocaleTimeString()}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminMetricCard
          label="Strategies Generated"
          value={merchantStrategies.length.toString()}
          tone="sky"
        />
        <AdminMetricCard
          label="Critical Priority"
          value={criticalCount.toString()}
          tone={criticalCount > 0 ? "rose" : "emerald"}
        />
        <AdminMetricCard
          label="High Priority"
          value={highCount.toString()}
          tone={highCount > 0 ? "amber" : "sky"}
        />
        <AdminMetricCard
          label="Total Est. Upside"
          value={fmtCurrency(totalUpside)}
          tone="gold"
        />
      </div>

      {/* Tab nav */}
      <div className="flex gap-1">
        {TABS.map((t) => (
          <a
            key={t.key}
            href={`?tab=${t.key}`}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-violet-600 text-white"
                : "text-white/50 hover:text-white/80 hover:bg-white/5"
            }`}
          >
            {t.label}
          </a>
        ))}
      </div>

      {/* ── STRATEGIES TAB ───────────────────────────────────────────────────── */}
      {tab === "strategies" && (
        <div className="space-y-4">
          {merchantStrategies.length === 0 ? (
            <AdminPanel>
              <p className="text-sm text-white/40 py-4 text-center">
                No strategies generated. Merchants need at least 5 orders for analysis.
              </p>
            </AdminPanel>
          ) : (
            <>
              {/* Critical merchants */}
              {criticalCount > 0 && (
                <div className="space-y-3">
                  <AdminSectionHeader title={`Critical Priority (${criticalCount})`} />
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {merchantStrategies
                      .filter((s) => s.strategicPriority === "critical")
                      .map((s) => (
                        <MerchantStrategyCard
                          key={s.merchantId}
                          s={s}
                          expanded={expandId === s.merchantId}
                        />
                      ))}
                  </div>
                </div>
              )}

              {/* High merchants */}
              {highCount > 0 && (
                <div className="space-y-3">
                  <AdminSectionHeader title={`High Priority (${highCount})`} />
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {merchantStrategies
                      .filter((s) => s.strategicPriority === "high")
                      .map((s) => (
                        <MerchantStrategyCard
                          key={s.merchantId}
                          s={s}
                          expanded={expandId === s.merchantId}
                        />
                      ))}
                  </div>
                </div>
              )}

              {/* Medium & low */}
              {merchantStrategies.filter((s) => s.strategicPriority === "medium" || s.strategicPriority === "low").length > 0 && (
                <div className="space-y-3">
                  <AdminSectionHeader title="Medium & Low Priority" />
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {merchantStrategies
                      .filter((s) => s.strategicPriority === "medium" || s.strategicPriority === "low")
                      .map((s) => (
                        <MerchantStrategyCard
                          key={s.merchantId}
                          s={s}
                          expanded={expandId === s.merchantId}
                        />
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── SIMULATOR TAB ────────────────────────────────────────────────────── */}
      {tab === "simulator" && (
        <SimulatorPanel
          merchants={simulatorMerchants}
          providers={simulatorProviders}
          wilayas={simulatorWilayas}
        />
      )}
    </div>
  );
}
