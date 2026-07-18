// Backtesting service.
//
// Validates forecast accuracy by hiding the most recent historical period,
// predicting it from earlier data, and comparing prediction to actual.
//
// Uses only real historical data — no synthetic values.
// Reports MAE, MAPE, absolute error, and directional accuracy.
// Requires MIN_BACKTEST_HISTORY months of training data to run.

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import { linearRegression, predict, mean } from "./math";
import { MIN_SAMPLES, nonZeroMonths } from "./sample-guards";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BacktestMetric = {
  metricName: string;
  unit: "orders" | "DZD" | "rate";
  actual: number;
  predicted: number;
  absoluteError: number;
  percentageError: number | null;   // null when actual = 0
  directionallyCorrect: boolean;    // predicted direction matches actual change
  trainingMonths: number;
  holdoutMonths: number;
  dataSufficient: boolean;
  insufficiencyReason: string | null;
};

export type BacktestResult = {
  metrics: BacktestMetric[];
  mae: number;                      // mean absolute error across all metrics
  mapeValid: number | null;         // mean absolute percentage error (null if any actual=0)
  directionalAccuracy: number;      // fraction of metrics where direction was correct
  sampleCount: number;
  holdoutPeriodMonths: number;
  generatedAt: string;
  dataSufficient: boolean;
  insufficiencyReason: string | null;
};

const HOLDOUT = MIN_SAMPLES.BACKTEST_HOLDOUT;         // 3 months
const MIN_TRAINING = MIN_SAMPLES.BACKTEST_MIN_HISTORY; // 9 months

// ── Helpers ───────────────────────────────────────────────────────────────────

function mape(errors: Array<{ actual: number; absoluteError: number }>): number | null {
  const valid = errors.filter((e) => e.actual > 0);
  if (valid.length === 0) return null;
  return mean(valid.map((e) => e.absoluteError / e.actual)) * 100;
}

function directionallyCorrect(
  trainingPrev: number,
  trainingLast: number,
  actual: number,
  predicted: number,
): boolean {
  const actualDir = actual >= trainingLast ? 1 : -1;
  const predictedDir = predicted >= trainingLast ? 1 : -1;
  return actualDir === predictedDir;
}

// ── Single series backtest ────────────────────────────────────────────────────

function backtestSeries(
  series: number[],
  metricName: string,
  unit: BacktestMetric["unit"],
): BacktestMetric {
  const n = series.length;
  const nonZero = nonZeroMonths(series);

  if (n < HOLDOUT + MIN_TRAINING || nonZero < HOLDOUT + 3) {
    return {
      metricName,
      unit,
      actual: series[n - 1] ?? 0,
      predicted: 0,
      absoluteError: 0,
      percentageError: null,
      directionallyCorrect: false,
      trainingMonths: 0,
      holdoutMonths: HOLDOUT,
      dataSufficient: false,
      insufficiencyReason: `Requires ≥${HOLDOUT + MIN_TRAINING} months of history — only ${n} available with ${nonZero} non-zero.`,
    };
  }

  // Split: training = all but last HOLDOUT, actual = average of last HOLDOUT
  const training = series.slice(0, n - HOLDOUT);
  const holdout = series.slice(n - HOLDOUT);
  const actualValue = mean(holdout);

  // Forecast holdout start from training regression
  const reg = linearRegression(training);
  const forecastX = training.length; // predict first holdout month
  const predictedValue = Math.max(0, predict(reg, forecastX));

  const absoluteError = Math.abs(actualValue - predictedValue);
  const percentageError = actualValue > 0 ? (absoluteError / actualValue) * 100 : null;
  const lastTraining = training[training.length - 1] ?? 0;

  return {
    metricName,
    unit,
    actual: Number(actualValue.toFixed(unit === "rate" ? 4 : 0)),
    predicted: Number(predictedValue.toFixed(unit === "rate" ? 4 : 0)),
    absoluteError: Number(absoluteError.toFixed(unit === "rate" ? 4 : 0)),
    percentageError: percentageError !== null ? Number(percentageError.toFixed(1)) : null,
    directionallyCorrect: directionallyCorrect(
      training[training.length - 2] ?? lastTraining,
      lastTraining,
      actualValue,
      predictedValue,
    ),
    trainingMonths: training.length,
    holdoutMonths: HOLDOUT,
    dataSufficient: true,
    insufficiencyReason: null,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function runBacktest(summaries: MerchantIntelSummary[]): BacktestResult {
  const generatedAt = new Date().toISOString();
  const metrics: BacktestMetric[] = [];

  if (summaries.length === 0) {
    return {
      metrics: [],
      mae: 0,
      mapeValid: null,
      directionalAccuracy: 0,
      sampleCount: 0,
      holdoutPeriodMonths: HOLDOUT,
      generatedAt,
      dataSufficient: false,
      insufficiencyReason: "No merchant data available.",
    };
  }

  // ── Platform orders ───────────────────────────────────────────────────────
  const platformOrders = new Array<number>(12).fill(0);
  for (const m of summaries) {
    for (let i = 0; i < 12; i++) {
      platformOrders[i] += m.orderTrend[i] ?? 0;
    }
  }
  metrics.push(backtestSeries(platformOrders, "Platform Monthly Orders", "orders"));

  // ── Platform revenue (estimated) ──────────────────────────────────────────
  const totalShipments = summaries.reduce((s, m) => s + m.totalShipments, 0);
  const totalDelivered  = summaries.reduce((s, m) => s + m.deliveredShipments, 0);
  const totalGross      = summaries.reduce((s, m) => s + m.grossRevenueDzd, 0);
  const deliveryRate    = totalShipments > 0 ? totalDelivered / totalShipments : 0.6;
  const avgBasket       = totalShipments > 0 ? totalGross / totalShipments : 2000;

  const platformRevenue = platformOrders.map((orders) =>
    Math.round(orders * avgBasket * deliveryRate),
  );
  metrics.push(backtestSeries(platformRevenue, "Platform Revenue (Est.)", "DZD"));

  // ── Delivery success rate (platform) ─────────────────────────────────────
  // We approximate a monthly delivery rate series from aggregate merchant data.
  // Use the trailing orderTrend weighted by each merchant's delivery rate.
  const deliveryRateSeries = platformOrders.map((totalOrders, i) => {
    if (totalOrders === 0) return 0;
    const weightedRate = summaries.reduce((s, m) => {
      const monthOrders = m.orderTrend[i] ?? 0;
      return s + monthOrders * m.deliverySuccessRate;
    }, 0);
    return weightedRate / totalOrders;
  });
  metrics.push(backtestSeries(deliveryRateSeries, "Platform Delivery Success Rate", "rate"));

  // ── COD refusal rate (platform) ───────────────────────────────────────────
  const codRefusalSeries = platformOrders.map((totalOrders, i) => {
    if (totalOrders === 0) return 0;
    const weightedRefusal = summaries.reduce((s, m) => {
      const monthOrders = m.orderTrend[i] ?? 0;
      const refusalRate = Math.max(0, 1 - m.codSuccessRate);
      return s + monthOrders * refusalRate;
    }, 0);
    return weightedRefusal / totalOrders;
  });
  metrics.push(backtestSeries(codRefusalSeries, "Platform COD Refusal Rate", "rate"));

  // ── Return rate (platform) ────────────────────────────────────────────────
  const returnRateSeries = platformOrders.map((totalOrders, i) => {
    if (totalOrders === 0) return 0;
    const weightedReturn = summaries.reduce((s, m) => {
      const monthOrders = m.orderTrend[i] ?? 0;
      const returnRate = m.totalShipments > 0
        ? m.returnedShipments / m.totalShipments
        : 0;
      return s + monthOrders * returnRate;
    }, 0);
    return weightedReturn / totalOrders;
  });
  metrics.push(backtestSeries(returnRateSeries, "Platform Return Rate", "rate"));

  // ── Summary statistics ────────────────────────────────────────────────────
  const sufficient = metrics.filter((m) => m.dataSufficient);
  const mae = sufficient.length > 0
    ? mean(sufficient.map((m) => m.absoluteError))
    : 0;
  const mapeValid = sufficient.length > 0
    ? mape(sufficient)
    : null;
  const directionalAcc = sufficient.length > 0
    ? sufficient.filter((m) => m.directionallyCorrect).length / sufficient.length
    : 0;

  const overallSufficient = sufficient.length > 0;

  return {
    metrics,
    mae: Number(mae.toFixed(2)),
    mapeValid: mapeValid !== null ? Number(mapeValid.toFixed(1)) : null,
    directionalAccuracy: Number(directionalAcc.toFixed(3)),
    sampleCount: summaries.length,
    holdoutPeriodMonths: HOLDOUT,
    generatedAt,
    dataSufficient: overallSufficient,
    insufficiencyReason: overallSufficient
      ? null
      : `Insufficient historical data for backtesting. Need ≥${HOLDOUT + MIN_TRAINING} months with data.`,
  };
}
