// Anomaly detection module.
//
// Detects anomalies using:
//   - Z-score on orderTrend (spike/drop in current vs historical)
//   - Threshold comparison vs platform average
//   - Revenue drop anomalies from revenueGrowthRate
//   - Wilaya/provider outliers from delivery success rates
//
// Every anomaly includes: severity, confidence, estimatedImpactDzd.

import type { MerchantIntelSummary, CategoryIntel, WilayaIntel, ProviderIntel } from "@/lib/merchant-intelligence/types";
import type { Anomaly, AnomalyCategory, AnomalySeverity } from "./types";
import { mean, standardDeviation, zScores } from "./math";

let _id = 0;
function nextId(): string { return `an-${++_id}`; }
export function resetAnomalyIds(): void { _id = 0; }

const NOW = new Date().toISOString();

function severity(zScore: number, absoluteMagnitude: number): AnomalySeverity {
  if (Math.abs(zScore) > 2.5 || absoluteMagnitude > 0.5) return "critical";
  if (Math.abs(zScore) > 1.5 || absoluteMagnitude > 0.25) return "warning";
  return "info";
}

function confidence(sampleSize: number, zScore: number): number {
  const sampleScore = Math.min(50, (sampleSize / 100) * 50);
  const signalScore = Math.min(40, Math.abs(zScore) * 15);
  return Math.round(Math.max(5, Math.min(88, sampleScore + signalScore)));
}

// ── Merchant anomalies (orderTrend spike/drop detection) ─────────────────────

export function detectMerchantAnomalies(
  summaries: MerchantIntelSummary[],
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const platformMean = mean(summaries.map((m) => m.orderTrend[11] ?? 0));

  for (const m of summaries) {
    if (m.totalOrders < 5) continue;

    const trend = m.orderTrend;
    const currentMonth = trend[11] ?? 0;
    const prevMonths = trend.slice(0, 11);
    const historicalMean = mean(prevMonths);
    const historicalStd = standardDeviation(prevMonths);

    // Order spike/drop in current month vs historical baseline
    if (historicalStd > 0 && historicalMean > 0) {
      const z = (currentMonth - historicalMean) / historicalStd;
      if (Math.abs(z) > 1.5) {
        const isSpike = z > 0;
        const pct = ((Math.abs(currentMonth - historicalMean) / historicalMean) * 100).toFixed(1);
        anomalies.push({
          id: nextId(),
          category: "merchant",
          severity: severity(z, Math.abs(z) / 5),
          confidence: confidence(m.totalOrders, z),
          estimatedImpactDzd: Math.round(
            Math.abs(currentMonth - historicalMean) * m.avgBasketDzd * m.deliverySuccessRate,
          ),
          title: isSpike
            ? `${m.name} — unexpected order spike (+${pct}% vs historical avg)`
            : `${m.name} — unexpected order drop (−${pct}% vs historical avg)`,
          description: isSpike
            ? `Current month: ${currentMonth} orders vs historical average of ${historicalMean.toFixed(0)}. Z-score: ${z.toFixed(2)}. This spike may indicate a viral product, new ad campaign, or data quality issue.`
            : `Current month: ${currentMonth} orders vs historical average of ${historicalMean.toFixed(0)}. Z-score: ${z.toFixed(2)}. This drop may indicate ad pause, seasonal trough, or merchant technical issue.`,
          detectedAt: NOW,
          merchantId: m.merchantId,
          merchantName: m.name,
          wilaya: null,
          provider: null,
          zScore: Number(z.toFixed(2)),
          metric: "monthly_orders",
          metricValue: currentMonth,
          metricBaseline: Number(historicalMean.toFixed(0)),
        });
      }
    }

    // Revenue drop anomaly
    if (m.revenueGrowthRate <= -0.30 && m.grossRevenueDzd >= 50000) {
      anomalies.push({
        id: nextId(),
        category: "revenue",
        severity: m.revenueGrowthRate <= -0.50 ? "critical" : "warning",
        confidence: confidence(m.totalShipments, Math.abs(m.revenueGrowthRate) * 3),
        estimatedImpactDzd: Math.round(Math.abs(m.revenueGrowthRate) * m.grossRevenueDzd),
        title: `${m.name} — revenue dropped ${(Math.abs(m.revenueGrowthRate) * 100).toFixed(1)}% MoM`,
        description: `Revenue growth rate: ${(m.revenueGrowthRate * 100).toFixed(1)}%. Gross revenue: ${m.grossRevenueDzd.toLocaleString("fr-DZ")} DZD. Delivery rate: ${(m.deliverySuccessRate * 100).toFixed(1)}%. Block rate: ${(m.blockRate * 100).toFixed(1)}%.`,
        detectedAt: NOW,
        merchantId: m.merchantId,
        merchantName: m.name,
        wilaya: null,
        provider: null,
        zScore: null,
        metric: "revenue_growth_rate",
        metricValue: Number(m.revenueGrowthRate.toFixed(4)),
        metricBaseline: 0,
      });
    }

    // Fraud spike anomaly
    if (m.blockRate >= 0.30 && m.totalOrders >= 10) {
      anomalies.push({
        id: nextId(),
        category: "fraud",
        severity: m.blockRate >= 0.50 ? "critical" : "warning",
        confidence: confidence(m.totalOrders, m.blockRate * 2),
        estimatedImpactDzd: Math.round(m.blockedOrders * m.avgBasketDzd),
        title: `${m.name} — fraud block rate at ${(m.blockRate * 100).toFixed(1)}%`,
        description: `${m.blockedOrders.toLocaleString()} of ${m.totalOrders.toLocaleString()} orders blocked. Block rate ${(m.blockRate * 100).toFixed(1)}% exceeds 30% alert threshold. Suspicious customer behavior detected.`,
        detectedAt: NOW,
        merchantId: m.merchantId,
        merchantName: m.name,
        wilaya: null,
        provider: null,
        zScore: null,
        metric: "block_rate",
        metricValue: Number(m.blockRate.toFixed(4)),
        metricBaseline: 0.10,
      });
    }

    // Customer decline anomaly (very low repeat rate + declining orders)
    if (
      m.uniqueCustomers >= 20 &&
      m.orderGrowthRate <= -0.25 &&
      m.totalOrders >= 20
    ) {
      anomalies.push({
        id: nextId(),
        category: "customer",
        severity: "warning",
        confidence: confidence(m.totalOrders, Math.abs(m.orderGrowthRate) * 3),
        estimatedImpactDzd: Math.round(Math.abs(m.orderGrowthRate) * m.grossRevenueDzd * 0.3),
        title: `${m.name} — customer acquisition declining (${(m.orderGrowthRate * 100).toFixed(1)}% MoM)`,
        description: `Orders dropped ${(Math.abs(m.orderGrowthRate) * 100).toFixed(1)}% month-over-month with ${m.uniqueCustomers.toLocaleString()} customers on record. Either new customer acquisition has stalled or existing customers are not returning.`,
        detectedAt: NOW,
        merchantId: m.merchantId,
        merchantName: m.name,
        wilaya: null,
        provider: null,
        zScore: null,
        metric: "order_growth_rate",
        metricValue: Number(m.orderGrowthRate.toFixed(4)),
        metricBaseline: 0,
      });
    }

    void platformMean; // suppress unused warning
  }

  return anomalies;
}

// ── Category anomalies ────────────────────────────────────────────────────────

export function detectCategoryAnomalies(categories: CategoryIntel[]): Anomaly[] {
  if (categories.length < 3) return [];

  const anomalies: Anomaly[] = [];
  const rates = categories.map((c) => c.deliverySuccessRate);
  const m = mean(rates);
  const std = standardDeviation(rates);
  const zs = zScores(rates);

  categories.forEach((cat, i) => {
    if (cat.totalOrders < 10) return;
    const z = zs[i];
    if (Math.abs(z) < 1.5) return;

    const isSpike = z > 0;
    anomalies.push({
      id: nextId(),
      category: "delivery",
      severity: severity(z, Math.abs(cat.deliverySuccessRate - m)),
      confidence: confidence(cat.totalOrders, z),
      estimatedImpactDzd: Math.round(Math.abs(cat.deliverySuccessRate - m) * cat.grossRevenueDzd * 0.5),
      title: isSpike
        ? `${cat.categoryName} — unusually high delivery rate (${(cat.deliverySuccessRate * 100).toFixed(1)}%)`
        : `${cat.categoryName} — unusually low delivery rate (${(cat.deliverySuccessRate * 100).toFixed(1)}%)`,
      description: `${cat.categoryName} has delivery rate of ${(cat.deliverySuccessRate * 100).toFixed(1)}% vs platform avg of ${(m * 100).toFixed(1)}%. Z-score: ${z.toFixed(2)}. ${cat.totalOrders.toLocaleString()} orders, ${cat.grossRevenueDzd.toLocaleString("fr-DZ")} DZD gross.`,
      detectedAt: NOW,
      merchantId: null,
      merchantName: null,
      wilaya: null,
      provider: null,
      zScore: Number(z.toFixed(2)),
      metric: "delivery_success_rate",
      metricValue: Number(cat.deliverySuccessRate.toFixed(4)),
      metricBaseline: Number(m.toFixed(4)),
    });

    void std;
  });

  return anomalies;
}

// ── Wilaya anomalies ──────────────────────────────────────────────────────────

export function detectWilayaAnomalies(wilayas: WilayaIntel[]): Anomaly[] {
  if (wilayas.length < 3) return [];

  const anomalies: Anomaly[] = [];
  const qualified = wilayas.filter((w) => w.totalShipments >= 20);
  if (qualified.length < 3) return [];

  const rates = qualified.map((w) => w.deliverySuccessRate);
  const m = mean(rates);
  const zs = zScores(rates);

  qualified.forEach((w, i) => {
    const z = zs[i];
    if (Math.abs(z) < 1.5) return;

    const isGood = z > 0;
    anomalies.push({
      id: nextId(),
      category: "wilaya",
      severity: severity(z, Math.abs(w.deliverySuccessRate - m)),
      confidence: confidence(w.totalShipments, z),
      estimatedImpactDzd: Math.round(Math.abs(w.deliverySuccessRate - m) * w.grossRevenueDzd * 0.3),
      title: isGood
        ? `${w.wilaya} — standout delivery performance (${(w.deliverySuccessRate * 100).toFixed(1)}%)`
        : `${w.wilaya} — delivery underperforming (${(w.deliverySuccessRate * 100).toFixed(1)}%)`,
      description: `${w.wilaya}: ${(w.deliverySuccessRate * 100).toFixed(1)}% success vs ${(m * 100).toFixed(1)}% platform avg. ${w.totalShipments.toLocaleString()} shipments. ${w.returnedShipments + w.refusedShipments} returned/refused. Z-score: ${z.toFixed(2)}.`,
      detectedAt: NOW,
      merchantId: null,
      merchantName: null,
      wilaya: w.wilaya,
      provider: null,
      zScore: Number(z.toFixed(2)),
      metric: "delivery_success_rate",
      metricValue: Number(w.deliverySuccessRate.toFixed(4)),
      metricBaseline: Number(m.toFixed(4)),
    });
  });

  return anomalies;
}

// ── Provider anomalies ────────────────────────────────────────────────────────

export function detectProviderAnomalies(providers: ProviderIntel[]): Anomaly[] {
  if (providers.length < 2) return [];

  const anomalies: Anomaly[] = [];
  const qualified = providers.filter((p) => p.totalShipments >= 30);
  if (qualified.length < 2) return [];

  const rates = qualified.map((p) => p.deliverySuccessRate);
  const m = mean(rates);
  const zs = zScores(rates);

  qualified.forEach((p, i) => {
    const z = zs[i];
    if (Math.abs(z) < 1.0) return;

    const isGood = z > 0;
    const estImpact = Math.round(Math.abs(p.deliverySuccessRate - m) * p.totalShipments * 2500);

    anomalies.push({
      id: nextId(),
      category: "provider",
      severity: severity(z, Math.abs(p.deliverySuccessRate - m)),
      confidence: confidence(p.totalShipments, z),
      estimatedImpactDzd: estImpact,
      title: isGood
        ? `${p.provider} — outperforming other providers (+${((p.deliverySuccessRate - m) * 100).toFixed(1)}%)`
        : `${p.provider} — underperforming vs other providers (${((p.deliverySuccessRate - m) * 100).toFixed(1)}%)`,
      description: `${p.provider}: ${(p.deliverySuccessRate * 100).toFixed(1)}% success vs ${(m * 100).toFixed(1)}% avg across providers. Return rate: ${(p.returnRate * 100).toFixed(1)}%. ${p.totalShipments.toLocaleString()} shipments, ${p.merchantCount} merchants.`,
      detectedAt: NOW,
      merchantId: null,
      merchantName: null,
      wilaya: null,
      provider: p.provider,
      zScore: Number(z.toFixed(2)),
      metric: "delivery_success_rate",
      metricValue: Number(p.deliverySuccessRate.toFixed(4)),
      metricBaseline: Number(m.toFixed(4)),
    });
  });

  return anomalies;
}

// ── COD unusual increase anomaly ──────────────────────────────────────────────

export function detectCodAnomalies(summaries: MerchantIntelSummary[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const qualified = summaries.filter((m) => m.totalShipments >= 20);
  if (qualified.length === 0) return [];

  const baskets = qualified.map((m) => m.avgBasketDzd);
  const m = mean(baskets);
  const zs = zScores(baskets);

  qualified.forEach((merch, i) => {
    const z = zs[i];
    if (z <= 2.0 || merch.avgBasketDzd < 5000) return;

    anomalies.push({
      id: nextId(),
      category: "revenue",
      severity: "info",
      confidence: confidence(merch.totalOrders, z),
      estimatedImpactDzd: 0,
      title: `${merch.name} — unusually high avg basket (${merch.avgBasketDzd.toFixed(0)} DZD)`,
      description: `Average basket of ${merch.avgBasketDzd.toFixed(0)} DZD is ${((merch.avgBasketDzd / m - 1) * 100).toFixed(1)}% above platform average (${m.toFixed(0)} DZD). Z-score: ${z.toFixed(2)}. May indicate premium product mix or data anomaly.`,
      detectedAt: NOW,
      merchantId: merch.merchantId,
      merchantName: merch.name,
      wilaya: null,
      provider: null,
      zScore: Number(z.toFixed(2)),
      metric: "avg_basket_dzd",
      metricValue: merch.avgBasketDzd,
      metricBaseline: Number(m.toFixed(0)),
    });
  });

  return anomalies;
}

// ── Cancellation spike (large block rate) ────────────────────────────────────

export function detectCancellationSpike(
  summaries: MerchantIntelSummary[],
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const qualified = summaries.filter((m) => m.totalOrders >= 20);
  if (qualified.length === 0) return [];

  const blockRates = qualified.map((m) => m.blockRate);
  const m = mean(blockRates);

  for (const merch of qualified) {
    if (merch.blockRate < 0.40 || merch.blockRate <= m * 1.8) continue;

    anomalies.push({
      id: nextId(),
      category: "fraud",
      severity: merch.blockRate >= 0.60 ? "critical" : "warning",
      confidence: confidence(merch.totalOrders, (merch.blockRate - m) * 5),
      estimatedImpactDzd: Math.round(merch.blockedOrders * merch.avgBasketDzd),
      title: `${merch.name} — cancellation spike (${(merch.blockRate * 100).toFixed(1)}% block rate)`,
      description: `Block rate of ${(merch.blockRate * 100).toFixed(1)}% is significantly above the platform average of ${(m * 100).toFixed(1)}%. This may indicate a sudden influx of fraudulent orders or a targeting issue.`,
      detectedAt: NOW,
      merchantId: merch.merchantId,
      merchantName: merch.name,
      wilaya: null,
      provider: null,
      zScore: m > 0 ? Number(((merch.blockRate - m) / m).toFixed(2)) : null,
      metric: "block_rate",
      metricValue: Number(merch.blockRate.toFixed(4)),
      metricBaseline: Number(m.toFixed(4)),
    });
  }

  return anomalies;
}
