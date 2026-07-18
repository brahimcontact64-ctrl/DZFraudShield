// Strategy Engine orchestrator.
//
// Loads all intelligence data, builds per-merchant strategies,
// and packages simulator-ready data for the admin UI.
//
// Data sources (no duplicate queries):
//   - getMerchantIntelligenceData (merchants, subscriptions, orders, shipments, customers)
//   - getCategoryIntelligence     (marketing_product_order_lines)
//   - getWilayaIntelligence       (merchant_shipment_history by wilaya)
//   - getProviderIntelligence     (merchant_shipment_history by provider)

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMerchantIntelligenceData } from "@/lib/merchant-intelligence/merchant-overview";
import { getCategoryIntelligence } from "@/lib/merchant-intelligence/category-intelligence";
import { getWilayaIntelligence } from "@/lib/merchant-intelligence/wilaya-intelligence";
import { getProviderIntelligence } from "@/lib/merchant-intelligence/provider-intelligence";
import { buildMerchantStrategy } from "./merchant-consultant";
import type {
  StrategyEngineOutput,
  SimulatorMerchantData,
  SimulatorProviderData,
  SimulatorWilayaData,
} from "./types";

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateStrategy(supabase: SupabaseClient): Promise<StrategyEngineOutput> {
  const generatedAt = new Date().toISOString();

  const [{ summaries }, categories, wilayas, providers] = await Promise.all([
    getMerchantIntelligenceData(supabase),
    getCategoryIntelligence(supabase),
    getWilayaIntelligence(supabase),
    getProviderIntelligence(supabase),
  ]);

  const merchantStrategies = summaries
    .filter((m) => m.totalOrders >= 5)
    .map((m) => buildMerchantStrategy(m, providers, wilayas, categories));

  merchantStrategies.sort((a, b) => {
    const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
    const p = PRIORITY_ORDER[a.strategicPriority] - PRIORITY_ORDER[b.strategicPriority];
    if (p !== 0) return p;
    return b.overallHealthScore - a.overallHealthScore;
  });

  return { merchantStrategies, generatedAt, merchantsAnalyzed: summaries.length };
}

export type StrategyPageData = StrategyEngineOutput & {
  simulatorMerchants: SimulatorMerchantData[];
  simulatorProviders: SimulatorProviderData[];
  simulatorWilayas: SimulatorWilayaData[];
};

// Loads all intelligence data once and returns both strategies and simulator
// data. Avoids duplicate DB queries compared to calling generateStrategy +
// a separate data fetch.
export async function generateStrategyWithSimulatorData(
  supabase: SupabaseClient,
): Promise<StrategyPageData> {
  const generatedAt = new Date().toISOString();

  const [{ summaries }, categories, wilayas, providers] = await Promise.all([
    getMerchantIntelligenceData(supabase),
    getCategoryIntelligence(supabase),
    getWilayaIntelligence(supabase),
    getProviderIntelligence(supabase),
  ]);

  const eligible = summaries.filter((m) => m.totalOrders >= 5);

  const merchantStrategies = eligible.map((m) =>
    buildMerchantStrategy(m, providers, wilayas, categories),
  );

  merchantStrategies.sort((a, b) => {
    const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
    const p = PRIORITY_ORDER[a.strategicPriority] - PRIORITY_ORDER[b.strategicPriority];
    if (p !== 0) return p;
    return b.overallHealthScore - a.overallHealthScore;
  });

  const simulatorMerchants: SimulatorMerchantData[] = eligible.map((m) => ({
    merchantId: m.merchantId,
    merchantName: m.name,
    totalOrders: m.totalOrders,
    totalShipments: m.totalShipments,
    deliverySuccessRate: m.deliverySuccessRate,
    codSuccessRate: m.codSuccessRate,
    blockRate: m.blockRate,
    avgBasketDzd: m.avgBasketDzd,
    grossRevenueDzd: m.grossRevenueDzd,
    topProvider: m.topProvider,
    topWilayas: m.topWilayas.map((w) => ({
      wilaya: w.wilaya,
      orders: w.orders,
      successRate: w.successRate,
      revenue: w.revenue,
    })),
  }));

  const simulatorProviders: SimulatorProviderData[] = providers.map((p) => ({
    provider: p.provider,
    deliverySuccessRate: p.deliverySuccessRate,
    totalShipments: p.totalShipments,
  }));

  const simulatorWilayas: SimulatorWilayaData[] = wilayas.map((w) => ({
    wilaya: w.wilaya,
    deliverySuccessRate: w.deliverySuccessRate,
    totalShipments: w.totalShipments,
    avgCodAmountDzd: w.avgCodAmountDzd,
  }));

  return {
    merchantStrategies,
    generatedAt,
    merchantsAnalyzed: summaries.length,
    simulatorMerchants,
    simulatorProviders,
    simulatorWilayas,
  };
}
