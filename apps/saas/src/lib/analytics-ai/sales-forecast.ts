// Sales forecast module.
//
// Uses linear regression on the 12-month orderTrend arrays from MerchantIntelSummary
// to project future order volumes and revenue.
//
// Statistical model:
//   y = slope × x + intercept  (x = month index 0–11)
//   Forecast for x=12 (next month), x=13, x=14
//   Next week = next month / 4 (approximation from monthly data)

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { ForecastDirection, ForecastPoint, ForecastSeries } from "./types";
import {
  linearRegression,
  predict,
  confidenceBounds,
  regressionConfidence,
  mean,
  forecastIndexToCalendar,
} from "./math";

let _id = 0;
function nextId(): string { return `sf-${++_id}`; }
export function resetSalesForecastIds(): void { _id = 0; }

function direction(slope: number, meanVal: number): ForecastDirection {
  if (meanVal === 0) return "stable";
  const rate = slope / meanVal;
  if (rate > 0.15) return "exploding";
  if (rate > 0.03) return "growing";
  if (rate < -0.15) return "collapsing";
  if (rate < -0.03) return "declining";
  return "stable";
}

function buildPoints(
  reg: ReturnType<typeof linearRegression>,
  n: number,
  now: Date,
  unit: "orders" | "DZD",
): ForecastPoint[] {
  const points: ForecastPoint[] = [];
  for (let xi = 12; xi <= 14; xi++) {
    const cal = forecastIndexToCalendar(xi, now);
    const p = predict(reg, xi);
    const { lower, upper } = confidenceBounds(reg, xi, n);
    const conf = regressionConfidence(reg.r2, n);
    points.push({
      label: cal.label,
      month: cal.month,
      year: cal.year,
      predicted: Math.round(unit === "DZD" ? p : p),
      lower: Math.max(0, Math.round(lower)),
      upper: Math.round(upper),
      confidence: Math.max(5, conf - (xi - 12) * 5),
    });
  }
  return points;
}

// ── Platform-wide sales forecast ──────────────────────────────────────────────

export function buildPlatformSalesForecast(
  summaries: MerchantIntelSummary[],
  now: Date,
): ForecastSeries {
  // Sum all merchants' orderTrend arrays into platform monthly totals
  const platform = new Array<number>(12).fill(0);
  for (const m of summaries) {
    for (let i = 0; i < 12; i++) {
      platform[i] += m.orderTrend[i] ?? 0;
    }
  }

  const reg = linearRegression(platform);
  const currentValue = platform[11] ?? 0;
  const nextMonthPrediction = Math.round(predict(reg, 12));
  const nextWeekPrediction = Math.round(nextMonthPrediction / 4);
  const m = mean(platform);
  const slopeRatePerMonth = m > 0 ? reg.slope / m : 0;
  const conf = regressionConfidence(reg.r2, 12);

  return {
    id: nextId(),
    name: "Platform Monthly Orders",
    description: "Total order checks (fraud verification requests) across all merchants per month.",
    unit: "orders",
    currentValue,
    direction: direction(reg.slope, m),
    slopePerMonth: Math.round(reg.slope),
    slopeRatePerMonth: Number(slopeRatePerMonth.toFixed(4)),
    nextWeekPrediction,
    nextMonthPrediction,
    confidence: conf,
    r2: Number(reg.r2.toFixed(3)),
    dataPoints: 12,
    points: buildPoints(reg, 12, now, "orders"),
    merchantId: null,
    merchantName: null,
  };
}

// ── Platform revenue forecast ─────────────────────────────────────────────────

export function buildPlatformRevenueForecast(
  summaries: MerchantIntelSummary[],
  now: Date,
): ForecastSeries {
  const platform = new Array<number>(12).fill(0);
  for (const m of summaries) {
    for (let i = 0; i < 12; i++) {
      platform[i] += m.orderTrend[i] ?? 0;
    }
  }

  // Estimate revenue: orders × platform avg basket × platform delivery rate
  const totalShipments = summaries.reduce((s, m) => s + m.totalShipments, 0);
  const totalDelivered = summaries.reduce((s, m) => s + m.deliveredShipments, 0);
  const totalGrossRevenue = summaries.reduce((s, m) => s + m.grossRevenueDzd, 0);
  const platformDeliveryRate = totalShipments > 0 ? totalDelivered / totalShipments : 0.6;
  const platformAvgBasket = totalShipments > 0 ? totalGrossRevenue / totalShipments : 2000;

  // Convert order counts to revenue estimates
  const revenueByMonth = platform.map((orders) =>
    Math.round(orders * platformAvgBasket * platformDeliveryRate),
  );

  const reg = linearRegression(revenueByMonth);
  const currentValue = revenueByMonth[11] ?? 0;
  const nextMonthPrediction = Math.round(predict(reg, 12));
  const nextWeekPrediction = Math.round(nextMonthPrediction / 4);
  const m = mean(revenueByMonth);
  const slopeRatePerMonth = m > 0 ? reg.slope / m : 0;
  const conf = regressionConfidence(reg.r2, 12);

  return {
    id: nextId(),
    name: "Platform Revenue (Est.)",
    description: `Estimated collected revenue: orders × avg basket (${Math.round(platformAvgBasket).toLocaleString("fr-DZ")} DZD) × delivery rate (${(platformDeliveryRate * 100).toFixed(1)}%).`,
    unit: "DZD",
    currentValue,
    direction: direction(reg.slope, m),
    slopePerMonth: Math.round(reg.slope),
    slopeRatePerMonth: Number(slopeRatePerMonth.toFixed(4)),
    nextWeekPrediction,
    nextMonthPrediction,
    confidence: conf,
    r2: Number(reg.r2.toFixed(3)),
    dataPoints: 12,
    points: buildPoints(reg, 12, now, "DZD"),
    merchantId: null,
    merchantName: null,
  };
}

// ── Per-merchant sales forecasts (top N by revenue) ───────────────────────────

export function buildMerchantSalesForecasts(
  summaries: MerchantIntelSummary[],
  now: Date,
  topN = 10,
): ForecastSeries[] {
  const qualified = [...summaries]
    .filter((m) => m.totalOrders >= 10)
    .sort((a, b) => b.grossRevenueDzd - a.grossRevenueDzd)
    .slice(0, topN);

  return qualified.map((m) => {
    const trend = m.orderTrend;
    const reg = linearRegression(trend);
    const currentValue = trend[11] ?? 0;
    const nextMonthPrediction = Math.round(predict(reg, 12));
    const nextWeekPrediction = Math.round(nextMonthPrediction / 4);
    const mv = mean(trend);
    const slopeRatePerMonth = mv > 0 ? reg.slope / mv : 0;
    const conf = regressionConfidence(reg.r2, 12);

    return {
      id: nextId(),
      name: `${m.name} — Monthly Orders`,
      description: `Order trend for ${m.name}. Current avg basket: ${m.avgBasketDzd.toFixed(0)} DZD, delivery rate: ${(m.deliverySuccessRate * 100).toFixed(1)}%.`,
      unit: "orders" as const,
      currentValue,
      direction: direction(reg.slope, mv),
      slopePerMonth: Number(reg.slope.toFixed(1)),
      slopeRatePerMonth: Number(slopeRatePerMonth.toFixed(4)),
      nextWeekPrediction,
      nextMonthPrediction,
      confidence: conf,
      r2: Number(reg.r2.toFixed(3)),
      dataPoints: 12,
      points: buildPoints(reg, 12, now, "orders"),
      merchantId: m.merchantId,
      merchantName: m.name,
    };
  });
}
