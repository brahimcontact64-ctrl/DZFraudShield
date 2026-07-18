// Recommendation Engine — main orchestrator.
//
// This module coordinates all sub-modules, merges their output, deduplicates,
// and returns a sorted, typed recommendation list ready for the admin dashboard.
//
// Architecture principles:
//   - All data loading happens here (single source of truth)
//   - Sub-modules receive already-computed data (no duplicate queries)
//   - Products module makes one additional query (marketing_product_statistics)
//   - All ID counters are reset per engine run to ensure deterministic IDs

import type { SupabaseClient } from "@supabase/supabase-js";
import { getMerchantIntelligenceData } from "@/lib/merchant-intelligence/merchant-overview";
import { getCategoryIntelligence } from "@/lib/merchant-intelligence/category-intelligence";
import { getWilayaIntelligence } from "@/lib/merchant-intelligence/wilaya-intelligence";
import { getProviderIntelligence } from "@/lib/merchant-intelligence/provider-intelligence";

import {
  generateMerchantHealthRecommendations,
  resetMerchantHealthIds,
} from "./merchant-health";
import {
  generateCategoryAdvertisingRecommendations,
  generateMerchantWilayaAdvertisingRecommendations,
  resetAdvertisingIds,
} from "./advertising";
import {
  generateProviderSwitchRecommendations,
  generateStopDeskRecommendations,
  generateConfirmationCallRecommendations,
  generatePrepaymentRecommendations,
  generateFreeShippingRegionRecommendations,
  resetDeliveryIds,
} from "./delivery";
import { generateProductRecommendations, resetProductIds } from "./products";
import {
  generateCodPriceRecommendations,
  generateFreeShippingThresholdRecommendations,
  generateMarginRecommendations,
  generateReduceDiscountRecommendations,
  resetPricingIds,
} from "./pricing";
import {
  generateWilayaOpportunityRecommendations,
  generateRegionalCoverageRecommendations,
  resetRegionalIds,
} from "./regional";
import { generateCustomerRecommendations, resetCustomerIds } from "./customer";

import type {
  Recommendation,
  RecommendationCategory,
  RecommendationEngineOutput,
  RecommendationPriority,
} from "./types";

// ── Priority sort order ───────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<RecommendationPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateRecommendations(
  supabase: SupabaseClient,
): Promise<RecommendationEngineOutput> {
  const generatedAt = new Date().toISOString();

  // ── Reset all ID counters (deterministic per run) ─────────────────────────
  resetMerchantHealthIds();
  resetAdvertisingIds();
  resetDeliveryIds();
  resetProductIds();
  resetPricingIds();
  resetRegionalIds();
  resetCustomerIds();

  // ── Load all base data in parallel ───────────────────────────────────────

  const [
    { summaries, platform: _platform },
    categories,
    wilayas,
    providers,
  ] = await Promise.all([
    getMerchantIntelligenceData(supabase),
    getCategoryIntelligence(supabase),
    getWilayaIntelligence(supabase),
    getProviderIntelligence(supabase),
  ]);

  // ── Run all modules ───────────────────────────────────────────────────────

  const [
    merchantHealthRecs,
    categoryAdRecs,
    wilayaAdRecs,
    providerSwitchRecs,
    stopDeskRecs,
    confirmationCallRecs,
    prepaymentRecs,
    freeShippingRegionRecs,
    productRecs,
    codPriceRecs,
    freeShippingThresholdRecs,
    marginRecs,
    discountRecs,
    wilayaOpportunityRecs,
    regionalCoverageRecs,
    customerRecs,
  ] = await Promise.all([
    // Merchant health
    Promise.resolve(generateMerchantHealthRecommendations(summaries)),
    // Advertising
    Promise.resolve(generateCategoryAdvertisingRecommendations(categories)),
    Promise.resolve(generateMerchantWilayaAdvertisingRecommendations(summaries)),
    // Delivery
    Promise.resolve(generateProviderSwitchRecommendations(providers, summaries)),
    Promise.resolve(generateStopDeskRecommendations(summaries)),
    Promise.resolve(generateConfirmationCallRecommendations(summaries)),
    Promise.resolve(generatePrepaymentRecommendations(summaries)),
    Promise.resolve(generateFreeShippingRegionRecommendations(summaries, wilayas)),
    // Products (async — makes a DB query)
    generateProductRecommendations(supabase, summaries),
    // Pricing
    Promise.resolve(generateCodPriceRecommendations(summaries)),
    Promise.resolve(generateFreeShippingThresholdRecommendations(summaries)),
    Promise.resolve(generateMarginRecommendations(summaries, categories)),
    Promise.resolve(generateReduceDiscountRecommendations(summaries)),
    // Regional
    Promise.resolve(generateWilayaOpportunityRecommendations(wilayas)),
    Promise.resolve(generateRegionalCoverageRecommendations(summaries, wilayas)),
    // Customer
    Promise.resolve(generateCustomerRecommendations(summaries)),
  ]);

  // ── Merge all recommendations ─────────────────────────────────────────────

  const all: Recommendation[] = [
    ...merchantHealthRecs,
    ...categoryAdRecs,
    ...wilayaAdRecs,
    ...providerSwitchRecs,
    ...stopDeskRecs,
    ...confirmationCallRecs,
    ...prepaymentRecs,
    ...freeShippingRegionRecs,
    ...productRecs,
    ...codPriceRecs,
    ...freeShippingThresholdRecs,
    ...marginRecs,
    ...discountRecs,
    ...wilayaOpportunityRecs,
    ...regionalCoverageRecs,
    ...customerRecs,
  ];

  // ── Sort: priority → confidence (desc) → estimated financial impact (desc) ─

  all.sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    const c = b.confidenceScore - a.confidenceScore;
    if (c !== 0) return c;
    const fa = a.estimatedSavingsDzd + a.estimatedRevenueIncreaseDzd;
    const fb = b.estimatedSavingsDzd + b.estimatedRevenueIncreaseDzd;
    return fb - fa;
  });

  // ── Build summary ─────────────────────────────────────────────────────────

  const categoryCounts: Record<RecommendationCategory, number> = {
    advertising: 0,
    delivery: 0,
    products: 0,
    pricing: 0,
    merchant_health: 0,
    regional: 0,
    customer: 0,
  };

  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  let totalSavings = 0;
  let totalRevenue = 0;

  for (const r of all) {
    categoryCounts[r.category]++;
    if (r.priority === "CRITICAL") criticalCount++;
    else if (r.priority === "HIGH") highCount++;
    else if (r.priority === "MEDIUM") mediumCount++;
    else lowCount++;
    totalSavings += r.estimatedSavingsDzd;
    totalRevenue += r.estimatedRevenueIncreaseDzd;
  }

  const merchantsAnalyzed = summaries.length;

  return {
    recommendations: all,
    summary: {
      totalRecommendations: all.length,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      totalEstimatedSavingsDzd: Math.round(totalSavings),
      totalEstimatedRevenueDzd: Math.round(totalRevenue),
      merchantsAnalyzed,
      categoryCounts,
      generatedAt,
    },
  };
}
