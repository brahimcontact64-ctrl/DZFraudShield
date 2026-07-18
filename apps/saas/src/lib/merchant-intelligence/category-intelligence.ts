// category-intelligence.ts
//
// Category analytics derived from marketing_product_order_lines.
// Aggregates all order lines by category_snapshot to produce revenue,
// delivery success, wilaya breakdown, and advertising recommendations.
//
// Data source: marketing_product_order_lines
//   - category_snapshot: category at order time (nullable)
//   - line_total:        order line amount
//   - delivery_outcome:  DELIVERED / RETURNED / REFUSED / NO_ANSWER / CANCELLED / null
//   - wilaya:            delivery wilaya (nullable)
//   - order_date:        order timestamp (nullable)
//   - quantity:          units ordered

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdRecommendation, CategoryIntel, WilayaStat } from "./types";

const ORDER_LINE_SAMPLE = 20000;
const MIN_ORDERS_FOR_WILAYA_RANKING = 3;
const TOP_WILAYA_LIMIT = 5;

// ── Outcome classifier ────────────────────────────────────────────────────────

type OutcomeGroup = "delivered" | "returned" | "refused" | "no_answer" | "cancelled" | "pending";

function classifyOutcome(raw: string | null | undefined): OutcomeGroup {
  if (!raw) return "pending";
  const s = raw.toUpperCase();
  if (s === "DELIVERED") return "delivered";
  if (s === "RETURNED") return "returned";
  if (s === "REFUSED") return "refused";
  if (s === "NO_ANSWER") return "no_answer";
  if (s === "CANCELLED" || s === "FAKE_ORDER") return "cancelled";
  return "pending";
}

// ── Delivery success rate ─────────────────────────────────────────────────────

function successRate(
  delivered: number,
  returned: number,
  refused: number,
  noAnswer: number,
  cancelled: number,
): number {
  const denominator = delivered + returned + refused + noAnswer + cancelled;
  if (denominator === 0) return 0;
  return Number((delivered / denominator).toFixed(4));
}

// ── Ad recommendation ─────────────────────────────────────────────────────────

function adRecommendation(
  rate: number,
  totalOrders: number,
): { recommendation: AdRecommendation; reason: string } {
  if (totalOrders < 5) {
    return {
      recommendation: "maintain",
      reason: "Insufficient data — fewer than 5 orders. Continue current spend and monitor.",
    };
  }

  if (rate >= 0.72) {
    return {
      recommendation: "increase",
      reason: `${(rate * 100).toFixed(1)}% delivery success rate — strong market fit. Scale ad spend to maximise revenue.`,
    };
  }

  if (rate >= 0.55) {
    return {
      recommendation: "maintain",
      reason: `${(rate * 100).toFixed(1)}% delivery success rate — acceptable performance. Maintain current budget while optimising targeting.`,
    };
  }

  if (rate >= 0.38) {
    return {
      recommendation: "reduce",
      reason: `${(rate * 100).toFixed(1)}% delivery success rate — return losses eroding margins. Reduce spend by 30–50% and investigate wilaya targeting.`,
    };
  }

  return {
    recommendation: "pause",
    reason: `${(rate * 100).toFixed(1)}% delivery success rate — above-threshold return rate. Pause ad spend until root cause is resolved.`,
  };
}

// ── Row type ──────────────────────────────────────────────────────────────────

type OrderLineRow = {
  category_snapshot: string | null;
  line_total: number | null;
  delivery_outcome: string | null;
  wilaya: string | null;
  quantity: number | null;
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function getCategoryIntelligence(
  supabase: SupabaseClient,
): Promise<CategoryIntel[]> {
  const { data, error } = await supabase
    .from("marketing_product_order_lines")
    .select("category_snapshot, line_total, delivery_outcome, wilaya, quantity")
    .order("order_date", { ascending: false })
    .limit(ORDER_LINE_SAMPLE);

  if (error) throw error;

  const rows = (data ?? []) as OrderLineRow[];

  // ── Aggregate by category ────────────────────────────────────────────────

  type CatAgg = {
    totalOrders: number;
    totalUnits: number;
    grossRevenue: number;
    delivered: number;
    returned: number;
    refused: number;
    noAnswer: number;
    cancelled: number;
    pending: number;
    wilayas: Map<string, { total: number; delivered: number; revenue: number }>;
  };

  const byCategory = new Map<string, CatAgg>();

  for (const row of rows) {
    const category = row.category_snapshot?.trim() || "Uncategorized";
    const total = Math.max(0, Number(row.line_total ?? 0));
    const qty = Math.max(0, Number(row.quantity ?? 1));
    const outcome = classifyOutcome(row.delivery_outcome);

    if (!byCategory.has(category)) {
      byCategory.set(category, {
        totalOrders: 0, totalUnits: 0, grossRevenue: 0,
        delivered: 0, returned: 0, refused: 0, noAnswer: 0, cancelled: 0, pending: 0,
        wilayas: new Map(),
      });
    }

    const agg = byCategory.get(category)!;
    agg.totalOrders++;
    agg.totalUnits += qty;
    agg.grossRevenue += total;

    if (outcome === "delivered") agg.delivered++;
    else if (outcome === "returned") agg.returned++;
    else if (outcome === "refused") agg.refused++;
    else if (outcome === "no_answer") agg.noAnswer++;
    else if (outcome === "cancelled") agg.cancelled++;
    else agg.pending++;

    if (row.wilaya) {
      const w = agg.wilayas.get(row.wilaya) ?? { total: 0, delivered: 0, revenue: 0 };
      w.total++;
      if (outcome === "delivered") { w.delivered++; w.revenue += total; }
      agg.wilayas.set(row.wilaya, w);
    }
  }

  // ── Build result array ────────────────────────────────────────────────────

  const result: CategoryIntel[] = [];

  for (const [categoryName, agg] of byCategory.entries()) {
    const rate = successRate(
      agg.delivered,
      agg.returned,
      agg.refused,
      agg.noAnswer,
      agg.cancelled,
    );

    const { recommendation, reason } = adRecommendation(rate, agg.totalOrders);
    const avgOrderValueDzd = agg.totalOrders > 0 ? agg.grossRevenue / agg.totalOrders : 0;

    // Wilaya rankings: qualify at least MIN_ORDERS_FOR_WILAYA_RANKING terminal orders
    const qualifiedWilayas: WilayaStat[] = Array.from(agg.wilayas.entries())
      .map(([wilaya, w]) => ({
        wilaya,
        orders: w.total,
        successRate: w.total > 0 ? w.delivered / w.total : 0,
        revenue: w.revenue,
      }))
      .filter((w) => w.orders >= MIN_ORDERS_FOR_WILAYA_RANKING);

    const topWilayas = qualifiedWilayas
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, TOP_WILAYA_LIMIT);

    const worstWilayas = qualifiedWilayas
      .sort((a, b) => a.successRate - b.successRate)
      .slice(0, TOP_WILAYA_LIMIT);

    result.push({
      categoryName,
      totalOrders: agg.totalOrders,
      totalUnits: agg.totalUnits,
      grossRevenueDzd: agg.grossRevenue,
      deliveredOrders: agg.delivered,
      returnedOrders: agg.returned,
      refusedOrders: agg.refused,
      pendingOrders: agg.pending,
      deliverySuccessRate: rate,
      avgOrderValueDzd,
      topWilayas,
      worstWilayas,
      adRecommendation: recommendation,
      adRecommendationReason: reason,
    });
  }

  // Sort by total revenue descending
  return result.sort((a, b) => b.grossRevenueDzd - a.grossRevenueDzd);
}
