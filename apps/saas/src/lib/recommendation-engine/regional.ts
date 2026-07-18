// Regional intelligence recommendations.
//
// Signal sources:
//   WilayaIntel[] — platform-wide wilaya delivery performance
//   MerchantIntelSummary[] — per-merchant wilaya coverage
//
// Generates recommendations for:
//   - High-opportunity wilayas (strong delivery rates, underserved)
//   - High-risk wilayas (poor delivery rates, high returns)
//   - Emerging markets (low volume but improving signal)
//   - High-value wilayas (high COD amounts)

import type { WilayaIntel, MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { Recommendation } from "./types";
import { calculateConfidence, rateSignalStrength } from "./scoring";
import { regionalOpportunityRevenue, regionalRiskSavings } from "./financial-impact";

let _id = 0;
function nextId(): string {
  return `reg-${++_id}`;
}

export function resetRegionalIds(): void {
  _id = 0;
}

const NOW = new Date().toISOString();

// ── Thresholds ─────────────────────────────────────────────────────────────────

const OPPORTUNITY_SUCCESS_THRESHOLD = 0.78;  // success rate above this → opportunity
const RISK_SUCCESS_THRESHOLD        = 0.38;  // success rate below this → risk
const HIGH_VALUE_COD_THRESHOLD      = 3500;  // avg COD above this → high value
const MIN_SHIPMENTS_FOR_REGIONAL    = 20;    // minimum data to be meaningful
const MIN_SHIPMENTS_FOR_RISK        = 30;    // need more data to declare a risk
const EMERGING_MAX_SHIPMENTS        = 50;    // small volume but good signal
const EMERGING_MIN_SUCCESS          = 0.68;  // decent success in emerging market

// ── Platform-wide wilaya recommendations ──────────────────────────────────────

export function generateWilayaOpportunityRecommendations(
  wilayas: WilayaIntel[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const w of wilayas) {
    if (w.totalShipments < MIN_SHIPMENTS_FOR_REGIONAL) continue;

    // ── High opportunity ───────────────────────────────────────────────────
    if (w.deliverySuccessRate >= OPPORTUNITY_SUCCESS_THRESHOLD) {
      const signal = rateSignalStrength(w.deliverySuccessRate, OPPORTUNITY_SUCCESS_THRESHOLD, 0.6);
      const confidence = calculateConfidence(w.totalShipments, signal);
      const revenue = regionalOpportunityRevenue(
        w.totalShipments,
        w.deliverySuccessRate,
        w.avgCodAmountDzd,
      );

      recs.push({
        id: nextId(),
        merchantId: null,
        merchantName: null,
        category: "regional",
        type: "regional_opportunity",
        priority: w.deliverySuccessRate >= 0.90 ? "HIGH" : "MEDIUM",
        title: `${w.wilaya} — ${(w.deliverySuccessRate * 100).toFixed(1)}% delivery success rate`,
        description: `${w.wilaya} delivered ${w.deliveredShipments.toLocaleString()} of ${w.totalShipments.toLocaleString()} shipments. Avg COD amount: ${w.avgCodAmountDzd.toFixed(0)} DZD. Best delivery provider: ${w.bestProvider ?? "N/A"}.`,
        reason: `Delivery success rate of ${(w.deliverySuccessRate * 100).toFixed(1)}% is well above the platform opportunity threshold of ${(OPPORTUNITY_SUCCESS_THRESHOLD * 100).toFixed(0)}%. Merchants operating here have strong fundamentals for profitable growth.`,
        businessImpact: `Increasing platform-wide coverage in ${w.wilaya} could unlock ${(revenue / 1000).toFixed(0)}K DZD in additional delivered revenue.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: revenue,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: `Expand targeting to ${w.wilaya}`, description: `All merchants should consider including ${w.wilaya} in their ad targeting — it has strong delivery fundamentals.` },
          w.bestProvider
            ? { label: `Use ${w.bestProvider} in ${w.wilaya}`, description: `This provider achieves the best success rate in this wilaya (${w.bestProviderSuccessRate != null ? (w.bestProviderSuccessRate * 100).toFixed(1) + "%" : "top performer"}).` }
            : { label: "Verify provider coverage", description: "Ensure your delivery provider services this wilaya." },
          { label: `Focus on top categories in ${w.wilaya}`, description: w.topCategories.length > 0 ? `Top categories: ${w.topCategories.slice(0, 3).map((c) => c.category).join(", ")}.` : "Identify which of your product categories resonate in this market." },
        ],
        wilaya: w.wilaya,
        provider: w.bestProvider ?? undefined,
      });
    }

    // ── High risk ─────────────────────────────────────────────────────────
    if (
      w.deliverySuccessRate < RISK_SUCCESS_THRESHOLD &&
      w.totalShipments >= MIN_SHIPMENTS_FOR_RISK
    ) {
      const signal = rateSignalStrength(w.deliverySuccessRate, 0.55, RISK_SUCCESS_THRESHOLD);
      const confidence = calculateConfidence(w.totalShipments, signal);
      const savings = regionalRiskSavings(
        w.returnedShipments + w.refusedShipments,
        w.avgCodAmountDzd,
      );

      recs.push({
        id: nextId(),
        merchantId: null,
        merchantName: null,
        category: "regional",
        type: "regional_risk",
        priority: w.deliverySuccessRate < 0.25 ? "CRITICAL" : "HIGH",
        title: `${w.wilaya} is a high-risk delivery region — ${(w.deliverySuccessRate * 100).toFixed(1)}% success`,
        description: `${w.returnedShipments + w.refusedShipments} of ${w.totalShipments.toLocaleString()} shipments were returned or refused in ${w.wilaya}. Avg COD amount: ${w.avgCodAmountDzd.toFixed(0)} DZD. Best available provider: ${w.bestProvider ?? "N/A"}.`,
        reason: `Success rate of ${(w.deliverySuccessRate * 100).toFixed(1)}% is critically below the ${(RISK_SUCCESS_THRESHOLD * 100).toFixed(0)}% risk threshold. Shipping to this wilaya generates more return costs than collected revenue for most product types.`,
        businessImpact: `Reducing ad spend and shipments to ${w.wilaya} could save approximately ${(savings / 1000).toFixed(0)}K DZD in avoided return logistics costs.`,
        estimatedSavingsDzd: savings,
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: `Reduce ad targeting in ${w.wilaya}`, description: "Limit or exclude this wilaya from ad campaigns until root cause is identified." },
          { label: "Require confirmation calls for this wilaya", description: "Add an extra verification step before dispatching to this region." },
          { label: "Switch to stop desk delivery", description: "Stop desk eliminates failed home delivery attempts and reduces return rate." },
          w.bestProvider
            ? { label: `Trial ${w.bestProvider}`, description: `This provider has the best relative success rate in ${w.wilaya} — try routing shipments there.` }
            : { label: "Evaluate delivery provider options", description: "Current provider may not have strong coverage in this wilaya." },
        ],
        wilaya: w.wilaya,
        provider: w.bestProvider ?? undefined,
      });
    }

    // ── Emerging market ───────────────────────────────────────────────────
    if (
      w.deliverySuccessRate >= EMERGING_MIN_SUCCESS &&
      w.totalShipments >= MIN_SHIPMENTS_FOR_REGIONAL &&
      w.totalShipments <= EMERGING_MAX_SHIPMENTS
    ) {
      const confidence = calculateConfidence(w.totalShipments, 0.4);

      recs.push({
        id: nextId(),
        merchantId: null,
        merchantName: null,
        category: "regional",
        type: "regional_emerging",
        priority: "LOW",
        title: `${w.wilaya} shows early promise — ${(w.deliverySuccessRate * 100).toFixed(1)}% success on ${w.totalShipments} shipments`,
        description: `${w.wilaya} has a ${(w.deliverySuccessRate * 100).toFixed(1)}% delivery success rate based on ${w.totalShipments.toLocaleString()} shipments — a small but promising sample. This wilaya may be underserved and represent an emerging opportunity.`,
        reason: `Low volume combined with a good success rate suggests this market has potential but hasn't been targeted aggressively. Early movers in underserved wilayas can capture market share before competition increases.`,
        businessImpact: `If the success rate holds as volume grows, expanding into ${w.wilaya} could yield strong ROI at low competition levels.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: Math.round(w.totalShipments * 2 * w.deliverySuccessRate * w.avgCodAmountDzd * 0.1),
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: `Run a test campaign in ${w.wilaya}`, description: "Allocate 5–10% of ad budget to this wilaya for a 30-day test." },
          { label: "Start with best-performing products", description: "Lead with your highest-success-rate products to maximise early results." },
        ],
        wilaya: w.wilaya,
      });
    }

    // ── High value market ─────────────────────────────────────────────────
    if (
      w.avgCodAmountDzd >= HIGH_VALUE_COD_THRESHOLD &&
      w.deliverySuccessRate >= 0.55 &&
      w.totalShipments >= MIN_SHIPMENTS_FOR_REGIONAL
    ) {
      const confidence = calculateConfidence(w.totalShipments, 0.5);

      recs.push({
        id: nextId(),
        merchantId: null,
        merchantName: null,
        category: "regional",
        type: "regional_high_value",
        priority: "LOW",
        title: `${w.wilaya} has high average COD value — ${w.avgCodAmountDzd.toFixed(0)} DZD per shipment`,
        description: `Average COD amount in ${w.wilaya} is ${w.avgCodAmountDzd.toFixed(0)} DZD — above the ${HIGH_VALUE_COD_THRESHOLD} DZD high-value threshold. Delivery success is ${(w.deliverySuccessRate * 100).toFixed(1)}%. Customers in this wilaya are purchasing higher-value items.`,
        reason: `High COD amounts indicate purchasing power in this market. With a ${(w.deliverySuccessRate * 100).toFixed(1)}% success rate, this is a profitable segment worth prioritising with premium product offers.`,
        businessImpact: `Targeting this high-value wilaya with premium products maximises revenue per successful delivery.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: Math.round(w.totalShipments * 0.2 * w.deliverySuccessRate * w.avgCodAmountDzd),
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["merchant_shipment_history"],
        recommendedActions: [
          { label: `Promote premium products in ${w.wilaya}`, description: "Customers here have higher purchasing power — lead with higher-margin products." },
          { label: "Ensure reliable delivery", description: `Use ${w.bestProvider ?? "your best provider"} for this high-value market.` },
        ],
        wilaya: w.wilaya,
        provider: w.bestProvider ?? undefined,
      });
    }
  }

  return recs;
}

// ── Per-merchant regional coverage gap ───────────────────────────────────────

export function generateRegionalCoverageRecommendations(
  summaries: MerchantIntelSummary[],
  wilayas: WilayaIntel[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Top platform wilayas by success rate
  const topPlatformWilayas = wilayas
    .filter(
      (w) =>
        w.deliverySuccessRate >= OPPORTUNITY_SUCCESS_THRESHOLD &&
        w.totalShipments >= MIN_SHIPMENTS_FOR_REGIONAL,
    )
    .sort((a, b) => b.deliverySuccessRate - a.deliverySuccessRate)
    .slice(0, 10);

  if (topPlatformWilayas.length === 0) return recs;

  for (const m of summaries) {
    if (m.totalShipments < 20) continue;

    const merchantWilayaNames = new Set(m.topWilayas.map((w) => w.wilaya));

    // Find top platform wilayas the merchant isn't using
    const missingWilayas = topPlatformWilayas.filter(
      (w) => !merchantWilayaNames.has(w.wilaya),
    );

    if (missingWilayas.length === 0) continue;

    const best = missingWilayas[0];
    const confidence = calculateConfidence(best.totalShipments, 0.5);

    recs.push({
      id: nextId(),
      merchantId: m.merchantId,
      merchantName: m.name,
      category: "regional",
      type: "regional_opportunity",
      priority: "LOW",
      title: `${m.name} is missing ${best.wilaya} — a ${(best.deliverySuccessRate * 100).toFixed(1)}% success wilaya`,
      description: `${best.wilaya} has a ${(best.deliverySuccessRate * 100).toFixed(1)}% platform delivery success rate but ${m.name} doesn't appear to be targeting it. Expanding to high-performing wilayas reduces overall risk concentration.`,
      reason: `Merchant is currently concentrated in ${m.topWilayas.slice(0, 3).map((w) => w.wilaya).join(", ")}. Diversifying into high-success wilayas reduces the impact of performance dips in any single region.`,
      businessImpact: `Testing in ${best.wilaya} with a small budget allows the merchant to validate fit before committing to a larger allocation.`,
      estimatedSavingsDzd: 0,
      estimatedRevenueIncreaseDzd: Math.round(best.totalShipments * 0.1 * best.deliverySuccessRate * best.avgCodAmountDzd),
      confidenceScore: confidence,
      generatedAt: NOW,
      requiredDataSources: ["merchant_shipment_history"],
      recommendedActions: [
        { label: `Add ${best.wilaya} to ad targeting`, description: `Platform data shows ${(best.deliverySuccessRate * 100).toFixed(1)}% delivery success here. Test with 5% of budget.` },
        best.bestProvider
          ? { label: `Use ${best.bestProvider}`, description: `Best delivery provider for ${best.wilaya} on the platform.` }
          : { label: "Verify provider coverage", description: `Confirm your provider services ${best.wilaya}.` },
      ],
      wilaya: best.wilaya,
    });
  }

  return recs;
}
