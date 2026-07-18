// Strategy Engine types.
//
// The strategy engine behaves like an experienced e-commerce consultant.
// For each merchant it answers: "If I owned this merchant, what would I do?"
// All strategies are derived from real platform data — no fabricated values.

export type StrategyActionCategory =
  | "advertising" | "delivery" | "products" | "pricing" | "regional" | "customer" | "operations";

export type StrategyTimeToValue = "immediate" | "1-2 weeks" | "1 month" | "3+ months";

export type StrategyAction = {
  rank: number;
  category: StrategyActionCategory;
  title: string;
  why: string;                    // data-driven reason
  expectedROI: string;            // human-readable estimate
  confidence: number;             // 0-100
  estimatedImpactDzd: number;
  timeToValue: StrategyTimeToValue;
};

export type MerchantStrategyPriority = "critical" | "high" | "medium" | "low";

export type MerchantStrategy = {
  merchantId: string;
  merchantName: string;
  generatedAt: string;
  overallHealthScore: number;            // 0-100 (from existing scores)
  strategicPriority: MerchantStrategyPriority;
  executiveSummary: string;              // 2-3 sentence consultant view
  expectedRevenueIncreaseDzd: number;
  expectedDeliveryImprovement: number;   // fraction (e.g. 0.08 = +8%)
  expectedRefusalReduction: number;      // fraction
  topActions: StrategyAction[];          // up to 10 ranked actions
  advertisingStrategy: string;
  deliveryStrategy: string;
  productStrategy: string;
  pricingStrategy: string;
  regionalStrategy: string;
  customerStrategy: string;
  growthStrategy: string;
};

// ── Decision simulator types ──────────────────────────────────────────────────

export type SimulationScenarioType =
  | "switch_provider"
  | "remove_worst_wilaya"
  | "focus_top_wilayas"
  | "increase_price"
  | "decrease_price"
  | "require_confirmation_calls"
  | "pause_advertising_bad_wilayas";

export type SimulationScenario = {
  type: SimulationScenarioType;
  label: string;
  params: {
    targetProvider?: string;
    priceChangePct?: number;
    topWilayaCount?: number;
    worstWilayaName?: string;
  };
};

export type SimulationMetrics = {
  deliverySuccessRate: number;
  returnRate: number;
  codRefusalRate: number;
  estimatedMonthlyOrdersDzd: number;
  estimatedMonthlyCollectedDzd: number;
  blockRate: number;
};

export type DecisionSimulationResult = {
  scenario: SimulationScenario;
  before: SimulationMetrics;
  after: SimulationMetrics;
  delta: SimulationMetrics;
  confidence: number;
  recommendation: "proceed" | "caution" | "avoid";
  reasoning: string;
};

export type StrategyEngineOutput = {
  merchantStrategies: MerchantStrategy[];
  generatedAt: string;
  merchantsAnalyzed: number;
};

// ── Simulator input data (passed to client component) ─────────────────────────

export type SimulatorMerchantData = {
  merchantId: string;
  merchantName: string;
  totalOrders: number;
  totalShipments: number;
  deliverySuccessRate: number;
  codSuccessRate: number;
  blockRate: number;
  avgBasketDzd: number;
  grossRevenueDzd: number;
  topProvider: string | null;
  topWilayas: Array<{ wilaya: string; orders: number; successRate: number; revenue: number }>;
};

export type SimulatorProviderData = {
  provider: string;
  deliverySuccessRate: number;
  totalShipments: number;
};

export type SimulatorWilayaData = {
  wilaya: string;
  deliverySuccessRate: number;
  totalShipments: number;
  avgCodAmountDzd: number;
};
