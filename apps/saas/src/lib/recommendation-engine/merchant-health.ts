// Merchant health recommendations.
// Input: MerchantIntelSummary[] from the merchant intelligence service.
// Generates per-merchant recommendations for growth, fraud, delivery decline, and COD issues.

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { Recommendation, RecommendationPriority } from "./types";
import { calculateConfidence, growthSignalStrength, rateSignalStrength } from "./scoring";
import {
  fraudSpikeSavings,
  growthMerchantRevenue,
  confirmationCallSavings,
} from "./financial-impact";

let _id = 0;
function nextId(): string {
  return `mh-${++_id}`;
}

export function resetMerchantHealthIds(): void {
  _id = 0;
}

const NOW = new Date().toISOString();

// ── Thresholds ────────────────────────────────────────────────────────────────

const MIN_ORDERS_FOR_HEALTH = 10;
const MIN_SHIPMENTS_FOR_DELIVERY = 20;

const FRAUD_SPIKE_WARN     = 0.25;
const FRAUD_SPIKE_CRITICAL = 0.40;

const DELIVERY_DECLINE_WARN     = 0.50;
const DELIVERY_DECLINE_CRITICAL = 0.35;

const COD_REFUSAL_THRESHOLD = 0.45;

const GROWTH_THRESHOLD  =  0.20;
const DECLINE_THRESHOLD = -0.20;

const HEALTH_SCORE_ATTENTION = 50;

// ── Main export ───────────────────────────────────────────────────────────────

export function generateMerchantHealthRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    // ── Merchant growing ────────────────────────────────────────────────────
    if (m.orderGrowthRate >= GROWTH_THRESHOLD && m.totalOrders >= MIN_ORDERS_FOR_HEALTH) {
      const signal = growthSignalStrength(m.orderGrowthRate);
      const confidence = calculateConfidence(m.totalOrders, signal);
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "merchant_health",
        type: "merchant_growing",
        priority: m.orderGrowthRate >= 0.4 ? "HIGH" : "MEDIUM",
        title: `${m.name} is growing rapidly — capitalise now`,
        description: `Order volume grew ${(m.orderGrowthRate * 100).toFixed(1)}% month-over-month. Current delivery success rate is ${(m.deliverySuccessRate * 100).toFixed(1)}%. There is an opportunity to amplify this growth with targeted action.`,
        reason: `Month-over-month order growth of +${(m.orderGrowthRate * 100).toFixed(1)}% over ${m.totalOrders.toLocaleString()} total orders. Platform average for comparison: consider increasing ad spend and ensuring logistics are ready to scale.`,
        businessImpact: `Growing merchant with ${(m.grossRevenueDzd / 1000).toFixed(0)}K DZD gross revenue. Additional support could unlock further revenue growth.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: growthMerchantRevenue(m.grossRevenueDzd, m.orderGrowthRate),
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["order_checks"],
        recommendedActions: [
          { label: "Review ad spend", description: "Increase advertising budget proportionally to the growth rate." },
          { label: "Verify logistics capacity", description: "Ensure the delivery provider can handle higher volume without quality degradation." },
          { label: "Monitor delivery success rate", description: `Current delivery rate is ${(m.deliverySuccessRate * 100).toFixed(1)}% — watch for degradation under increased volume.` },
        ],
      });
    }

    // ── Merchant declining ──────────────────────────────────────────────────
    if (m.orderGrowthRate <= DECLINE_THRESHOLD && m.totalOrders >= MIN_ORDERS_FOR_HEALTH) {
      const signal = growthSignalStrength(m.orderGrowthRate);
      const confidence = calculateConfidence(m.totalOrders, signal);
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "merchant_health",
        type: "merchant_needs_attention",
        priority: m.orderGrowthRate <= -0.4 ? "HIGH" : "MEDIUM",
        title: `${m.name} order volume is declining — investigation required`,
        description: `Order volume dropped ${Math.abs(m.orderGrowthRate * 100).toFixed(1)}% month-over-month. Revenue growth rate: ${(m.revenueGrowthRate * 100).toFixed(1)}%. Delivery success: ${(m.deliverySuccessRate * 100).toFixed(1)}%.`,
        reason: `MoM decline of ${(m.orderGrowthRate * 100).toFixed(1)}% across ${m.totalOrders.toLocaleString()} total orders. Combined with a block rate of ${(m.blockRate * 100).toFixed(1)}%, this may indicate conversion issues or fraud suppressing legitimate orders.`,
        businessImpact: `Revenue dropped from previous period. Gross COD revenue currently at ${(m.grossRevenueDzd / 1000).toFixed(0)}K DZD.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["order_checks"],
        recommendedActions: [
          { label: "Review fraud settings", description: `Block rate is ${(m.blockRate * 100).toFixed(1)}%. Loosen only if confident; tighten if fraud is causing decline.` },
          { label: "Audit ad campaigns", description: "Declining orders may indicate poor ad performance or seasonal slowdown." },
          { label: "Check product catalog", description: "Verify products are still active and competitively priced." },
        ],
      });
    }

    // ── Health score low ────────────────────────────────────────────────────
    if (m.scores.health < HEALTH_SCORE_ATTENTION && m.totalOrders >= MIN_ORDERS_FOR_HEALTH) {
      const signal = rateSignalStrength(m.scores.health / 100, 0.6, 0.4);
      const confidence = calculateConfidence(m.totalOrders, signal);
      const priority: RecommendationPriority = m.scores.health < 30 ? "HIGH" : "MEDIUM";
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "merchant_health",
        type: "merchant_needs_attention",
        priority,
        title: `${m.name} merchant health score is low (${m.scores.health}/100)`,
        description: `Health score ${m.scores.health}/100. Delivery score: ${m.scores.delivery}/100. Trust score: ${m.scores.trust}/100. All three signals are below expected thresholds.`,
        reason: `Health score combines delivery success rate (${(m.deliverySuccessRate * 100).toFixed(1)}%) and fraud block rate (${(m.blockRate * 100).toFixed(1)}%). Both are pulling the score below 50.`,
        businessImpact: `A low health score correlates with poor customer experience, high return costs, and potential subscription churn.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["order_checks", "merchant_shipment_history"],
        recommendedActions: [
          { label: "Reduce fraud exposure", description: "Tighten order verification to lower the block rate." },
          { label: "Improve delivery", description: `Delivery success rate of ${(m.deliverySuccessRate * 100).toFixed(1)}% is below platform expectations.` },
          { label: "Switch or audit provider", description: "Consider benchmarking current provider against platform alternatives." },
        ],
      });
    }

    // ── Fraud spike ─────────────────────────────────────────────────────────
    if (m.blockRate >= FRAUD_SPIKE_WARN && m.totalOrders >= MIN_ORDERS_FOR_HEALTH) {
      const isCritical = m.blockRate >= FRAUD_SPIKE_CRITICAL;
      const signal = rateSignalStrength(1 - m.blockRate, 1 - FRAUD_SPIKE_WARN, 1 - FRAUD_SPIKE_CRITICAL);
      const confidence = calculateConfidence(m.totalOrders, signal);
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "merchant_health",
        type: "merchant_fraud_spike",
        priority: isCritical ? "CRITICAL" : "HIGH",
        title: `${m.name} fraud block rate at ${(m.blockRate * 100).toFixed(1)}%`,
        description: `${m.blockedOrders.toLocaleString()} of ${m.totalOrders.toLocaleString()} orders were blocked by the fraud shield. This is ${isCritical ? "critically" : "significantly"} above the 15% advisory threshold.`,
        reason: `Elevated block rate may indicate competitor ad fraud, fake order campaigns, or data quality issues in the product catalog. ${isCritical ? "Immediate manual review is recommended." : ""}`,
        businessImpact: `Blocked orders reduce revenue and increase support burden. If some blocks are false positives, the merchant is losing legitimate revenue.`,
        estimatedSavingsDzd: fraudSpikeSavings(m.blockedOrders, m.avgBasketDzd),
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["order_checks"],
        recommendedActions: [
          { label: "Manual review of recent blocks", description: "Inspect blocked orders from the last 7 days to identify patterns." },
          { label: "Adjust risk thresholds", description: "If false positives are high, consider loosening the BLOCK threshold." },
          { label: "Audit traffic sources", description: "Identify which ad channels are generating the most fraud." },
        ],
      });
    }

    // ── Delivery decline ────────────────────────────────────────────────────
    if (
      m.deliverySuccessRate < DELIVERY_DECLINE_WARN &&
      m.totalShipments >= MIN_SHIPMENTS_FOR_DELIVERY
    ) {
      const isCritical = m.deliverySuccessRate < DELIVERY_DECLINE_CRITICAL;
      const signal = rateSignalStrength(m.deliverySuccessRate, 0.65, DELIVERY_DECLINE_CRITICAL);
      const confidence = calculateConfidence(m.totalShipments, signal);
      const returned = m.returnedShipments + m.refusedShipments;
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "merchant_health",
        type: "merchant_delivery_decline",
        priority: isCritical ? "CRITICAL" : "HIGH",
        title: `${m.name} delivery success at ${(m.deliverySuccessRate * 100).toFixed(1)}%`,
        description: `${m.deliveredShipments.toLocaleString()} delivered out of ${m.totalShipments.toLocaleString()} shipments. ${returned.toLocaleString()} returned or refused. Provider in use: ${m.topProvider ?? "unknown"}.`,
        reason: `Delivery success rate of ${(m.deliverySuccessRate * 100).toFixed(1)}% is below the ${(DELIVERY_DECLINE_WARN * 100).toFixed(0)}% advisory threshold. High return rates erode COD revenue and increase logistics costs.`,
        businessImpact: `Each failed delivery costs return shipping + lost COD. At ${returned.toLocaleString()} returns with avg basket of ${m.avgBasketDzd.toFixed(0)} DZD, the merchant is losing significant revenue to returns.`,
        estimatedSavingsDzd: Math.round(returned * (m.avgBasketDzd || 2500) * 0.15),
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: "Audit delivery provider", description: `${m.topProvider ?? "Current provider"} performance for this merchant needs review.` },
          { label: "Enable confirmation calls", description: "Manual customer confirmation before dispatch reduces fake orders and reduces returns." },
          { label: "Review wilaya targeting", description: "Restrict shipments to wilayas with historically higher delivery success." },
        ],
      });
    }

    // ── COD refusal ─────────────────────────────────────────────────────────
    if (m.codSuccessRate < COD_REFUSAL_THRESHOLD && m.totalShipments >= MIN_SHIPMENTS_FOR_DELIVERY) {
      const signal = rateSignalStrength(m.codSuccessRate, 0.65, COD_REFUSAL_THRESHOLD);
      const confidence = calculateConfidence(m.totalShipments, signal);
      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "merchant_health",
        type: "merchant_cod_refusal",
        priority: m.codSuccessRate < 0.3 ? "HIGH" : "MEDIUM",
        title: `${m.name} COD collection rate is only ${(m.codSuccessRate * 100).toFixed(1)}%`,
        description: `Only ${(m.codSuccessRate * 100).toFixed(1)}% of delivered orders had their COD payment collected. Gross revenue: ${(m.grossRevenueDzd / 1000).toFixed(0)}K DZD. Collected: ${(m.collectedRevenueDzd / 1000).toFixed(0)}K DZD.`,
        reason: `Low COD collection suggests customers are refusing to pay at the door or delivery agents are not processing payments correctly. Both scenarios represent direct revenue loss.`,
        businessImpact: `The gap between gross revenue (${(m.grossRevenueDzd / 1000).toFixed(0)}K DZD) and collected revenue (${(m.collectedRevenueDzd / 1000).toFixed(0)}K DZD) represents ${((m.grossRevenueDzd - m.collectedRevenueDzd) / 1000).toFixed(0)}K DZD in uncollected payments.`,
        estimatedSavingsDzd: Math.round((m.grossRevenueDzd - m.collectedRevenueDzd) * 0.20),
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: "Require partial prepayment", description: "Collecting even 20–30% upfront significantly reduces COD refusal." },
          { label: "Audit delivery agents", description: "Low collection may indicate agent-level issues rather than customer refusals." },
          { label: "Improve product quality description", description: "Mismatched expectations at delivery cause refusals." },
        ],
      });
    }
  }

  return recs;
}
