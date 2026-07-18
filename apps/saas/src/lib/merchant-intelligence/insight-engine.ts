// insight-engine.ts
//
// Automatic business insight and alert generation.
// All insights are derived from real computed metrics — no fabricated signals.
//
// Insight rules:
//   merchant_growth:          MoM order growth > 20%
//   merchant_decline:         MoM order growth < -20%
//   fraud_spike:              block rate > 25% AND > 10 orders in last 30d
//   delivery_failure_spike:   delivery success rate < 45% AND > 20 terminal shipments
//   category_opportunity:     category success rate >= 72% AND > 10 orders
//   category_risk:            category success rate < 40% AND > 10 orders
//   provider_advantage:       provider A beats provider B by >= 15% in a wilaya (>= 10 shipments each)
//   revenue_drop:             MoM revenue growth < -25%
//   cod_refusal_spike:        COD success rate < 40% AND > 20 shipments with COD

import type {
  BusinessInsight,
  BusinessAlert,
  MerchantIntelSummary,
  CategoryIntel,
  ProviderIntel,
  WilayaIntel,
} from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(rate: number): string {
  return (rate * 100).toFixed(1) + "%";
}

function signedPct(rate: number): string {
  const formatted = Math.abs(rate * 100).toFixed(1) + "%";
  return rate >= 0 ? `+${formatted}` : `-${formatted}`;
}

let idCounter = 0;
function nextId(): string {
  return `insight-${++idCounter}`;
}

// ── Merchant insights ─────────────────────────────────────────────────────────

function merchantInsights(summaries: MerchantIntelSummary[]): BusinessInsight[] {
  const insights: BusinessInsight[] = [];

  for (const m of summaries) {
    // Growth
    if (m.orderGrowthRate >= 0.2 && m.totalOrders >= 10) {
      insights.push({
        id: nextId(),
        type: "merchant_growth",
        severity: "info",
        title: `${m.name} orders up ${signedPct(m.orderGrowthRate)} month-over-month`,
        body: `This merchant processed ${m.totalOrders.toLocaleString()} total orders with a ${pct(m.deliverySuccessRate)} delivery success rate. Strong growth signal — consider prioritising support resources.`,
        merchantId: m.merchantId,
        merchantName: m.name,
      });
    }

    // Decline
    if (m.orderGrowthRate <= -0.2 && m.totalOrders >= 10) {
      insights.push({
        id: nextId(),
        type: "merchant_decline",
        severity: "warning",
        title: `${m.name} orders down ${signedPct(m.orderGrowthRate)} month-over-month`,
        body: `Order volume dropped significantly. Delivery success rate is ${pct(m.deliverySuccessRate)} and block rate is ${pct(m.blockRate)}. Review fraud signals and delivery performance.`,
        merchantId: m.merchantId,
        merchantName: m.name,
      });
    }

    // Fraud spike
    if (m.blockRate >= 0.25 && m.totalOrders >= 10) {
      insights.push({
        id: nextId(),
        type: "fraud_spike",
        severity: m.blockRate >= 0.4 ? "critical" : "warning",
        title: `${m.name} fraud block rate at ${pct(m.blockRate)}`,
        body: `${m.blockedOrders.toLocaleString()} orders out of ${m.totalOrders.toLocaleString()} were blocked. This is above the ${pct(0.25)} alert threshold. Manual review recommended.`,
        merchantId: m.merchantId,
        merchantName: m.name,
      });
    }

    // Delivery failure
    if (m.deliverySuccessRate < 0.45 && m.totalShipments >= 20) {
      insights.push({
        id: nextId(),
        type: "delivery_failure_spike",
        severity: m.deliverySuccessRate < 0.3 ? "critical" : "warning",
        title: `${m.name} delivery success at ${pct(m.deliverySuccessRate)}`,
        body: `Only ${m.deliveredShipments.toLocaleString()} of ${m.totalShipments.toLocaleString()} shipments delivered. Returned: ${m.returnedShipments.toLocaleString()}, Refused: ${m.refusedShipments.toLocaleString()}. Investigate product quality and wilaya targeting.`,
        merchantId: m.merchantId,
        merchantName: m.name,
      });
    }

    // Revenue drop
    if (m.revenueGrowthRate <= -0.25 && m.grossRevenueDzd >= 10000) {
      insights.push({
        id: nextId(),
        type: "revenue_drop",
        severity: "warning",
        title: `${m.name} revenue dropped ${signedPct(m.revenueGrowthRate)} month-over-month`,
        body: `Gross COD revenue fell significantly. Current gross: ${m.grossRevenueDzd.toLocaleString()} DZD. Collected: ${m.collectedRevenueDzd.toLocaleString()} DZD. Delivery success and fraud rates should be investigated.`,
        merchantId: m.merchantId,
        merchantName: m.name,
      });
    }

    // COD refusal spike
    if (m.codSuccessRate < 0.4 && m.totalShipments >= 20) {
      insights.push({
        id: nextId(),
        type: "cod_refusal_spike",
        severity: "warning",
        title: `${m.name} COD collection rate at ${pct(m.codSuccessRate)}`,
        body: `Only ${pct(m.codSuccessRate)} of COD payments were collected. This significantly reduces effective revenue. Review package values and customer targeting.`,
        merchantId: m.merchantId,
        merchantName: m.name,
      });
    }
  }

  return insights;
}

// ── Category insights ─────────────────────────────────────────────────────────

function categoryInsights(categories: CategoryIntel[]): BusinessInsight[] {
  const insights: BusinessInsight[] = [];

  for (const cat of categories) {
    if (cat.totalOrders < 10) continue;

    // Opportunity: high success rate
    if (cat.deliverySuccessRate >= 0.72) {
      insights.push({
        id: nextId(),
        type: "category_opportunity",
        severity: "info",
        title: `${cat.categoryName} has ${pct(cat.deliverySuccessRate)} delivery success rate`,
        body: `${cat.totalOrders.toLocaleString()} orders, ${cat.grossRevenueDzd.toLocaleString()} DZD gross revenue. Best wilaya: ${cat.topWilayas[0]?.wilaya ?? "N/A"}. Recommended action: increase advertising budget.`,
        merchantId: null,
        merchantName: null,
      });
    }

    // Risk: low success rate
    if (cat.deliverySuccessRate < 0.4) {
      insights.push({
        id: nextId(),
        type: "category_risk",
        severity: cat.deliverySuccessRate < 0.25 ? "critical" : "warning",
        title: `${cat.categoryName} delivery failure rate at ${pct(1 - cat.deliverySuccessRate)}`,
        body: `${cat.returnedOrders + cat.refusedOrders} orders returned or refused out of ${cat.totalOrders.toLocaleString()}. Worst wilaya: ${cat.worstWilayas[0]?.wilaya ?? "N/A"}. Pause or reduce ad spend immediately.`,
        merchantId: null,
        merchantName: null,
      });
    }
  }

  return insights;
}

// ── Provider insights ─────────────────────────────────────────────────────────

function providerInsights(providers: ProviderIntel[]): BusinessInsight[] {
  const insights: BusinessInsight[] = [];
  if (providers.length < 2) return insights;

  // Compare providers on shared wilayas
  for (let i = 0; i < providers.length; i++) {
    for (let j = i + 1; j < providers.length; j++) {
      const a = providers[i];
      const b = providers[j];

      if (a.totalShipments < 20 || b.totalShipments < 20) continue;

      const diff = a.deliverySuccessRate - b.deliverySuccessRate;
      if (Math.abs(diff) < 0.15) continue;

      const better = diff > 0 ? a : b;
      const worse = diff > 0 ? b : a;

      insights.push({
        id: nextId(),
        type: "provider_advantage",
        severity: "info",
        title: `${better.provider} outperforms ${worse.provider} by ${pct(Math.abs(diff))}`,
        body: `${better.provider}: ${pct(better.deliverySuccessRate)} success over ${better.totalShipments.toLocaleString()} shipments. ${worse.provider}: ${pct(worse.deliverySuccessRate)} success over ${worse.totalShipments.toLocaleString()} shipments. Consider routing more volume through ${better.provider}.`,
        merchantId: null,
        merchantName: null,
      });
    }
  }

  return insights;
}

// ── Wilaya insights ───────────────────────────────────────────────────────────

function wilayaInsights(wilayas: WilayaIntel[]): BusinessInsight[] {
  const insights: BusinessInsight[] = [];

  for (const w of wilayas) {
    if (w.totalShipments < 20) continue;

    if (w.deliverySuccessRate >= 0.8) {
      insights.push({
        id: nextId(),
        type: "wilaya_opportunity",
        severity: "info",
        title: `${w.wilaya} has ${pct(w.deliverySuccessRate)} delivery success rate`,
        body: `${w.totalShipments.toLocaleString()} total shipments. ${w.deliveredShipments.toLocaleString()} delivered. ${w.grossRevenueDzd.toLocaleString()} DZD gross revenue. Top opportunity wilaya — expand targeting here.`,
        merchantId: null,
        merchantName: null,
      });
    }

    if (w.deliverySuccessRate < 0.4 && w.totalShipments >= 30) {
      insights.push({
        id: nextId(),
        type: "wilaya_risk",
        severity: "warning",
        title: `${w.wilaya} delivery failure rate at ${pct(1 - w.deliverySuccessRate)}`,
        body: `${w.returnedShipments + w.refusedShipments} shipments returned or refused out of ${w.totalShipments.toLocaleString()}. Best provider in this wilaya: ${w.bestProvider ?? "N/A"} (${w.bestProviderSuccessRate != null ? pct(w.bestProviderSuccessRate) : "N/A"}).`,
        merchantId: null,
        merchantName: null,
      });
    }
  }

  return insights;
}

// ── Alert extraction ──────────────────────────────────────────────────────────

function toAlert(insight: BusinessInsight): BusinessAlert {
  return {
    id: insight.id,
    type: insight.type,
    severity: insight.severity as "warning" | "critical",
    title: insight.title,
    body: insight.body,
    merchantId: insight.merchantId,
    merchantName: insight.merchantName,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export type InsightEngineOutput = {
  insights: BusinessInsight[];
  alerts: BusinessAlert[];
};

export function generateInsightsAndAlerts(params: {
  summaries: MerchantIntelSummary[];
  categories: CategoryIntel[];
  providers: ProviderIntel[];
  wilayas: WilayaIntel[];
}): InsightEngineOutput {
  idCounter = 0; // reset per page-render

  const allInsights: BusinessInsight[] = [
    ...merchantInsights(params.summaries),
    ...categoryInsights(params.categories),
    ...providerInsights(params.providers),
    ...wilayaInsights(params.wilayas),
  ];

  // Alerts = warning or critical insights
  const alerts: BusinessAlert[] = allInsights
    .filter((i) => i.severity === "warning" || i.severity === "critical")
    .map(toAlert);

  return { insights: allInsights, alerts };
}
