// Delivery forecast module.
//
// Projects delivery success rate, COD refusal rate, and return rate
// using current momentum (revenueGrowthRate, orderGrowthRate) as the trend signal.
// No time-series DB query — uses pre-aggregated metrics from MerchantIntelSummary.

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { ProviderIntel } from "@/lib/merchant-intelligence/types";
import type { ForecastDirection, ForecastPoint, ForecastSeries } from "./types";
import { mean, regressionConfidence, forecastIndexToCalendar } from "./math";

let _id = 0;
function nextId(): string { return `df-${++_id}`; }
export function resetDeliveryForecastIds(): void { _id = 0; }

// Clamp a rate to [0, 1]
function clampRate(r: number): number {
  return Math.max(0, Math.min(1, r));
}

function rateDirection(rate: number): ForecastDirection {
  if (rate > 0.08) return "growing";
  if (rate > 0.02) return "growing";
  if (rate < -0.08) return "collapsing";
  if (rate < -0.02) return "declining";
  return "stable";
}

// Build 3 monthly forecast points for a rate metric
function buildRatePoints(
  currentRate: number,
  momentumPerMonth: number,
  now: Date,
  confidence: number,
): ForecastPoint[] {
  const points: ForecastPoint[] = [];
  for (let ahead = 1; ahead <= 3; ahead++) {
    const xi = 11 + ahead;
    const cal = forecastIndexToCalendar(xi, now);
    const projected = clampRate(currentRate + momentumPerMonth * ahead);
    const margin = 0.03 * ahead;
    points.push({
      label: cal.label,
      month: cal.month,
      year: cal.year,
      predicted: Number(projected.toFixed(4)),
      lower: clampRate(projected - margin),
      upper: clampRate(projected + margin),
      confidence: Math.max(5, confidence - (ahead - 1) * 8),
    });
  }
  return points;
}

// ── Platform-wide delivery success rate forecast ──────────────────────────────

export function buildPlatformDeliveryForecast(
  summaries: MerchantIntelSummary[],
  now: Date,
): ForecastSeries {
  const qualified = summaries.filter((m) => m.totalShipments >= 10);
  if (qualified.length === 0) {
    return buildEmptyDeliveryForecast("Platform Delivery Success Rate", now);
  }

  const totalTerminal = qualified.reduce(
    (s, m) => s + m.deliveredShipments + m.returnedShipments + m.refusedShipments,
    0,
  );
  const totalDelivered = qualified.reduce((s, m) => s + m.deliveredShipments, 0);
  const currentRate = totalTerminal > 0 ? totalDelivered / totalTerminal : 0;

  // Momentum: weighted average of revenue growth rates
  const totalGross = qualified.reduce((s, m) => s + m.grossRevenueDzd, 0);
  const weightedMomentum = totalGross > 0
    ? qualified.reduce((s, m) => s + m.revenueGrowthRate * (m.grossRevenueDzd / totalGross), 0)
    : 0;

  // Small delivery rate change per month from momentum
  const momentumPerMonth = weightedMomentum * 0.02;
  const nextMonthRate = clampRate(currentRate + momentumPerMonth);
  const nextWeekRate = currentRate + momentumPerMonth / 4;

  const confidence = regressionConfidence(0.5, qualified.length);

  return {
    id: nextId(),
    name: "Platform Delivery Success Rate",
    description: "Expected delivery success rate (delivered ÷ terminal shipments) across all merchants.",
    unit: "rate",
    currentValue: Number(currentRate.toFixed(4)),
    direction: rateDirection(momentumPerMonth),
    slopePerMonth: Number(momentumPerMonth.toFixed(5)),
    slopeRatePerMonth: currentRate > 0 ? Number((momentumPerMonth / currentRate).toFixed(4)) : 0,
    nextWeekPrediction: Number(nextWeekRate.toFixed(4)),
    nextMonthPrediction: Number(nextMonthRate.toFixed(4)),
    confidence,
    r2: 0.5,
    dataPoints: qualified.length,
    points: buildRatePoints(currentRate, momentumPerMonth, now, confidence),
    merchantId: null,
    merchantName: null,
  };
}

// ── COD refusal rate forecast ─────────────────────────────────────────────────

export function buildCodRefusalForecast(
  summaries: MerchantIntelSummary[],
  now: Date,
): ForecastSeries {
  const qualified = summaries.filter((m) => m.totalShipments >= 10);
  if (qualified.length === 0) {
    return buildEmptyDeliveryForecast("COD Refusal Rate", now);
  }

  const codRefusalRates = qualified.map((m) => 1 - m.codSuccessRate);
  const currentRate = mean(codRefusalRates);

  // COD refusal momentum: merchants with high blockRate tend to have more refusals
  const avgBlockRate = mean(qualified.map((m) => m.blockRate));
  const momentumPerMonth = avgBlockRate > 0.2 ? 0.003 : avgBlockRate < 0.05 ? -0.002 : 0;

  const nextMonthRate = clampRate(currentRate + momentumPerMonth);
  const nextWeekRate = currentRate + momentumPerMonth / 4;
  const confidence = regressionConfidence(0.4, qualified.length);

  return {
    id: nextId(),
    name: "COD Refusal Rate (Est.)",
    description: "Expected proportion of shipments where COD payment is not collected.",
    unit: "rate",
    currentValue: Number(currentRate.toFixed(4)),
    direction: rateDirection(momentumPerMonth),
    slopePerMonth: Number(momentumPerMonth.toFixed(5)),
    slopeRatePerMonth: currentRate > 0 ? Number((momentumPerMonth / currentRate).toFixed(4)) : 0,
    nextWeekPrediction: Number(nextWeekRate.toFixed(4)),
    nextMonthPrediction: Number(nextMonthRate.toFixed(4)),
    confidence,
    r2: 0.4,
    dataPoints: qualified.length,
    points: buildRatePoints(currentRate, momentumPerMonth, now, confidence),
    merchantId: null,
    merchantName: null,
  };
}

// ── Return rate forecast ──────────────────────────────────────────────────────

export function buildReturnRateForecast(
  summaries: MerchantIntelSummary[],
  now: Date,
): ForecastSeries {
  const qualified = summaries.filter((m) => m.totalShipments >= 10);
  if (qualified.length === 0) {
    return buildEmptyDeliveryForecast("Return Rate", now);
  }

  const returnRates = qualified.map((m) => {
    const terminal = m.deliveredShipments + m.returnedShipments + m.refusedShipments;
    return terminal > 0 ? (m.returnedShipments + m.refusedShipments) / terminal : 0;
  });
  const currentRate = mean(returnRates);

  // Return rate momentum: inverse of delivery growth
  const avgRevenueGrowth = mean(qualified.map((m) => m.revenueGrowthRate));
  const momentumPerMonth = avgRevenueGrowth > 0 ? -0.002 : avgRevenueGrowth < 0 ? 0.003 : 0;

  const nextMonthRate = clampRate(currentRate + momentumPerMonth);
  const nextWeekRate = currentRate + momentumPerMonth / 4;
  const confidence = regressionConfidence(0.45, qualified.length);

  return {
    id: nextId(),
    name: "Return Rate (Est.)",
    description: "Expected proportion of shipments returned or refused.",
    unit: "rate",
    currentValue: Number(currentRate.toFixed(4)),
    direction: rateDirection(-momentumPerMonth),
    slopePerMonth: Number(momentumPerMonth.toFixed(5)),
    slopeRatePerMonth: currentRate > 0 ? Number((momentumPerMonth / currentRate).toFixed(4)) : 0,
    nextWeekPrediction: Number(nextWeekRate.toFixed(4)),
    nextMonthPrediction: Number(nextMonthRate.toFixed(4)),
    confidence,
    r2: 0.45,
    dataPoints: qualified.length,
    points: buildRatePoints(currentRate, momentumPerMonth, now, confidence),
    merchantId: null,
    merchantName: null,
  };
}

// ── Provider performance trends ───────────────────────────────────────────────

export function buildProviderDeliveryForecasts(
  providers: ProviderIntel[],
  now: Date,
): ForecastSeries[] {
  return providers
    .filter((p) => p.totalShipments >= 30)
    .map((p) => {
      const currentRate = p.deliverySuccessRate;
      // Provider momentum: based on COD success rate as a proxy for quality trajectory
      const momentumPerMonth = p.codSuccessRate > 0.7 ? 0.002 : p.codSuccessRate < 0.4 ? -0.003 : 0;
      const nextMonthRate = clampRate(currentRate + momentumPerMonth);
      const nextWeekRate = currentRate + momentumPerMonth / 4;
      const confidence = regressionConfidence(0.4, Math.min(100, p.totalShipments));

      return {
        id: nextId(),
        name: `${p.provider} — Delivery Rate`,
        description: `Provider ${p.provider}: ${p.totalShipments.toLocaleString()} shipments, ${p.merchantCount} merchants.`,
        unit: "rate" as const,
        currentValue: Number(currentRate.toFixed(4)),
        direction: rateDirection(momentumPerMonth),
        slopePerMonth: Number(momentumPerMonth.toFixed(5)),
        slopeRatePerMonth: currentRate > 0 ? Number((momentumPerMonth / currentRate).toFixed(4)) : 0,
        nextWeekPrediction: Number(nextWeekRate.toFixed(4)),
        nextMonthPrediction: Number(nextMonthRate.toFixed(4)),
        confidence,
        r2: 0.4,
        dataPoints: p.totalShipments,
        points: buildRatePoints(currentRate, momentumPerMonth, now, confidence),
        merchantId: null,
        merchantName: null,
      };
    });
}

// ── Empty forecast helper ─────────────────────────────────────────────────────

function buildEmptyDeliveryForecast(name: string, now: Date): ForecastSeries {
  return {
    id: nextId(),
    name,
    description: "Insufficient data to generate forecast.",
    unit: "rate",
    currentValue: 0,
    direction: "stable",
    slopePerMonth: 0,
    slopeRatePerMonth: 0,
    nextWeekPrediction: 0,
    nextMonthPrediction: 0,
    confidence: 5,
    r2: 0,
    dataPoints: 0,
    points: [],
    merchantId: null,
    merchantName: null,
  };
}
