// Shared minimum-sample helpers used across all analytics modules.
//
// Every forecast, trend, anomaly, and strategy output must pass a
// minimum-sample check before being published. When data is insufficient
// the caller returns a safe "insufficient_data" marker rather than a
// fabricated value.

export type SampleVerdict = {
  dataSufficient: boolean;
  sampleSize: number;
  minimumSampleSize: number;
  confidence: number;         // 0-100, scales with sample size
  insufficiencyReason: string | null;
};

// ── Thresholds ────────────────────────────────────────────────────────────────

export const MIN_SAMPLES = {
  // Forecasts
  PLATFORM_FORECAST:    6,   // ≥6 months of non-zero history for regression
  MERCHANT_FORECAST:    6,   // Per-merchant order forecast
  DELIVERY_FORECAST:    10,  // Delivery rate is noisier; needs more points

  // Anomalies
  MERCHANT_ANOMALY:     5,   // orders
  CATEGORY_ANOMALY:     10,  // orders
  WILAYA_ANOMALY:       20,  // shipments
  PROVIDER_ANOMALY:     30,  // shipments
  COD_ANOMALY:          20,  // shipments for avg-basket comparison

  // Trends
  CATEGORY_TREND:       10,
  WILAYA_TREND:         20,
  PROVIDER_TREND:       30,
  MERCHANT_TREND:       10,

  // Strategy / simulator
  STRATEGY:             5,   // orders for strategy generation
  SIMULATION:           5,   // orders for simulation

  // Seasonality
  SEASONALITY_TOTAL:    500, // total platform orders across 12 months
  SEASONALITY_MONTHLY:  5,   // min orders in any single month to count it

  // Backtesting
  BACKTEST_HOLDOUT:     3,   // months to hold out for backtesting
  BACKTEST_MIN_HISTORY: 9,   // months of training data needed

  // Provider comparison
  PROVIDER_COMPARE:     10,  // min shipments to include in comparison
} as const;

// ── Verdict builders ──────────────────────────────────────────────────────────

export function checkSample(
  sampleSize: number,
  minimumSampleSize: number,
  label = "data points",
): SampleVerdict {
  const dataSufficient = sampleSize >= minimumSampleSize;
  const ratio = minimumSampleSize > 0 ? Math.min(1, sampleSize / minimumSampleSize) : 1;
  const confidence = Math.round(ratio * 80);

  return {
    dataSufficient,
    sampleSize,
    minimumSampleSize,
    confidence,
    insufficiencyReason: dataSufficient
      ? null
      : `Requires at least ${minimumSampleSize} ${label} — only ${sampleSize} available.`,
  };
}

// ── Count non-zero months in a series ────────────────────────────────────────
// A month with zero orders may be a data ingestion gap, not real inactivity.
// We require a minimum of non-zero months for meaningful regression.

export function nonZeroMonths(series: number[]): number {
  return series.filter((v) => v > 0).length;
}

// ── Guard for regression: must have enough non-zero months ───────────────────

export function checkRegressionReadiness(
  series: number[],
  min: number,
): SampleVerdict {
  const nz = nonZeroMonths(series);
  return checkSample(nz, min, "non-zero months");
}

// ── Rate validity check ───────────────────────────────────────────────────────
// A rate derived from 0 terminal outcomes is meaningless (all orders still in transit).

export function checkRateValidity(
  terminalCount: number,
  totalCount: number,
  minTerminal = 10,
): { valid: boolean; reason: string | null } {
  if (totalCount === 0) {
    return { valid: false, reason: "No records to compute a rate from." };
  }
  if (terminalCount < minTerminal) {
    return {
      valid: false,
      reason: `Only ${terminalCount} terminal delivery outcomes — rate is not yet meaningful. Need ≥${minTerminal}.`,
    };
  }
  const nonTerminalRatio = (totalCount - terminalCount) / totalCount;
  if (nonTerminalRatio > 0.5) {
    return {
      valid: false,
      reason: `${(nonTerminalRatio * 100).toFixed(0)}% of shipments are still in transit — success rate is premature.`,
    };
  }
  return { valid: true, reason: null };
}

// ── Financial impact range (conservative, expected, optimistic) ───────────────

export type ImpactRange = {
  estimatedLow: number;
  estimatedExpected: number;
  estimatedHigh: number;
  currency: "DZD";
  confidence: number;
  assumptions: string;
};

export function buildImpactRange(
  expected: number,
  confidence: number,
  assumptions: string,
): ImpactRange {
  const lowFactor = 0.4;
  const highFactor = 1.6;
  return {
    estimatedLow:      Math.round(expected * lowFactor),
    estimatedExpected: Math.round(expected),
    estimatedHigh:     Math.round(expected * highFactor),
    currency:          "DZD",
    confidence,
    assumptions,
  };
}
