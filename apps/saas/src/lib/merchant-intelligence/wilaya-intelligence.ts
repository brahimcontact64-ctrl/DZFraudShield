// wilaya-intelligence.ts
//
// Wilaya-level intelligence derived from merchant_shipment_history.
// Supplemented by marketing_product_order_lines for category breakdown per wilaya.
//
// Data sources:
//   merchant_shipment_history — delivery outcomes, COD amounts, provider
//   marketing_product_order_lines — category breakdown per wilaya

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WilayaIntel, ProviderStat } from "./types";

const SHIPMENT_SAMPLE = 15000;
const LINE_SAMPLE = 15000;
const MIN_ORDERS_FOR_PROVIDER_BEST = 5;
const TOP_CATEGORY_LIMIT = 5;
const TOP_WILAYA_LIMIT = 58; // all 58 Algerian wilayas

// ── Outcome classifier ────────────────────────────────────────────────────────

type OutcomeGroup = "delivered" | "returned" | "refused" | "no_answer" | "pending";

function classifyOutcome(raw: string | null | undefined): OutcomeGroup {
  if (!raw) return "pending";
  const s = raw.toUpperCase();
  if (s === "DELIVERED") return "delivered";
  if (s === "RETURNED") return "returned";
  if (s === "REFUSED") return "refused";
  if (s === "NO_ANSWER") return "no_answer";
  return "pending";
}

// ── Row types ─────────────────────────────────────────────────────────────────

type ShipmentRow = {
  wilaya_name: string | null;
  provider: string | null;
  normalized_outcome: string | null;
  cod_amount: number | null;
  payment_status: string | null;
  date_expedition: string | null;
  date_last_status: string | null;
};

type OrderLineRow = {
  wilaya: string | null;
  category_snapshot: string | null;
  delivery_outcome: string | null;
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function getWilayaIntelligence(
  supabase: SupabaseClient,
): Promise<WilayaIntel[]> {
  const [shipmentsResult, linesResult] = await Promise.all([
    supabase
      .from("merchant_shipment_history")
      .select("wilaya_name, provider, normalized_outcome, cod_amount, payment_status, date_expedition, date_last_status")
      .not("wilaya_name", "is", null)
      .order("date_creation", { ascending: false })
      .limit(SHIPMENT_SAMPLE),

    supabase
      .from("marketing_product_order_lines")
      .select("wilaya, category_snapshot, delivery_outcome")
      .not("wilaya", "is", null)
      .order("order_date", { ascending: false })
      .limit(LINE_SAMPLE),
  ]);

  if (shipmentsResult.error) throw shipmentsResult.error;
  if (linesResult.error) throw linesResult.error;

  const shipments = (shipmentsResult.data ?? []) as ShipmentRow[];
  const lines = (linesResult.data ?? []) as OrderLineRow[];

  // ── Aggregate shipments by wilaya ─────────────────────────────────────────

  type WilayaAgg = {
    total: number;
    delivered: number;
    returned: number;
    refused: number;
    noAnswer: number;
    pending: number;
    codSum: number;
    codCount: number;
    deliveryTimeSumDays: number;
    deliveryTimeCount: number;
    providers: Map<string, { total: number; delivered: number }>;
  };

  const byWilaya = new Map<string, WilayaAgg>();

  for (const s of shipments) {
    const wilaya = s.wilaya_name?.trim();
    if (!wilaya) continue;

    if (!byWilaya.has(wilaya)) {
      byWilaya.set(wilaya, {
        total: 0, delivered: 0, returned: 0, refused: 0, noAnswer: 0, pending: 0,
        codSum: 0, codCount: 0,
        deliveryTimeSumDays: 0, deliveryTimeCount: 0,
        providers: new Map(),
      });
    }

    const agg = byWilaya.get(wilaya)!;
    const outcome = classifyOutcome(s.normalized_outcome);
    const cod = Math.max(0, Number(s.cod_amount ?? 0));

    agg.total++;
    if (outcome === "delivered") agg.delivered++;
    else if (outcome === "returned") agg.returned++;
    else if (outcome === "refused") agg.refused++;
    else if (outcome === "no_answer") agg.noAnswer++;
    else agg.pending++;

    if (cod > 0) { agg.codSum += cod; agg.codCount++; }

    // Delivery time: date_expedition → date_last_status (delivered only)
    if (s.date_expedition && s.date_last_status && outcome === "delivered") {
      const diffMs = new Date(s.date_last_status).getTime() - new Date(s.date_expedition).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays >= 0 && diffDays <= 60) {
        agg.deliveryTimeSumDays += diffDays;
        agg.deliveryTimeCount++;
      }
    }

    if (s.provider) {
      const p = agg.providers.get(s.provider) ?? { total: 0, delivered: 0 };
      p.total++;
      if (outcome === "delivered") p.delivered++;
      agg.providers.set(s.provider, p);
    }
  }

  // ── Aggregate order lines by wilaya for category breakdown ────────────────

  type WilayaCatAgg = {
    categories: Map<string, { orders: number; delivered: number }>;
  };

  const catByWilaya = new Map<string, WilayaCatAgg>();

  for (const row of lines) {
    const wilaya = row.wilaya?.trim();
    const category = row.category_snapshot?.trim() || "Uncategorized";
    if (!wilaya) continue;

    if (!catByWilaya.has(wilaya)) {
      catByWilaya.set(wilaya, { categories: new Map() });
    }

    const agg = catByWilaya.get(wilaya)!;
    const c = agg.categories.get(category) ?? { orders: 0, delivered: 0 };
    c.orders++;
    if (classifyOutcome(row.delivery_outcome) === "delivered") c.delivered++;
    agg.categories.set(category, c);
  }

  // ── Build result array ────────────────────────────────────────────────────

  const result: WilayaIntel[] = [];

  for (const [wilaya, agg] of byWilaya.entries()) {
    const terminal = agg.delivered + agg.returned + agg.refused + agg.noAnswer;
    const deliverySuccessRate = terminal > 0 ? agg.delivered / terminal : 0;
    const grossRevenueDzd = agg.codSum;
    const avgCodAmountDzd = agg.codCount > 0 ? agg.codSum / agg.codCount : 0;
    const avgDeliveryTimeDays =
      agg.deliveryTimeCount > 0
        ? Number((agg.deliveryTimeSumDays / agg.deliveryTimeCount).toFixed(1))
        : null;

    // Best provider (by success rate, minimum qualifying orders)
    let bestProvider: string | null = null;
    let bestProviderSuccessRate: number | null = null;

    const providerBreakdown: ProviderStat[] = Array.from(agg.providers.entries())
      .filter(([, p]) => p.total >= MIN_ORDERS_FOR_PROVIDER_BEST)
      .map(([provider, p]) => ({
        provider,
        orders: p.total,
        successRate: p.total > 0 ? p.delivered / p.total : 0,
      }))
      .sort((a, b) => b.successRate - a.successRate);

    if (providerBreakdown.length > 0) {
      bestProvider = providerBreakdown[0].provider;
      bestProviderSuccessRate = providerBreakdown[0].successRate;
    }

    // Top categories in this wilaya by order volume
    const catAgg = catByWilaya.get(wilaya);
    const topCategories = catAgg
      ? Array.from(catAgg.categories.entries())
          .map(([category, c]) => ({ category, orders: c.orders }))
          .sort((a, b) => b.orders - a.orders)
          .slice(0, TOP_CATEGORY_LIMIT)
      : [];

    result.push({
      wilaya,
      totalShipments: agg.total,
      deliveredShipments: agg.delivered,
      returnedShipments: agg.returned,
      refusedShipments: agg.refused,
      noAnswerShipments: agg.noAnswer,
      deliverySuccessRate,
      grossRevenueDzd,
      avgCodAmountDzd,
      avgDeliveryTimeDays,
      bestProvider,
      bestProviderSuccessRate,
      providerBreakdown,
      topCategories,
    });
  }

  // Sort by total shipments descending, cap at TOP_WILAYA_LIMIT
  return result
    .sort((a, b) => b.totalShipments - a.totalShipments)
    .slice(0, TOP_WILAYA_LIMIT);
}
