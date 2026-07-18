/**
 * /admin/recommendations
 *
 * Business Decision Engine — deterministic intelligence from real platform data.
 * All recommendations are generated from live order, shipment, and product data.
 * No AI, no fabricated values, no placeholder content.
 */

import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
} from "@/components/admin/admin-ui";
import { generateRecommendations } from "@/lib/recommendation-engine/engine";
import type {
  Recommendation,
  RecommendationCategory,
  RecommendationPriority,
} from "@/lib/recommendation-engine/types";
import { ExportButtons } from "./export-buttons";

export const dynamic = "force-dynamic";

// ── Category labels ───────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<RecommendationCategory, string> = {
  advertising: "Advertising",
  delivery: "Delivery",
  products: "Products",
  pricing: "Pricing",
  merchant_health: "Merchant Health",
  regional: "Regional",
  customer: "Customer",
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCurrency(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M DA";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K DA";
  return n.toFixed(0) + " DA";
}

function fmtNumber(n: number): string {
  return n.toLocaleString("fr-DZ");
}

// ── Tone helpers ──────────────────────────────────────────────────────────────

function priorityTone(
  p: RecommendationPriority,
): "rose" | "amber" | "sky" | "neutral" {
  if (p === "CRITICAL") return "rose";
  if (p === "HIGH") return "amber";
  if (p === "MEDIUM") return "sky";
  return "neutral";
}

function categoryTone(
  c: RecommendationCategory,
): "emerald" | "sky" | "violet" | "amber" | "rose" | "neutral" {
  if (c === "advertising") return "violet";
  if (c === "delivery") return "sky";
  if (c === "products") return "emerald";
  if (c === "pricing") return "amber";
  if (c === "merchant_health") return "rose";
  if (c === "regional") return "sky";
  if (c === "customer") return "emerald";
  return "neutral";
}

function confidenceColor(score: number): string {
  if (score >= 75) return "text-emerald-300";
  if (score >= 50) return "text-amber-300";
  return "text-rose-300";
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminRecommendationsPage({
  searchParams,
}: {
  searchParams?: {
    priority?: string;
    category?: string;
    merchant?: string;
    minConfidence?: string;
  };
}) {
  const supabase = createClient();
  const params = await searchParams;

  const filterPriority = params?.priority ?? "ALL";
  const filterCategory = params?.category ?? "ALL";
  const filterMerchant = (params?.merchant ?? "").toLowerCase().trim();
  const minConfidence = parseInt(params?.minConfidence ?? "0", 10) || 0;

  // ── Generate recommendations ────────────────────────────────────────────

  const { recommendations: allRecs, summary } = await generateRecommendations(supabase);

  // ── Apply filters ───────────────────────────────────────────────────────

  let filtered: Recommendation[] = allRecs;

  if (filterPriority !== "ALL") {
    filtered = filtered.filter((r) => r.priority === filterPriority);
  }

  if (filterCategory !== "ALL") {
    filtered = filtered.filter((r) => r.category === filterCategory);
  }

  if (filterMerchant) {
    filtered = filtered.filter(
      (r) =>
        (r.merchantName?.toLowerCase().includes(filterMerchant) ?? false) ||
        (r.merchantId?.toLowerCase().includes(filterMerchant) ?? false),
    );
  }

  if (minConfidence > 0) {
    filtered = filtered.filter((r) => r.confidenceScore >= minConfidence);
  }

  // ── Visible slice (show up to 200 to keep page fast) ───────────────────
  const displayed = filtered.slice(0, 200);
  const hasMore = filtered.length > 200;

  const priorityOptions: Array<{ value: string; label: string }> = [
    { value: "ALL", label: "All Priorities" },
    { value: "CRITICAL", label: "Critical" },
    { value: "HIGH", label: "High" },
    { value: "MEDIUM", label: "Medium" },
    { value: "LOW", label: "Low" },
  ];

  const categoryOptions: Array<{ value: string; label: string }> = [
    { value: "ALL", label: "All Categories" },
    ...Object.entries(CATEGORY_LABELS).map(([k, v]) => ({ value: k, label: v })),
  ];

  const confidenceOptions: Array<{ value: string; label: string }> = [
    { value: "0", label: "Any Confidence" },
    { value: "30", label: "≥ 30%" },
    { value: "50", label: "≥ 50%" },
    { value: "70", label: "≥ 70%" },
    { value: "85", label: "≥ 85%" },
  ];

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="rounded-2xl border border-slate-700/40 bg-slate-800/20 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <AdminBadge tone="violet">Recommendation Engine</AdminBadge>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Business Decision Engine
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-400">
              Deterministic intelligence generated from real platform data. Every recommendation is reproducible from your merchant, delivery, product, and regional data. No AI, no fabricated values.
            </p>
          </div>
          <ExportButtons recommendations={filtered} />
        </div>
      </div>

      {/* ── Summary KPIs ── */}
      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <AdminMetricCard
          label="Total Recommendations"
          value={fmtNumber(summary.totalRecommendations)}
          delta={`${summary.merchantsAnalyzed} merchants analyzed`}
          tone="sky"
        />
        <AdminMetricCard
          label="Critical"
          value={fmtNumber(summary.criticalCount)}
          delta="Require immediate action"
          tone="rose"
        />
        <AdminMetricCard
          label="High Priority"
          value={fmtNumber(summary.highCount)}
          delta="Significant impact"
          tone="amber"
        />
        <AdminMetricCard
          label="Estimated Savings"
          value={fmtCurrency(summary.totalEstimatedSavingsDzd)}
          delta="Potential loss reduction"
          tone="emerald"
        />
        <AdminMetricCard
          label="Revenue Opportunity"
          value={fmtCurrency(summary.totalEstimatedRevenueDzd)}
          delta="Potential revenue uplift"
          tone="gold"
        />
        <AdminMetricCard
          label="Combined Opportunity"
          value={fmtCurrency(summary.totalEstimatedSavingsDzd + summary.totalEstimatedRevenueDzd)}
          delta="Total estimated financial impact"
          tone="violet"
        />
      </section>

      {/* ── Category breakdown ── */}
      <section className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">
        {Object.entries(summary.categoryCounts).map(([cat, count]) => (
          <a
            key={cat}
            href={`?category=${cat}`}
            className="group flex flex-col gap-1 rounded-xl border border-slate-700/40 bg-slate-800/30 p-3 transition hover:border-slate-600/50"
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {CATEGORY_LABELS[cat as RecommendationCategory]}
            </span>
            <span className="text-2xl font-bold text-slate-100">{count}</span>
          </a>
        ))}
      </section>

      {/* ── Filters ── */}
      <form method="GET" className="flex flex-wrap gap-3">
        {/* Priority filter */}
        <select
          name="priority"
          defaultValue={filterPriority}
          className="rounded-xl border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-200 focus:border-slate-500 focus:outline-none"
        >
          {priorityOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Category filter */}
        <select
          name="category"
          defaultValue={filterCategory}
          className="rounded-xl border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-200 focus:border-slate-500 focus:outline-none"
        >
          {categoryOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Confidence filter */}
        <select
          name="minConfidence"
          defaultValue={String(minConfidence)}
          className="rounded-xl border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-200 focus:border-slate-500 focus:outline-none"
        >
          {confidenceOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Merchant search */}
        <input
          name="merchant"
          defaultValue={filterMerchant}
          placeholder="Filter by merchant…"
          className="w-48 rounded-xl border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
        />

        <button
          type="submit"
          className="rounded-xl bg-slate-700/50 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Apply
        </button>

        {(filterPriority !== "ALL" || filterCategory !== "ALL" || filterMerchant || minConfidence > 0) && (
          <a
            href="/admin/recommendations"
            className="rounded-xl border border-slate-700/40 px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
          >
            Clear filters
          </a>
        )}
      </form>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Showing {displayed.length} of {filtered.length} recommendations
          {hasMore && (
            <span className="ml-1 text-amber-400"> — refine filters to see more</span>
          )}
        </p>
        <p className="text-[11px] text-slate-600">
          Generated at {new Date(summary.generatedAt).toLocaleString("fr-DZ")}
        </p>
      </div>

      {/* ── Recommendation list ── */}
      {displayed.length === 0 ? (
        <AdminPanel>
          <p className="py-12 text-center text-sm text-slate-500">
            No recommendations match the current filters. Try adjusting your filter criteria.
          </p>
        </AdminPanel>
      ) : (
        <div className="space-y-3">
          {displayed.map((rec) => (
            <AdminPanel key={rec.id} className="space-y-4">
              {/* Row 1: badges + title */}
              <div className="flex flex-wrap items-start gap-3">
                <AdminBadge tone={priorityTone(rec.priority)}>{rec.priority}</AdminBadge>
                <AdminBadge tone={categoryTone(rec.category)}>
                  {CATEGORY_LABELS[rec.category]}
                </AdminBadge>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-100">{rec.title}</h3>
                  {rec.merchantName && (
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Merchant: {rec.merchantName}
                      {rec.wilaya && ` · Wilaya: ${rec.wilaya}`}
                      {rec.provider && ` · Provider: ${rec.provider}`}
                      {rec.productName && ` · Product: ${rec.productName}`}
                      {rec.categoryName && ` · Category: ${rec.categoryName}`}
                    </p>
                  )}
                </div>
                {/* Confidence */}
                <div className="text-right shrink-0">
                  <p className={`text-lg font-bold ${confidenceColor(rec.confidenceScore)}`}>
                    {rec.confidenceScore}%
                  </p>
                  <p className="text-[11px] text-slate-500">confidence</p>
                </div>
              </div>

              {/* Row 2: description + reason */}
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-1">
                    What happened
                  </p>
                  <p className="text-sm text-slate-300 leading-relaxed">{rec.description}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-1">
                    Why it happened
                  </p>
                  <p className="text-sm text-slate-400 leading-relaxed">{rec.reason}</p>
                </div>
              </div>

              {/* Row 3: business impact + financial estimates */}
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-1">
                    Business impact
                  </p>
                  <p className="text-sm text-slate-400 leading-relaxed">{rec.businessImpact}</p>
                </div>
                <div className="flex items-start gap-4">
                  {rec.estimatedSavingsDzd > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-1">
                        Est. Savings
                      </p>
                      <p className="text-base font-bold text-emerald-300">
                        {fmtCurrency(rec.estimatedSavingsDzd)}
                      </p>
                    </div>
                  )}
                  {rec.estimatedRevenueIncreaseDzd > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-1">
                        Est. Revenue+
                      </p>
                      <p className="text-base font-bold text-amber-300">
                        {fmtCurrency(rec.estimatedRevenueIncreaseDzd)}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Row 4: recommended actions */}
              {rec.recommendedActions.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-2">
                    Recommended actions
                  </p>
                  <div className="space-y-1.5">
                    {rec.recommendedActions.map((action, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 rounded-lg border border-slate-700/30 bg-slate-800/30 px-3 py-2"
                      >
                        <span className="mt-0.5 shrink-0 h-4 w-4 rounded-full border border-slate-600/60 flex items-center justify-center text-[10px] text-slate-500 font-bold">
                          {i + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-200">{action.label}</p>
                          <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                            {action.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Row 5: data sources + ID */}
              <div className="flex items-center justify-between border-t border-slate-700/30 pt-3">
                <div className="flex flex-wrap gap-1">
                  {rec.requiredDataSources.map((ds) => (
                    <span
                      key={ds}
                      className="rounded-md bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-500 font-mono"
                    >
                      {ds}
                    </span>
                  ))}
                </div>
                <span className="text-[10px] text-slate-600 font-mono">{rec.id}</span>
              </div>
            </AdminPanel>
          ))}
        </div>
      )}
    </div>
  );
}
