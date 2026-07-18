/**
 * /admin/automation
 *
 * Automation Engine — executable actions derived from HIGH/CRITICAL
 * recommendations. Every action requires explicit approval.
 * Nothing executes automatically.
 *
 * Tabs: all | advertising | delivery | products | pricing | merchant | regional
 */

import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
} from "@/components/admin/admin-ui";
import { generateAutomations } from "@/lib/automation/automation-engine";
import type { Automation, AutomationType } from "@/lib/automation/types";

export const dynamic = "force-dynamic";

type Tab = "all" | "advertising" | "delivery" | "products" | "pricing" | "merchant" | "regional";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "all",        label: "All" },
  { key: "advertising",label: "Advertising" },
  { key: "delivery",   label: "Delivery" },
  { key: "products",   label: "Products" },
  { key: "pricing",    label: "Pricing" },
  { key: "merchant",   label: "Merchant" },
  { key: "regional",   label: "Regional" },
];

const ADVERTISING_TYPES: AutomationType[] = [
  "pause_advertising", "increase_advertising", "reduce_advertising",
];
const DELIVERY_TYPES: AutomationType[] = [
  "switch_provider", "require_phone_confirmation", "force_cod_verification",
];
const PRODUCT_TYPES: AutomationType[] = [
  "reduce_stock", "increase_stock", "disable_product", "promote_product",
];
const PRICING_TYPES: AutomationType[] = ["raise_price", "lower_price"];
const MERCHANT_TYPES: AutomationType[] = ["notify_merchant", "escalate_to_admin"];

function filterByTab(automations: Automation[], tab: Tab): Automation[] {
  if (tab === "all") return automations;
  if (tab === "advertising") return automations.filter((a) => ADVERTISING_TYPES.includes(a.type));
  if (tab === "delivery")    return automations.filter((a) => DELIVERY_TYPES.includes(a.type));
  if (tab === "products")    return automations.filter((a) => PRODUCT_TYPES.includes(a.type));
  if (tab === "pricing")     return automations.filter((a) => PRICING_TYPES.includes(a.type));
  if (tab === "merchant")    return automations.filter((a) => MERCHANT_TYPES.includes(a.type));
  if (tab === "regional")    return automations.filter((a) => a.wilaya != null);
  return automations;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M DA";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K DA";
  return n.toFixed(0) + " DA";
}

function fmtMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  return `${(min / 60).toFixed(0)}h`;
}

function typeLabel(t: AutomationType): string {
  const MAP: Record<AutomationType, string> = {
    pause_advertising:           "⏸ Pause Ads",
    increase_advertising:        "↑ Increase Ads",
    reduce_advertising:          "↓ Reduce Ads",
    switch_provider:             "🔄 Switch Provider",
    require_phone_confirmation:  "📞 Confirmation Calls",
    force_cod_verification:      "✅ COD Verification",
    reduce_stock:                "📦 Reduce Stock",
    increase_stock:              "📦 Increase Stock",
    raise_price:                 "💰 Raise Price",
    lower_price:                 "💰 Lower Price",
    disable_product:             "🚫 Disable Product",
    promote_product:             "⭐ Promote Product",
    notify_merchant:             "📬 Notify Merchant",
    escalate_to_admin:           "🔔 Escalate to Admin",
  };
  return MAP[t] ?? t;
}

function typeTone(t: AutomationType): "rose" | "emerald" | "amber" | "sky" | "violet" | "neutral" {
  if (t === "pause_advertising" || t === "disable_product") return "rose";
  if (t === "increase_advertising" || t === "promote_product" || t === "increase_stock") return "emerald";
  if (t === "switch_provider" || t === "require_phone_confirmation" || t === "force_cod_verification") return "sky";
  if (t === "raise_price" || t === "lower_price" || t === "reduce_advertising" || t === "reduce_stock") return "amber";
  if (t === "escalate_to_admin") return "violet";
  return "neutral";
}

function priorityTone(p: string): "rose" | "amber" | "sky" | "neutral" {
  if (p === "CRITICAL") return "rose";
  if (p === "HIGH")     return "amber";
  if (p === "MEDIUM")   return "sky";
  return "neutral";
}

function riskTone(r: string): "rose" | "amber" | "emerald" {
  if (r === "high")   return "rose";
  if (r === "medium") return "amber";
  return "emerald";
}

// ── Automation card ───────────────────────────────────────────────────────────

function AutomationCard({ a }: { a: Automation }) {
  const context = [a.merchantName, a.categoryName, a.wilaya, a.provider, a.productName]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <AdminBadge tone={priorityTone(a.priority)}>{a.priority}</AdminBadge>
          <AdminBadge tone={typeTone(a.type)}>{typeLabel(a.type)}</AdminBadge>
          <AdminBadge tone={riskTone(a.riskLevel)}>Risk: {a.riskLevel}</AdminBadge>
        </div>
        <span className="text-xs font-bold text-amber-300 shrink-0">
          {fmtCurrency(a.estimatedGainDzd)}
        </span>
      </div>

      {/* Description */}
      <div>
        <p className="text-sm font-semibold text-white/90">{a.description}</p>
        {context && (
          <p className="text-xs text-white/40 mt-0.5">{context}</p>
        )}
        <p className="text-xs text-white/50 mt-1.5">{a.reason}</p>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] text-white/30 pt-1 border-t border-white/5">
        <span>Confidence: {a.confidence}%</span>
        <span>Est. time: {fmtMinutes(a.estimatedTimeMinutes)}</span>
        <span className="text-amber-400 font-semibold">Requires Approval</span>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminAutomationPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  const supabase = createClient();
  const tab = ((await searchParams)?.tab ?? "all") as Tab;

  type AutoResult = { ok: true; data: Awaited<ReturnType<typeof generateAutomations>> } | { ok: false; error: string };
  const autoResult: AutoResult = await generateAutomations(supabase)
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Automation Engine failed to load.",
    }));

  if (!autoResult.ok) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-rose-200">
          <p className="font-semibold">Automation Engine unavailable</p>
          <p className="text-sm mt-1 text-rose-300/70">{autoResult.error}</p>
        </div>
      </div>
    );
  }

  const { automations, summary } = autoResult.data;
  const visible = filterByTab(automations, tab);

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white/90">Automation Engine</h1>
        <p className="text-xs text-white/40 mt-0.5">
          Executable actions from HIGH/CRITICAL recommendations · All require approval · Nothing runs automatically
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminMetricCard
          label="Total Automations"
          value={summary.totalAutomations.toString()}
          tone="sky"
        />
        <AdminMetricCard
          label="Critical Actions"
          value={summary.criticalCount.toString()}
          tone={summary.criticalCount > 0 ? "rose" : "emerald"}
        />
        <AdminMetricCard
          label="High Priority"
          value={summary.highCount.toString()}
          tone={summary.highCount > 0 ? "amber" : "sky"}
        />
        <AdminMetricCard
          label="Estimated Gain"
          value={fmtCurrency(summary.totalEstimatedGainDzd)}
          tone="gold"
        />
      </div>

      {/* Approval notice */}
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        <strong>All {summary.pendingApprovalCount} automations require explicit merchant or admin approval before execution.</strong>{" "}
        These are recommendations, not scheduled tasks. Review each action carefully before approving.
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 flex-wrap">
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

      {/* Automation grid */}
      <div className="space-y-4">
        <AdminSectionHeader title={`${visible.length} automation${visible.length !== 1 ? "s" : ""}`} />

        {visible.length === 0 ? (
          <AdminPanel>
            <p className="text-sm text-white/40 py-4 text-center">
              No automations in this category. Either no HIGH/CRITICAL recommendations exist, or this filter has no matches.
            </p>
          </AdminPanel>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visible.map((a) => (
              <AutomationCard key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
