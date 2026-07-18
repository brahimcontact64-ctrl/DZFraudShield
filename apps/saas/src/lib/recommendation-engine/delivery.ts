// Delivery recommendations.
//
// Signal sources:
//   MerchantIntelSummary[]  — per-merchant delivery stats
//   ProviderIntel[]          — platform-wide provider comparison
//   WilayaIntel[]            — wilaya-level best provider data

import type { MerchantIntelSummary, ProviderIntel, WilayaIntel } from "@/lib/merchant-intelligence/types";
import type { Recommendation, RecommendationPriority } from "./types";
import { calculateConfidence, rateSignalStrength } from "./scoring";
import {
  providerSwitchSavings,
  stopdeskSavings,
  confirmationCallSavings,
} from "./financial-impact";

let _id = 0;
function nextId(): string {
  return `del-${++_id}`;
}

export function resetDeliveryIds(): void {
  _id = 0;
}

const NOW = new Date().toISOString();

// ── Thresholds ─────────────────────────────────────────────────────────────────

const MIN_SHIPMENTS = 20;
const PROVIDER_ADVANTAGE_THRESHOLD = 0.15; // 15% better = recommend switch
const LOW_SUCCESS_FOR_STOPDESK     = 0.55; // below this → suggest stop desk
const HIGH_BLOCK_FOR_CONFIRMATION  = 0.20; // above this → suggest confirmation calls
const HIGH_RETURN_FOR_PREPAYMENT   = 0.45; // delivery success below this → prepayment
const MIN_PROVIDER_SHIPMENTS       = 20;   // providers need at least this many to compare

// ── Provider comparison (platform-wide) ───────────────────────────────────────

export function generateProviderSwitchRecommendations(
  providers: ProviderIntel[],
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  if (providers.length < 2) return recs;

  // Find the best-performing provider on the platform
  const qualified = providers.filter((p) => p.totalShipments >= MIN_PROVIDER_SHIPMENTS);
  if (qualified.length < 2) return recs;

  const best = qualified.reduce((a, b) =>
    a.deliverySuccessRate > b.deliverySuccessRate ? a : b,
  );

  for (const p of qualified) {
    if (p.provider === best.provider) continue;
    const diff = best.deliverySuccessRate - p.deliverySuccessRate;
    if (diff < PROVIDER_ADVANTAGE_THRESHOLD) continue;

    // Find merchants who primarily use this underperforming provider
    const affectedMerchants = summaries.filter(
      (m) => m.topProvider === p.provider && m.totalShipments >= MIN_SHIPMENTS,
    );

    for (const m of affectedMerchants) {
      const signal = rateSignalStrength(p.deliverySuccessRate, 0.65, 0.5);
      const confidence = calculateConfidence(m.totalShipments, signal);
      const savings = providerSwitchSavings(
        m.totalShipments,
        1 - m.deliverySuccessRate,
        best.deliverySuccessRate,
        m.avgBasketDzd || 2500,
      );
      const priority: RecommendationPriority = diff >= 0.25 ? "HIGH" : "MEDIUM";
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "delivery",
        type: "delivery_provider_switch",
        priority,
        title: `Switch ${m.name} from ${p.provider} to ${best.provider}`,
        description: `${p.provider} has a ${(p.deliverySuccessRate * 100).toFixed(1)}% platform delivery success rate. ${best.provider} achieves ${(best.deliverySuccessRate * 100).toFixed(1)}% — a ${(diff * 100).toFixed(1)}% advantage. ${m.name} currently uses ${p.provider} for ${m.totalShipments.toLocaleString()} shipments.`,
        reason: `Based on platform-wide shipment data, ${best.provider} consistently outperforms ${p.provider} by ${(diff * 100).toFixed(1)} percentage points in delivery success rate. This merchant is using the lower-performing provider.`,
        businessImpact: `Switching providers could improve delivery rate from ${(m.deliverySuccessRate * 100).toFixed(1)}% toward ${(best.deliverySuccessRate * 100).toFixed(1)}%, recovering lost COD revenue on failed deliveries.`,
        estimatedSavingsDzd: savings,
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: `Trial ${best.provider}`, description: `Run a parallel trial with ${best.provider} for 30 days, starting with 20% of new shipments.` },
          { label: "Compare wilaya coverage", description: "Verify that the preferred provider covers all active wilayas for this merchant." },
          { label: "Negotiate rates", description: "A higher-volume commitment to the better provider may reduce per-shipment cost." },
        ],
        provider: p.provider,
      });
    }
  }

  return recs;
}

// ── Stop desk vs home delivery ─────────────────────────────────────────────────

export function generateStopDeskRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.totalShipments < MIN_SHIPMENTS) continue;
    if (m.deliverySuccessRate >= LOW_SUCCESS_FOR_STOPDESK) continue;

    const returned = m.returnedShipments + m.refusedShipments;
    const signal = rateSignalStrength(m.deliverySuccessRate, 0.65, 0.45);
    const confidence = calculateConfidence(m.totalShipments, signal);
    const savings = stopdeskSavings(returned, m.avgBasketDzd || 2500);

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "delivery",
      type: "delivery_use_stopdesk",
      priority: m.deliverySuccessRate < 0.40 ? "HIGH" : "MEDIUM",
      title: `Offer stop desk delivery for ${m.name} to reduce returns`,
      description: `${m.name} has a ${(m.deliverySuccessRate * 100).toFixed(1)}% home delivery success rate with ${returned.toLocaleString()} returns/refusals across ${m.totalShipments.toLocaleString()} shipments. Stop desk delivery reduces return rates because customers collect at a convenient time.`,
      reason: `Home delivery in Algeria has elevated failure rates when customers aren't available or refuse at the door. Stop desk (click & collect) removes the failed-delivery-attempt problem and typically reduces returns by 10–15%.`,
      businessImpact: `With ${returned.toLocaleString()} returns at avg ${(m.avgBasketDzd || 2500).toFixed(0)} DZD, switching 30% of orders to stop desk could recover an estimated ${(savings / 1000).toFixed(0)}K DZD.`,
      estimatedSavingsDzd: savings,
      estimatedRevenueIncreaseDzd: 0,
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["merchant_shipment_history"],
      recommendedActions: [
        { label: "Enable stop desk option at checkout", description: "Offer customers the choice between home delivery and stop desk in the WooCommerce checkout." },
        { label: "Promote stop desk for repeat customers", description: "Repeat customers are more likely to use stop desk — target them specifically." },
        { label: "Trial stop desk in worst-performing wilayas", description: m.topWilayas.length > 0 ? `Consider ${m.topWilayas[m.topWilayas.length - 1]?.wilaya ?? "your worst wilaya"} as a pilot.` : "Start with the wilaya that has the highest return rate." },
      ],
    });
  }

  return recs;
}

// ── Confirmation calls ─────────────────────────────────────────────────────────

export function generateConfirmationCallRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.totalOrders < 10) continue;
    if (m.blockRate < HIGH_BLOCK_FOR_CONFIRMATION) continue;

    const signal = rateSignalStrength(1 - m.blockRate, 0.8, 0.6);
    const confidence = calculateConfidence(m.totalOrders, signal);
    const savings = confirmationCallSavings(m.totalOrders, m.blockRate, m.avgBasketDzd || 2500);

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "delivery",
      type: "delivery_confirmation_calls",
      priority: m.blockRate >= 0.35 ? "HIGH" : "MEDIUM",
      title: `Enable confirmation calls for ${m.name} — ${(m.blockRate * 100).toFixed(1)}% fraud risk`,
      description: `${m.blockedOrders.toLocaleString()} of ${m.totalOrders.toLocaleString()} orders were blocked by the fraud shield (${(m.blockRate * 100).toFixed(1)}%). Undetected fraudulent orders that slip through can be caught with a phone confirmation call before dispatch.`,
      reason: `A fraud block rate of ${(m.blockRate * 100).toFixed(1)}% indicates the merchant is attracting a significant proportion of fake or fraudulent orders. While the shield blocks many, a manual phone confirmation adds a human layer of verification.`,
      businessImpact: `Confirmation calls add ~2 minutes per order but can prevent returns and failed deliveries from orders that pass the automated shield. Estimated savings: ${(savings / 1000).toFixed(0)}K DZD.`,
      estimatedSavingsDzd: savings,
      estimatedRevenueIncreaseDzd: 0,
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["order_checks"],
      recommendedActions: [
        { label: "Enable confirmation call workflow", description: "Set up a call center or manual call process for orders above a risk threshold." },
        { label: "Prioritise calls on new customer orders", description: "New customers without a reputation history carry higher fraud risk." },
        { label: "Track confirmation-to-dispatch conversion", description: "Monitor what % of called orders proceed to dispatch vs get cancelled." },
      ],
    });
  }

  return recs;
}

// ── Partial prepayment ─────────────────────────────────────────────────────────

export function generatePrepaymentRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.totalShipments < MIN_SHIPMENTS) continue;
    // Require BOTH low delivery success AND low COD collection
    if (m.deliverySuccessRate >= HIGH_RETURN_FOR_PREPAYMENT) continue;
    if (m.codSuccessRate >= 0.6) continue;

    const signal = rateSignalStrength(m.deliverySuccessRate, 0.65, HIGH_RETURN_FOR_PREPAYMENT);
    const confidence = calculateConfidence(m.totalShipments, signal);
    const potentialRevenue = Math.round(
      (m.grossRevenueDzd - m.collectedRevenueDzd) * 0.25,
    );

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "delivery",
      type: "delivery_prepayment",
      priority: "MEDIUM",
      title: `Require partial prepayment for ${m.name} orders`,
      description: `${m.name} has a ${(m.deliverySuccessRate * 100).toFixed(1)}% delivery success rate and only ${(m.codSuccessRate * 100).toFixed(1)}% COD collection rate. Partial prepayment (20–30%) reduces risk for both merchant and delivery provider.`,
      reason: `When both delivery success and COD collection are low, pure COD exposes the merchant to compounding losses: failed deliveries + uncollected payments. A partial upfront payment changes the customer's commitment level and filters out non-serious orders.`,
      businessImpact: `Uncollected revenue: ${((m.grossRevenueDzd - m.collectedRevenueDzd) / 1000).toFixed(0)}K DZD. Even recovering 25% through prepayment would add ${(potentialRevenue / 1000).toFixed(0)}K DZD.`,
      estimatedSavingsDzd: 0,
      estimatedRevenueIncreaseDzd: potentialRevenue,
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["merchant_shipment_history"],
      recommendedActions: [
        { label: "Add 20–30% prepayment option at checkout", description: "Offer customers a discount incentive for prepaying a fraction of the order." },
        { label: "Target high-risk customers first", description: "Apply prepayment requirement specifically to customers with poor reputation scores." },
        { label: "Monitor order conversion impact", description: "Prepayment requirements may reduce total orders — track the net revenue effect." },
      ],
    });
  }

  return recs;
}

// ── Wilaya-based free shipping ─────────────────────────────────────────────────

export function generateFreeShippingRegionRecommendations(
  summaries: MerchantIntelSummary[],
  wilayas: WilayaIntel[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Find wilayas where platform delivery rate is very high
  const topWilayas = wilayas
    .filter((w) => w.deliverySuccessRate >= 0.80 && w.totalShipments >= 30)
    .sort((a, b) => b.deliverySuccessRate - a.deliverySuccessRate)
    .slice(0, 5);

  if (topWilayas.length === 0) return recs;

  const topWilayaNames = topWilayas.map((w) => w.wilaya).join(", ");

  // Recommend to merchants with mediocre overall rates who might benefit from wilaya-targeted promotions
  for (const m of summaries) {
    if (m.totalShipments < MIN_SHIPMENTS) continue;
    if (m.deliverySuccessRate < 0.50 || m.deliverySuccessRate > 0.80) continue;

    // Only suggest if the merchant doesn't already have great coverage in those wilayas
    const merchantTopWilayaNames = new Set(m.topWilayas.map((w) => w.wilaya));
    const overlapping = topWilayas.filter((w) => merchantTopWilayaNames.has(w.wilaya));
    if (overlapping.length === 0) continue;

    const best = overlapping[0];
    const confidence = calculateConfidence(best.totalShipments, 0.7);

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "delivery",
      type: "delivery_free_shipping_region",
      priority: "LOW",
      title: `Offer free delivery in ${best.wilaya} for ${m.name}`,
      description: `${best.wilaya} has a platform-wide delivery success rate of ${(best.deliverySuccessRate * 100).toFixed(1)}%. Offering free delivery there converts more orders and the high success rate ensures collected revenue.`,
      reason: `Free delivery in high-success-rate wilayas is a low-risk acquisition tool. The order is very likely to be delivered and payment collected. The shipping cost is partially offset by higher conversion rates.`,
      businessImpact: `Free shipping in ${best.wilaya} could increase orders there by 10–20%, generating incremental revenue at low return risk.`,
      estimatedSavingsDzd: 0,
      estimatedRevenueIncreaseDzd: Math.round(best.totalShipments * 0.15 * best.avgCodAmountDzd),
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["merchant_shipment_history"],
      recommendedActions: [
        { label: `Enable free shipping for ${best.wilaya}`, description: "Configure shipping profile to waive delivery fee for this wilaya." },
        { label: "Promote regionally", description: `Run targeted ads in ${best.wilaya} featuring free delivery offer.` },
      ],
      wilaya: best.wilaya,
    });
  }

  return recs;
}
