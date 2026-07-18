// Forecast Engine — orchestrator for the Analytics AI module.
//
// Loads all platform intelligence data using existing services,
// then runs all analytics modules and returns a combined output.
//
// Data sources reused (no duplicate queries per call):
//   - getMerchantIntelligenceData  (merchants, orders, shipments, customers)
//   - getCategoryIntelligence      (marketing_product_order_lines)
//   - getWilayaIntelligence        (merchant_shipment_history by wilaya)
//   - getProviderIntelligence      (merchant_shipment_history by provider)

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMerchantIntelligenceData } from "@/lib/merchant-intelligence/merchant-overview";
import { getCategoryIntelligence } from "@/lib/merchant-intelligence/category-intelligence";
import { getWilayaIntelligence } from "@/lib/merchant-intelligence/wilaya-intelligence";
import { getProviderIntelligence } from "@/lib/merchant-intelligence/provider-intelligence";

import {
  buildPlatformSalesForecast,
  buildPlatformRevenueForecast,
  buildMerchantSalesForecasts,
  resetSalesForecastIds,
} from "./sales-forecast";
import {
  buildPlatformDeliveryForecast,
  buildCodRefusalForecast,
  buildReturnRateForecast,
  buildProviderDeliveryForecasts,
  resetDeliveryForecastIds,
} from "./delivery-forecast";
import { buildMerchantGrowthTrends, resetMerchantGrowthIds } from "./merchant-growth";
import { buildSeasonalPatterns, resetSeasonalIds } from "./seasonality";
import {
  buildCategoryTrends,
  buildWilayaTrends,
  buildProviderTrends,
  buildTopMerchantTrends,
  resetTrendIds,
} from "./trend-analysis";
import {
  detectMerchantAnomalies,
  detectCategoryAnomalies,
  detectWilayaAnomalies,
  detectProviderAnomalies,
  detectCodAnomalies,
  detectCancellationSpike,
  resetAnomalyIds,
} from "./anomaly-detection";
import { runBacktest } from "./backtesting";
import { evaluateDataQuality } from "./data-quality";
import type { AnalyticsAIOutput } from "./types";
import { mean } from "./math";

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateAnalyticsAI(
  supabase: SupabaseClient,
): Promise<AnalyticsAIOutput> {
  const generatedAt = new Date().toISOString();
  const now = new Date();

  // ── Reset all ID counters ────────────────────────────────────────────────
  resetSalesForecastIds();
  resetDeliveryForecastIds();
  resetMerchantGrowthIds();
  resetSeasonalIds();
  resetTrendIds();
  resetAnomalyIds();

  // ── Load all base data in parallel ───────────────────────────────────────
  const [
    { summaries },
    categories,
    wilayas,
    providers,
  ] = await Promise.all([
    getMerchantIntelligenceData(supabase),
    getCategoryIntelligence(supabase),
    getWilayaIntelligence(supabase),
    getProviderIntelligence(supabase),
  ]);

  // ── Sales forecasts ──────────────────────────────────────────────────────
  const salesForecasts = [
    buildPlatformSalesForecast(summaries, now),
    buildPlatformRevenueForecast(summaries, now),
    ...buildMerchantSalesForecasts(summaries, now, 8),
  ];

  // ── Delivery forecasts ───────────────────────────────────────────────────
  const deliveryForecasts = [
    buildPlatformDeliveryForecast(summaries, now),
    buildCodRefusalForecast(summaries, now),
    buildReturnRateForecast(summaries, now),
    ...buildProviderDeliveryForecasts(providers, now),
  ];

  // ── Trends ───────────────────────────────────────────────────────────────
  const trends = [
    ...buildTopMerchantTrends(summaries, 12),
    ...buildCategoryTrends(categories),
    ...buildWilayaTrends(wilayas),
    ...buildProviderTrends(providers),
    ...buildMerchantGrowthTrends(summaries),
  ];

  // ── Anomalies ─────────────────────────────────────────────────────────────
  const anomalies = [
    ...detectMerchantAnomalies(summaries),
    ...detectCategoryAnomalies(categories),
    ...detectWilayaAnomalies(wilayas),
    ...detectProviderAnomalies(providers),
    ...detectCodAnomalies(summaries),
    ...detectCancellationSpike(summaries),
  ];

  // Sort anomalies: critical first, then by financial impact desc
  const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
  anomalies.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return b.estimatedImpactDzd - a.estimatedImpactDzd;
  });

  // Sort trends: biggest movers first
  trends.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));

  // ── Seasonal patterns ─────────────────────────────────────────────────────
  const seasonal = buildSeasonalPatterns(summaries, now);

  // ── Backtesting ───────────────────────────────────────────────────────────
  const backtest = runBacktest(summaries);

  // ── Data quality ──────────────────────────────────────────────────────────
  const dataQualityReport = evaluateDataQuality(summaries, categories, wilayas, providers);

  // ── Data quality metrics ──────────────────────────────────────────────────
  const totalDataPoints = summaries.reduce((s, m) => s + m.totalOrders + m.totalShipments, 0);
  const platform = summaries.reduce<number[]>((acc, m) => {
    for (let i = 0; i < 12; i++) acc[i] = (acc[i] ?? 0) + (m.orderTrend[i] ?? 0);
    return acc;
  }, new Array<number>(12).fill(0));
  const avgPlatformOrdersPerMonth = Math.round(mean(platform));

  return {
    salesForecasts,
    deliveryForecasts,
    anomalies,
    trends,
    seasonal,
    backtest,
    dataQualityReport,
    generatedAt,
    dataQuality: {
      merchantsAnalyzed: summaries.length,
      monthsOfHistory: 12,
      totalDataPoints,
      avgPlatformOrdersPerMonth,
    },
  };
}
