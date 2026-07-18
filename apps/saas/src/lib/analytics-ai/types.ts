// Predictive Analytics types.
// All predictions derived from historical platform data — statistical models only.
// No LLM, no AI API, no fabricated values.

export type ForecastDirection = "exploding" | "growing" | "stable" | "declining" | "collapsing";

export type ForecastPoint = {
  label: string;         // "Aug 2026"
  month: number;         // 1-based calendar month
  year: number;
  predicted: number;
  lower: number;         // 80% CI lower bound
  upper: number;         // 80% CI upper bound
  confidence: number;    // 0-100
};

export type ForecastSeries = {
  id: string;
  name: string;
  description: string;
  unit: "DZD" | "orders" | "rate" | "days";
  currentValue: number;
  direction: ForecastDirection;
  slopePerMonth: number;      // absolute change per month
  slopeRatePerMonth: number;  // fractional change per month
  nextWeekPrediction: number;
  nextMonthPrediction: number;
  confidence: number;         // 0-100
  r2: number;                 // regression R² (0-1)
  dataPoints: number;
  points: ForecastPoint[];    // 3-month forward forecast
  merchantId: string | null;
  merchantName: string | null;
};

export type AnomalyCategory =
  | "revenue" | "delivery" | "fraud" | "merchant" | "wilaya" | "provider" | "customer";

export type AnomalySeverity = "info" | "warning" | "critical";

export type Anomaly = {
  id: string;
  category: AnomalyCategory;
  severity: AnomalySeverity;
  confidence: number;
  estimatedImpactDzd: number;
  title: string;
  description: string;
  detectedAt: string;
  merchantId: string | null;
  merchantName: string | null;
  wilaya: string | null;
  provider: string | null;
  zScore: number | null;
  metric: string;
  metricValue: number;
  metricBaseline: number;
};

export type TrendEntityType = "merchant" | "category" | "wilaya" | "provider";

export type TrendSignal = {
  id: string;
  entity: string;
  entityType: TrendEntityType;
  direction: ForecastDirection;
  magnitude: number;              // growth rate fraction
  confidence: number;
  description: string;
  estimatedRevenueImpactDzd: number;
  merchantId: string | null;
};

export type SeasonalPhase = "peak" | "trough" | "rising" | "falling" | "neutral";

export type SeasonalPattern = {
  id: string;
  name: string;
  description: string;
  peakMonthLabels: string[];
  troughMonthLabels: string[];
  amplitude: number;              // (peak - mean) / mean
  confidence: number;
  currentPhase: SeasonalPhase;
  currentMonthLabel: string;
  platformOrdersAtPeak: number;
  platformOrdersAtTrough: number;
};

export type AnalyticsAIOutput = {
  salesForecasts: ForecastSeries[];
  deliveryForecasts: ForecastSeries[];
  anomalies: Anomaly[];
  trends: TrendSignal[];
  seasonal: SeasonalPattern[];
  backtest: import("./backtesting").BacktestResult;
  dataQualityReport: import("./data-quality").DataQualityReport;
  generatedAt: string;
  dataQuality: {
    merchantsAnalyzed: number;
    monthsOfHistory: number;
    totalDataPoints: number;
    avgPlatformOrdersPerMonth: number;
  };
};
