// Pricing recommendations.
//
// Signal sources:
//   MerchantIntelSummary[] — revenue, basket size, COD collection
//   CategoryIntel[]         — category-level average order values
//
// Generates recommendations for:
//   - Increasing COD price when demand is strong and margins allow
//   - Reducing discount campaigns when returns are high
//   - Raising free shipping threshold to improve basket size
//   - Improving margin through pricing optimisation

import type { MerchantIntelSummary, CategoryIntel } from "@/lib/merchant-intelligence/types";
import type { Recommendation } from "./types";
import { calculateConfidence, rateSignalStrength } from "./scoring";
import { codPriceIncreaseSavingsRevenue } from "./financial-impact";

let _id = 0;
function nextId(): string {
  return `pri-${++_id}`;
}

export function resetPricingIds(): void {
  _id = 0;
}

const NOW = new Date().toISOString();

// ── Thresholds ─────────────────────────────────────────────────────────────────

const MIN_ORDERS_FOR_PRICING       = 20;
const HIGH_SUCCESS_FOR_COD_RAISE   = 0.70; // can raise prices when delivery rate is strong
const LOW_BASKET_THRESHOLD_DZD     = 1500; // avg basket below this → raise threshold suggestion
const HIGH_BASKET_THRESHOLD_DZD    = 8000; // avg basket above this → good margin signal
const LOW_COD_COLLECTION           = 0.55; // COD collection below this → investigate
const GOOD_GROWTH_FOR_PRICE_RAISE  = 0.15; // growing >15% → demand allows price increase

// ── COD price increase ────────────────────────────────────────────────────────

export function generateCodPriceRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.totalOrders < MIN_ORDERS_FOR_PRICING) continue;

    // Strong delivery + growing demand = room to raise prices
    const canRaise =
      m.deliverySuccessRate >= HIGH_SUCCESS_FOR_COD_RAISE &&
      m.orderGrowthRate >= GOOD_GROWTH_FOR_PRICE_RAISE;

    if (!canRaise) continue;

    const signal = rateSignalStrength(m.deliverySuccessRate, HIGH_SUCCESS_FOR_COD_RAISE, 0.55);
    const confidence = calculateConfidence(m.totalOrders, signal);
    const priceIncreaseRate = 0.05; // conservative +5%
    const revenueGain = codPriceIncreaseSavingsRevenue(
      m.deliveredShipments,
      m.avgBasketDzd || 2500,
      priceIncreaseRate,
    );

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "pricing",
      type: "pricing_increase_cod",
      priority: "MEDIUM",
      title: `${m.name} can increase COD pricing by 5% — strong demand signal`,
      description: `${m.name} has a ${(m.deliverySuccessRate * 100).toFixed(1)}% delivery success rate and ${(m.orderGrowthRate * 100).toFixed(1)}% MoM order growth. High delivery success and growing demand provide pricing power. A modest 5% COD price increase is unlikely to significantly reduce conversion.`,
      reason: `When delivery success rate is above ${(HIGH_SUCCESS_FOR_COD_RAISE * 100).toFixed(0)}% and orders are growing at ${(m.orderGrowthRate * 100).toFixed(1)}%, customers have demonstrated strong product-market fit. This creates room for careful price optimisation.`,
      businessImpact: `A 5% COD price increase on ${m.deliveredShipments.toLocaleString()} delivered orders at avg ${(m.avgBasketDzd || 2500).toFixed(0)} DZD would generate an additional ${(revenueGain / 1000).toFixed(0)}K DZD revenue.`,
      estimatedSavingsDzd: 0,
      estimatedRevenueIncreaseDzd: revenueGain,
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["order_checks", "merchant_shipment_history"],
      recommendedActions: [
        { label: "Increase product prices by 5%", description: "Apply the increase across the product catalog, starting with best sellers." },
        { label: "Monitor conversion rate for 30 days", description: "Track whether order volume drops after the price increase." },
        { label: "A/B test on select products", description: "Test the price increase on high-performing products before rolling out catalog-wide." },
      ],
    });
  }

  return recs;
}

// ── Free shipping threshold ────────────────────────────────────────────────────

export function generateFreeShippingThresholdRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.totalOrders < MIN_ORDERS_FOR_PRICING) continue;

    // Low average basket = customers not adding enough to orders
    if (m.avgBasketDzd >= LOW_BASKET_THRESHOLD_DZD) continue;
    // Only suggest for merchants with acceptable delivery rates
    if (m.deliverySuccessRate < 0.55) continue;

    const confidence = calculateConfidence(m.totalOrders, 0.4);
    const suggestedThreshold = Math.ceil((m.avgBasketDzd * 1.4) / 100) * 100; // 40% above avg
    const upliftEstimate = Math.round(m.deliveredShipments * (m.avgBasketDzd * 0.2));

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "pricing",
      type: "pricing_free_shipping_threshold",
      priority: "LOW",
      title: `Set free shipping threshold at ${suggestedThreshold} DZD for ${m.name}`,
      description: `Average basket size is ${(m.avgBasketDzd || 0).toFixed(0)} DZD. Setting a free shipping threshold encourages customers to add more items to qualify, increasing average order value by 15–25%.`,
      reason: `Low average basket with a reasonable delivery success rate (${(m.deliverySuccessRate * 100).toFixed(1)}%) suggests customers are purchasing small amounts. A free shipping threshold incentivises larger baskets at no additional acquisition cost.`,
      businessImpact: `If 30% of customers increase their basket to meet the threshold, average order value could increase by ~20%, generating additional ${(upliftEstimate / 1000).toFixed(0)}K DZD revenue.`,
      estimatedSavingsDzd: 0,
      estimatedRevenueIncreaseDzd: upliftEstimate,
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["order_checks"],
      recommendedActions: [
        { label: `Set free shipping threshold at ${suggestedThreshold} DZD`, description: "Configure the WooCommerce shipping profile with this minimum order value." },
        { label: "Display threshold progress at checkout", description: "Show 'Add X DZD more for free shipping' messaging to encourage upselling." },
        { label: "Identify upsell products", description: "Highlight low-cost add-on products that help customers reach the threshold." },
      ],
    });
  }

  return recs;
}

// ── Margin improvement ────────────────────────────────────────────────────────

export function generateMarginRecommendations(
  summaries: MerchantIntelSummary[],
  categories: CategoryIntel[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Find categories with very high average order values (premium segment)
  const premiumCategories = categories.filter(
    (c) => c.avgOrderValueDzd >= HIGH_BASKET_THRESHOLD_DZD && c.deliverySuccessRate >= 0.60,
  );

  for (const m of summaries) {
    if (m.totalOrders < MIN_ORDERS_FOR_PRICING) continue;

    // Merchant has high basket but poor COD collection — price cut may not be the answer
    if (m.avgBasketDzd < HIGH_BASKET_THRESHOLD_DZD) continue;
    if (m.codSuccessRate >= 0.7) continue;

    const signal = rateSignalStrength(m.codSuccessRate, 0.7, LOW_COD_COLLECTION);
    const confidence = calculateConfidence(m.totalShipments, signal);
    const lostRevenue = m.grossRevenueDzd - m.collectedRevenueDzd;

    if (lostRevenue < 5000) continue; // not meaningful enough to recommend

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "pricing",
      type: "pricing_margin_improvement",
      priority: lostRevenue > 50000 ? "HIGH" : "MEDIUM",
      title: `${m.name} has ${(lostRevenue / 1000).toFixed(0)}K DZD in uncollected COD revenue`,
      description: `Gross COD: ${(m.grossRevenueDzd / 1000).toFixed(0)}K DZD. Collected: ${(m.collectedRevenueDzd / 1000).toFixed(0)}K DZD. COD collection rate: ${(m.codSuccessRate * 100).toFixed(1)}%. The gap suggests either refused COD at door or high average prices driving refusal.`,
      reason: `Large high-value orders are more likely to be refused at delivery because customers experience sticker shock. Breaking high-value orders into smaller bundles, or offering installment-style COD, can improve collection.`,
      businessImpact: `Recovering even 30% of the ${(lostRevenue / 1000).toFixed(0)}K DZD gap would add ${(lostRevenue * 0.3 / 1000).toFixed(0)}K DZD to collected revenue.`,
      estimatedSavingsDzd: 0,
      estimatedRevenueIncreaseDzd: Math.round(lostRevenue * 0.25),
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["merchant_shipment_history"],
      recommendedActions: [
        { label: "Split high-value orders", description: `High average basket of ${(m.avgBasketDzd || 0).toFixed(0)} DZD may cause COD refusal. Consider offering smaller product bundles.` },
        { label: "Offer partial online prepayment", description: "Collecting 20–30% upfront reduces COD risk while maintaining accessibility." },
        ...(premiumCategories.length > 0
          ? [{ label: `Review pricing in ${premiumCategories[0].categoryName}`, description: `This category has a high average order value. Check if pricing is competitive.` }]
          : []),
      ],
    });
  }

  return recs;
}

// ── Reduce discount campaigns ──────────────────────────────────────────────────

export function generateReduceDiscountRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.totalOrders < MIN_ORDERS_FOR_PRICING) continue;

    // Only recommend reducing discounts if:
    // - High block rate (discounts attracting fake orders)
    // - AND poor delivery success (low-quality customer base)
    if (m.blockRate < 0.20) continue;
    if (m.deliverySuccessRate >= 0.60) continue;

    const signal = rateSignalStrength(1 - m.blockRate, 0.8, 0.6);
    const confidence = calculateConfidence(m.totalOrders, signal);

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "pricing",
      type: "pricing_reduce_discount",
      priority: "MEDIUM",
      title: `${m.name} — reduce discount campaigns attracting low-quality orders`,
      description: `Block rate of ${(m.blockRate * 100).toFixed(1)}% combined with ${(m.deliverySuccessRate * 100).toFixed(1)}% delivery success suggests aggressive discounting is attracting fraudulent or non-serious buyers. Deep discount campaigns in COD markets tend to amplify fake order rates.`,
      reason: `Discount campaigns in COD markets attract orders from customers who never intend to pay — they order for the discount and refuse at delivery. A higher price point filters out these customers while maintaining serious buyers.`,
      businessImpact: `Reducing discount depth by 30–50% could cut the fraud rate significantly, improving net revenue even if total order count decreases.`,
      estimatedSavingsDzd: Math.round(m.blockedOrders * (m.avgBasketDzd || 2500) * 0.08),
      estimatedRevenueIncreaseDzd: 0,
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["order_checks"],
      recommendedActions: [
        { label: "Reduce discount depth by 30–50%", description: "High discounts in COD markets attract non-serious buyers. Moderate the offer." },
        { label: "Shift to free shipping offers", description: "Free shipping is a less abuse-prone incentive than cash discounts." },
        { label: "Limit discount offers to repeat customers", description: "Loyal customers are less likely to abuse discount campaigns." },
      ],
    });
  }

  return recs;
}
