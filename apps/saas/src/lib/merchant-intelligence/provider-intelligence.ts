// provider-intelligence.ts
//
// Delivery provider comparison derived from merchant_shipment_history.
// Computes success rate, return rate, average delivery time, and COD
// collection rate per provider, with a wilaya breakdown for each.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProviderIntel, WilayaStat } from "./types";

const SHIPMENT_SAMPLE = 15000;
const MIN_ORDERS_FOR_WILAYA_RANKING = 5;
const TOP_WILAYA_LIMIT = 5;

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

// ── Row type ──────────────────────────────────────────────────────────────────

type ShipmentRow = {
  merchant_id: string | null;
  provider: string | null;
  normalized_outcome: string | null;
  cod_amount: number | null;
  payment_status: string | null;
  wilaya_name: string | null;
  date_expedition: string | null;
  date_last_status: string | null;
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function getProviderIntelligence(
  supabase: SupabaseClient,
): Promise<ProviderIntel[]> {
  const { data, error } = await supabase
    .from("merchant_shipment_history")
    .select("merchant_id, provider, normalized_outcome, cod_amount, payment_status, wilaya_name, date_expedition, date_last_status")
    .not("provider", "is", null)
    .order("date_creation", { ascending: false })
    .limit(SHIPMENT_SAMPLE);

  if (error) throw error;

  const shipments = (data ?? []) as ShipmentRow[];

  // ── Aggregate by provider ─────────────────────────────────────────────────

  type ProviderAgg = {
    total: number;
    delivered: number;
    returned: number;
    refused: number;
    noAnswer: number;
    pending: number;
    codCount: number;
    codPaid: number;
    deliveryTimeSumDays: number;
    deliveryTimeCount: number;
    merchants: Set<string>;
    wilayas: Map<string, { total: number; delivered: number; revenue: number }>;
  };

  const byProvider = new Map<string, ProviderAgg>();

  for (const s of shipments) {
    const provider = s.provider?.trim();
    if (!provider) continue;

    if (!byProvider.has(provider)) {
      byProvider.set(provider, {
        total: 0, delivered: 0, returned: 0, refused: 0, noAnswer: 0, pending: 0,
        codCount: 0, codPaid: 0,
        deliveryTimeSumDays: 0, deliveryTimeCount: 0,
        merchants: new Set(),
        wilayas: new Map(),
      });
    }

    const agg = byProvider.get(provider)!;
    const outcome = classifyOutcome(s.normalized_outcome);
    const cod = Math.max(0, Number(s.cod_amount ?? 0));

    agg.total++;
    if (outcome === "delivered") agg.delivered++;
    else if (outcome === "returned") agg.returned++;
    else if (outcome === "refused") agg.refused++;
    else if (outcome === "no_answer") agg.noAnswer++;
    else agg.pending++;

    if (cod > 0) { agg.codCount++; }
    if (s.payment_status === "payed" && cod > 0) agg.codPaid++;

    // Delivery time: date_expedition → date_last_status (delivered only)
    if (s.date_expedition && s.date_last_status && outcome === "delivered") {
      const diffMs = new Date(s.date_last_status).getTime() - new Date(s.date_expedition).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays >= 0 && diffDays <= 60) {
        agg.deliveryTimeSumDays += diffDays;
        agg.deliveryTimeCount++;
      }
    }

    if (s.merchant_id) agg.merchants.add(s.merchant_id);

    if (s.wilaya_name) {
      const w = agg.wilayas.get(s.wilaya_name) ?? { total: 0, delivered: 0, revenue: 0 };
      w.total++;
      if (outcome === "delivered") { w.delivered++; w.revenue += cod; }
      agg.wilayas.set(s.wilaya_name, w);
    }
  }

  // ── Build result array ────────────────────────────────────────────────────

  const result: ProviderIntel[] = [];

  for (const [provider, agg] of byProvider.entries()) {
    const terminal = agg.delivered + agg.returned + agg.refused + agg.noAnswer;
    const deliverySuccessRate = terminal > 0 ? agg.delivered / terminal : 0;
    const returnRate = terminal > 0 ? (agg.returned + agg.refused) / terminal : 0;
    const codSuccessRate = agg.codCount > 0 ? agg.codPaid / agg.codCount : 0;
    const avgDeliveryTimeDays =
      agg.deliveryTimeCount > 0
        ? Number((agg.deliveryTimeSumDays / agg.deliveryTimeCount).toFixed(1))
        : null;

    // Wilaya breakdown (minimum qualifying orders)
    const qualifiedWilayas: WilayaStat[] = Array.from(agg.wilayas.entries())
      .filter(([, w]) => w.total >= MIN_ORDERS_FOR_WILAYA_RANKING)
      .map(([wilaya, w]) => ({
        wilaya,
        orders: w.total,
        successRate: w.total > 0 ? w.delivered / w.total : 0,
        revenue: w.revenue,
      }));

    const topWilayas = [...qualifiedWilayas]
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, TOP_WILAYA_LIMIT);

    const worstWilayas = [...qualifiedWilayas]
      .sort((a, b) => a.successRate - b.successRate)
      .slice(0, TOP_WILAYA_LIMIT);

    result.push({
      provider,
      totalShipments: agg.total,
      deliveredShipments: agg.delivered,
      returnedShipments: agg.returned,
      refusedShipments: agg.refused,
      noAnswerShipments: agg.noAnswer,
      pendingShipments: agg.pending,
      deliverySuccessRate,
      returnRate,
      avgDeliveryTimeDays,
      codSuccessRate,
      merchantCount: agg.merchants.size,
      topWilayas,
      worstWilayas,
    });
  }

  // Sort by total shipments descending
  return result.sort((a, b) => b.totalShipments - a.totalShipments);
}
