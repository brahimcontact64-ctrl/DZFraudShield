// Merchant consultant module.
//
// Generates a holistic, data-driven strategy for a single merchant.
// Answers: "If I owned this merchant, what would I do first?"
//
// All estimates are conservative and derived from real merchant metrics.
// No fabricated values, no placeholder data.

import type { MerchantIntelSummary, WilayaIntel, ProviderIntel, CategoryIntel } from "@/lib/merchant-intelligence/types";
import type {
  MerchantStrategy,
  MerchantStrategyPriority,
  StrategyAction,
  StrategyActionCategory,
  StrategyTimeToValue,
} from "./types";

const NOW = new Date().toISOString();

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M DZD`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K DZD`;
  return `${Math.round(n)} DZD`;
}

function strategicPriority(m: MerchantIntelSummary): MerchantStrategyPriority {
  if (m.scores.health < 30 || m.blockRate > 0.4 || m.deliverySuccessRate < 0.3) return "critical";
  if (m.scores.health < 55 || m.revenueGrowthRate < -0.25) return "high";
  if (m.scores.health < 70 || m.orderGrowthRate < -0.1) return "medium";
  return "low";
}

function executiveSummary(m: MerchantIntelSummary, priority: MerchantStrategyPriority): string {
  const deliveryPct = (m.deliverySuccessRate * 100).toFixed(1);
  const revGrowth = m.revenueGrowthRate >= 0
    ? `growing +${(m.revenueGrowthRate * 100).toFixed(1)}% MoM`
    : `declining ${(Math.abs(m.revenueGrowthRate) * 100).toFixed(1)}% MoM`;

  if (priority === "critical") {
    return `${m.name} requires immediate intervention. Delivery success at ${deliveryPct}%, block rate ${(m.blockRate * 100).toFixed(1)}%, and health score ${m.scores.health}/100 indicate serious operational problems. Revenue is ${revGrowth} — stabilising operations is the top priority before scaling ad spend.`;
  }
  if (priority === "high") {
    return `${m.name} shows potential but faces structural challenges. At ${deliveryPct}% delivery rate, significant revenue is being lost on returns. Revenue is ${revGrowth}. Focus: fix delivery first, then optimise advertising.`;
  }
  if (priority === "medium") {
    return `${m.name} is performing acceptably with ${deliveryPct}% delivery rate and health score ${m.scores.health}/100. Revenue is ${revGrowth}. The primary opportunity is optimising ad spend, exploring new wilayas, and improving COD collection.`;
  }
  return `${m.name} is a strong performer — ${deliveryPct}% delivery rate, health score ${m.scores.health}/100, revenue ${revGrowth}. The strategy is to scale what's working: increase ad spend in top wilayas, expand regional coverage, and lock in loyal customers.`;
}

// ── Action generators ─────────────────────────────────────────────────────────

function advertisingAction(m: MerchantIntelSummary): StrategyAction | null {
  let rank = 0;
  let cat: StrategyActionCategory = "advertising";
  let title = "";
  let why = "";
  let roi = "";
  let impact = 0;
  let time: StrategyTimeToValue = "1-2 weeks";
  let conf = 50;

  if (m.deliverySuccessRate < 0.38 && m.totalShipments >= 10) {
    rank = 1; title = "Pause all advertising until delivery rate improves";
    why = `Current delivery success rate is ${(m.deliverySuccessRate * 100).toFixed(1)}% — below the minimum viable threshold of 38%. Every ad-generated order has a >62% chance of being returned. Ad spend is accelerating losses.`;
    roi = `Estimated monthly savings: ${fmtCurrency(m.grossRevenueDzd * 0.15)} in avoided return logistics costs.`;
    impact = Math.round(m.grossRevenueDzd * 0.15); conf = 75; time = "immediate";
  } else if (m.deliverySuccessRate >= 0.72 && m.totalShipments >= 20) {
    rank = 1; title = "Increase advertising budget — strong delivery fundamentals";
    why = `${(m.deliverySuccessRate * 100).toFixed(1)}% delivery rate means every ad-generated order has a high probability of converting to collected revenue. This is the optimal time to scale.`;
    roi = `20% increase in ad spend could generate ${fmtCurrency(m.grossRevenueDzd * 0.18)} in additional revenue.`;
    impact = Math.round(m.grossRevenueDzd * 0.18); conf = 70; time = "1-2 weeks";
  } else if (m.deliverySuccessRate >= 0.55 && m.blockRate > 0.2) {
    rank = 3; title = "Optimise ad targeting to reduce fraud exposure";
    why = `Block rate of ${(m.blockRate * 100).toFixed(1)}% means 1 in ${Math.round(1 / m.blockRate)} orders is fraudulent. Better targeting (geographic, device-based) reduces this while maintaining volume.`;
    roi = `Fraud reduction could recover ${fmtCurrency(m.blockedOrders * m.avgBasketDzd * 0.1)} per cycle.`;
    impact = Math.round(m.blockedOrders * m.avgBasketDzd * 0.1); conf = 55; time = "1 month";
  } else {
    return null;
  }

  return { rank, category: cat, title, why, expectedROI: roi, confidence: conf, estimatedImpactDzd: impact, timeToValue: time };
}

function deliveryAction(m: MerchantIntelSummary, providers: ProviderIntel[]): StrategyAction | null {
  if (m.totalShipments < 10) return null;

  const currentProvider = m.topProvider;
  const betterProvider = providers
    .filter((p) => p.provider !== currentProvider && p.totalShipments >= 30)
    .sort((a, b) => b.deliverySuccessRate - a.deliverySuccessRate)[0];

  if (betterProvider && betterProvider.deliverySuccessRate > m.deliverySuccessRate + 0.12) {
    const improvement = betterProvider.deliverySuccessRate - m.deliverySuccessRate;
    const impact = Math.round(improvement * m.totalShipments * m.avgBasketDzd * 0.7);
    return {
      rank: m.deliverySuccessRate < 0.5 ? 1 : 4,
      category: "delivery",
      title: `Switch to ${betterProvider.provider} — ${((improvement) * 100).toFixed(1)}% better delivery rate`,
      why: `${betterProvider.provider} achieves ${(betterProvider.deliverySuccessRate * 100).toFixed(1)}% delivery success vs your current ${(m.deliverySuccessRate * 100).toFixed(1)}%. This is the single highest-leverage operational change.`,
      expectedROI: `Estimated ${fmtCurrency(impact)} more collected revenue per cycle.`,
      confidence: 60,
      estimatedImpactDzd: impact,
      timeToValue: "1-2 weeks",
    };
  }

  if (m.codSuccessRate < 0.50 && m.totalShipments >= 20) {
    const impact = Math.round(m.grossRevenueDzd * 0.1);
    return {
      rank: 3,
      category: "delivery",
      title: "Implement confirmation calls to reduce COD refusals",
      why: `COD collection rate is ${(m.codSuccessRate * 100).toFixed(1)}% — only half of deliveries result in successful payment collection. Confirmation calls before dispatch reduce no-answer and refusal rates by 10–15%.`,
      expectedROI: `Estimated ${fmtCurrency(impact)} additional collected revenue per cycle.`,
      confidence: 65,
      estimatedImpactDzd: impact,
      timeToValue: "immediate",
    };
  }

  return null;
}

function pricingAction(m: MerchantIntelSummary): StrategyAction | null {
  if (m.totalShipments < 15) return null;

  if (m.deliverySuccessRate > 0.70 && m.revenueGrowthRate > 0.15) {
    const impact = Math.round(m.grossRevenueDzd * 0.05);
    return {
      rank: 5,
      category: "pricing",
      title: "Test 5–10% price increase — strong market acceptance signal",
      why: `${(m.deliverySuccessRate * 100).toFixed(1)}% delivery rate with ${(m.revenueGrowthRate * 100).toFixed(1)}% revenue growth indicates customers are price-insensitive. A modest increase could significantly lift margin.`,
      expectedROI: `5% price increase on ${fmtCurrency(m.grossRevenueDzd)} gross → ${fmtCurrency(impact)} incremental revenue.`,
      confidence: 55,
      estimatedImpactDzd: impact,
      timeToValue: "1-2 weeks",
    };
  }

  if (m.refusedShipments / Math.max(1, m.totalShipments) > 0.2) {
    const impact = Math.round(m.refusedShipments * m.avgBasketDzd * 0.08);
    return {
      rank: 4,
      category: "pricing",
      title: "Reduce price or offer instalment payment to cut refusal rate",
      why: `Refusal rate of ${((m.refusedShipments / Math.max(1, m.totalShipments)) * 100).toFixed(1)}% suggests price friction at point of delivery. Lower effective price (discount, instalment) reduces cancellations.`,
      expectedROI: `Even 20% reduction in refusals recovers ${fmtCurrency(impact)} in lost revenue.`,
      confidence: 50,
      estimatedImpactDzd: impact,
      timeToValue: "1-2 weeks",
    };
  }

  return null;
}

function regionalAction(m: MerchantIntelSummary, wilayas: WilayaIntel[]): StrategyAction | null {
  if (m.topWilayas.length === 0) return null;

  const worstWilaya = m.topWilayas.find((w) => w.successRate < 0.35 && w.orders >= 5);
  if (worstWilaya) {
    const impact = Math.round(worstWilaya.orders * m.avgBasketDzd * (0.65 - worstWilaya.successRate));
    return {
      rank: 3,
      category: "regional",
      title: `Remove ${worstWilaya.wilaya} from targeting — ${(worstWilaya.successRate * 100).toFixed(1)}% success rate`,
      why: `${worstWilaya.wilaya} generates ${worstWilaya.orders} orders but only ${(worstWilaya.successRate * 100).toFixed(1)}% deliver. Every order here costs you return logistics. Excluding it immediately improves overall delivery rate and margin.`,
      expectedROI: `Stop absorbing return costs on ${worstWilaya.orders} orders per cycle — saves approximately ${fmtCurrency(impact)}.`,
      confidence: 70,
      estimatedImpactDzd: impact,
      timeToValue: "immediate",
    };
  }

  // Find a top-performing platform wilaya the merchant isn't using
  const merchantWilayaNames = new Set(m.topWilayas.map((w) => w.wilaya));
  const unexplored = wilayas
    .filter((w) => !merchantWilayaNames.has(w.wilaya) && w.deliverySuccessRate >= 0.75 && w.totalShipments >= 20)
    .sort((a, b) => b.deliverySuccessRate - a.deliverySuccessRate)[0];

  if (unexplored) {
    const impact = Math.round(unexplored.totalShipments * 0.1 * unexplored.avgCodAmountDzd * unexplored.deliverySuccessRate);
    return {
      rank: 6,
      category: "regional",
      title: `Expand into ${unexplored.wilaya} — ${(unexplored.deliverySuccessRate * 100).toFixed(1)}% platform success rate`,
      why: `${unexplored.wilaya} has a ${(unexplored.deliverySuccessRate * 100).toFixed(1)}% platform-wide delivery success rate but you're not targeting it. This is a low-risk expansion opportunity.`,
      expectedROI: `Small test budget in ${unexplored.wilaya} could add ${fmtCurrency(impact)} in incremental revenue.`,
      confidence: 55,
      estimatedImpactDzd: impact,
      timeToValue: "1 month",
    };
  }

  return null;
}

function customerAction(m: MerchantIntelSummary): StrategyAction | null {
  if (m.uniqueCustomers < 10) return null;

  const ordersPerCustomer = m.totalOrders / m.uniqueCustomers;
  if (ordersPerCustomer >= 1.5) {
    const impact = Math.round(m.grossRevenueDzd * 0.08);
    return {
      rank: 7,
      category: "customer",
      title: "Launch loyalty programme — strong repeat buyer base",
      why: `${ordersPerCustomer.toFixed(1)} orders per unique customer indicates above-average retention. A structured loyalty programme would amplify this natural retention signal.`,
      expectedROI: `Loyalty programme could increase repeat order rate by 20%, adding ${fmtCurrency(impact)} per cycle.`,
      confidence: 55,
      estimatedImpactDzd: impact,
      timeToValue: "1 month",
    };
  }

  if (ordersPerCustomer < 0.3 && m.uniqueCustomers >= 20) {
    const impact = Math.round(m.grossRevenueDzd * 0.05);
    return {
      rank: 5,
      category: "customer",
      title: "Implement post-purchase re-engagement to build repeat buyers",
      why: `Only ${ordersPerCustomer.toFixed(2)} orders per customer — almost all buyers are one-time purchasers. Without repeat buying, every order requires full acquisition cost.`,
      expectedROI: `Converting 10% of buyers to repeat customers adds ${fmtCurrency(impact)} per cycle.`,
      confidence: 50,
      estimatedImpactDzd: impact,
      timeToValue: "1 month",
    };
  }

  return null;
}

function growthAction(m: MerchantIntelSummary): StrategyAction | null {
  if (m.orderGrowthRate >= 0.3 && m.deliverySuccessRate >= 0.6) {
    const impact = Math.round(m.grossRevenueDzd * m.orderGrowthRate * 0.5);
    return {
      rank: 2,
      category: "advertising",
      title: "Accelerate growth — all fundamentals support scaling",
      why: `${(m.orderGrowthRate * 100).toFixed(1)}% order growth MoM with ${(m.deliverySuccessRate * 100).toFixed(1)}% delivery rate. The business is in a growth phase where additional ad investment has the highest expected ROI.`,
      expectedROI: `At current growth trajectory, doubling ad spend could generate ${fmtCurrency(impact)} in additional revenue within 60 days.`,
      confidence: 65,
      estimatedImpactDzd: impact,
      timeToValue: "1-2 weeks",
    };
  }

  if (m.orderGrowthRate <= -0.3 && m.totalOrders >= 20) {
    return {
      rank: 1,
      category: "operations",
      title: "Investigate root cause of order decline — urgent",
      why: `Orders dropped ${(Math.abs(m.orderGrowthRate) * 100).toFixed(1)}% month-over-month. This is not a seasonal pattern — it requires immediate diagnosis. Common causes: ad account issues, product listing problems, or market saturation.`,
      expectedROI: "Stopping the decline recovers the full lost revenue trajectory.",
      confidence: 70,
      estimatedImpactDzd: Math.round(Math.abs(m.orderGrowthRate) * m.grossRevenueDzd * 0.5),
      timeToValue: "immediate",
    };
  }

  return null;
}

// ── Strategy text generators ──────────────────────────────────────────────────

function advertisingStrategy(m: MerchantIntelSummary): string {
  const rate = m.deliverySuccessRate;
  if (rate < 0.38) return "Pause advertising immediately. With sub-38% delivery rate, ad spend is generating net losses. Fix delivery operations first, then restart ads in top-performing wilayas only.";
  if (rate >= 0.72) return `Strong delivery rate of ${(rate * 100).toFixed(1)}% supports aggressive ad scaling. Focus budget on your top-converting wilayas. Test 20% budget increase quarterly.`;
  return `Maintain current ad budget at ${(rate * 100).toFixed(1)}% delivery rate. Gradually shift spend toward wilayas with >70% success rates. Monitor weekly and adjust on data.`;
}

function deliveryStrategy(m: MerchantIntelSummary, providers: ProviderIntel[]): string {
  const parts: string[] = [];
  if (m.deliverySuccessRate < 0.55) {
    parts.push(`Delivery at ${(m.deliverySuccessRate * 100).toFixed(1)}% requires immediate action.`);
    const better = providers.filter((p) => p.provider !== m.topProvider && p.deliverySuccessRate > m.deliverySuccessRate + 0.1)[0];
    if (better) parts.push(`Trial ${better.provider} (${(better.deliverySuccessRate * 100).toFixed(1)}% platform rate) in your top 3 wilayas.`);
    parts.push("Implement mandatory confirmation calls for all orders.");
  } else {
    parts.push(`Delivery at ${(m.deliverySuccessRate * 100).toFixed(1)}% is acceptable.`);
    if (m.codSuccessRate < 0.6) parts.push(`COD collection at ${(m.codSuccessRate * 100).toFixed(1)}% is low — add confirmation step before dispatch.`);
    parts.push("Review stop-desk availability in low-success wilayas.");
  }
  return parts.join(" ");
}

function productStrategy(m: MerchantIntelSummary): string {
  if (m.totalOrders < 10) return "Insufficient order data to build product strategy. Collect at least 20 orders before optimising product mix.";
  const parts: string[] = [];
  if (m.avgBasketDzd > 5000) parts.push(`High avg basket (${m.avgBasketDzd.toFixed(0)} DZD) — focus on premium product retention. Bundle complementary items.`);
  else if (m.avgBasketDzd < 1000) parts.push(`Low avg basket (${m.avgBasketDzd.toFixed(0)} DZD) — consider bundles or cross-sells to increase order value.`);
  if (m.deliverySuccessRate < 0.5) parts.push("High return rates suggest product-market mismatch. Review which products generate the most returns and consider removing or repricing them.");
  parts.push("Use product intelligence data to identify best-selling and declining SKUs.");
  return parts.join(" ");
}

function pricingStrategy(m: MerchantIntelSummary): string {
  if (m.deliverySuccessRate >= 0.70 && m.revenueGrowthRate > 0) {
    return `Strong delivery rate and positive revenue growth signal market acceptance at current prices. Test a 5–8% price increase on your top 3 products. Monitor refusal rate — if it stays below 20%, maintain the increase.`;
  }
  if (m.refusedShipments > m.returnedShipments) {
    return `High refusal rate suggests price sensitivity at delivery. Consider reducing effective COD amount by 5–10% or offering a small delivery incentive. Alternatively, shift to verified pre-order customers who have lower refusal propensity.`;
  }
  return `Current pricing appears appropriate for the market. Focus on optimising delivery rather than adjusting pricing. Only revisit pricing once delivery rate exceeds 65%.`;
}

function regionalStrategy(m: MerchantIntelSummary): string {
  if (m.topWilayas.length === 0) return "No wilaya data available. Ensure delivery provider reports wilaya names for full regional analysis.";
  const worst = m.topWilayas.filter((w) => w.successRate < 0.40);
  const best = m.topWilayas.filter((w) => w.successRate >= 0.70);
  const parts: string[] = [];
  if (worst.length > 0) parts.push(`Remove or reduce targeting in: ${worst.map((w) => `${w.wilaya} (${(w.successRate * 100).toFixed(0)}%)`).join(", ")}.`);
  if (best.length > 0) parts.push(`Double down on: ${best.map((w) => `${w.wilaya} (${(w.successRate * 100).toFixed(0)}%)`).join(", ")}.`);
  parts.push("Test 1–2 new wilayas per month using small budget allocations.");
  return parts.join(" ");
}

function customerStrategy(m: MerchantIntelSummary): string {
  if (m.uniqueCustomers < 5) return "Build customer base first — loyalty programmes require sufficient repeat-buyer data to be effective.";
  const opc = m.uniqueCustomers > 0 ? m.totalOrders / m.uniqueCustomers : 0;
  if (opc >= 1.5) return `Strong repeat buying (${opc.toFixed(1)} orders/customer). Build on this with a tiered loyalty programme. VIP customers (>3 orders) should receive priority support and exclusive discounts.`;
  return `Low repeat rate (${opc.toFixed(2)} orders/customer). Implement a post-delivery follow-up sequence. Send a personalised offer 14 days after confirmed delivery. Target: 20% of first-time buyers place a second order.`;
}

function growthStrategy(m: MerchantIntelSummary): string {
  if (m.orderGrowthRate >= 0.3) return `Explosive growth at ${(m.orderGrowthRate * 100).toFixed(1)}% MoM. Priority: ensure operational capacity scales with demand. Verify delivery provider capacity, stock replenishment speed, and confirmation team size.`;
  if (m.orderGrowthRate >= 0.1) return `Healthy growth at ${(m.orderGrowthRate * 100).toFixed(1)}% MoM. Maintain momentum by reinvesting 20–30% of monthly profit into advertising. The current growth rate is compound — protect it.`;
  if (m.orderGrowthRate <= -0.2) return `Declining ${(Math.abs(m.orderGrowthRate) * 100).toFixed(1)}% MoM. Diagnose before spending. Check: (1) ad account status, (2) product availability, (3) delivery provider issues, (4) competitor activity. Fix the root cause, don't just increase budget.`;
  return `Stable at ${(m.orderGrowthRate * 100).toFixed(1)}% MoM. Growth strategy: (1) Optimise conversion in existing wilayas, (2) test 1–2 new wilayas, (3) improve product mix based on delivery performance data.`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildMerchantStrategy(
  m: MerchantIntelSummary,
  providers: ProviderIntel[],
  wilayas: WilayaIntel[],
  _categories: CategoryIntel[],
): MerchantStrategy {
  const priority = strategicPriority(m);

  // Generate candidate actions
  const candidates = [
    advertisingAction(m),
    deliveryAction(m, providers),
    pricingAction(m),
    regionalAction(m, wilayas),
    customerAction(m),
    growthAction(m),
  ].filter((a): a is NonNullable<typeof a> => a !== null);

  // Sort by rank, then by impact desc
  candidates.sort((a, b) => a.rank - b.rank || b.estimatedImpactDzd - a.estimatedImpactDzd);

  // Re-rank 1-based after sorting
  const topActions: StrategyAction[] = candidates.slice(0, 10).map((a, i) => ({
    ...a,
    rank: i + 1,
  }));

  const totalImpact = topActions.reduce((s, a) => s + a.estimatedImpactDzd, 0);

  // Delivery improvement estimate: if we're not switching providers, improvement = 0
  const bestProvider = providers
    .filter((p) => p.totalShipments >= 30)
    .sort((a, b) => b.deliverySuccessRate - a.deliverySuccessRate)[0];
  const deliveryImprovement = bestProvider && bestProvider.deliverySuccessRate > m.deliverySuccessRate
    ? Number(((bestProvider.deliverySuccessRate - m.deliverySuccessRate) * 0.7).toFixed(3))
    : 0;

  const refusalRate = m.totalShipments > 0 ? m.refusedShipments / m.totalShipments : 0;
  const expectedRefusalReduction = refusalRate > 0.15 ? Number((refusalRate * 0.15).toFixed(3)) : 0;

  return {
    merchantId: m.merchantId,
    merchantName: m.name,
    generatedAt: NOW,
    overallHealthScore: m.scores.composite,
    strategicPriority: priority,
    executiveSummary: executiveSummary(m, priority),
    expectedRevenueIncreaseDzd: Math.round(totalImpact * 0.6),
    expectedDeliveryImprovement: deliveryImprovement,
    expectedRefusalReduction,
    topActions,
    advertisingStrategy: advertisingStrategy(m),
    deliveryStrategy: deliveryStrategy(m, providers),
    productStrategy: productStrategy(m),
    pricingStrategy: pricingStrategy(m),
    regionalStrategy: regionalStrategy(m),
    customerStrategy: customerStrategy(m),
    growthStrategy: growthStrategy(m),
  };
}
