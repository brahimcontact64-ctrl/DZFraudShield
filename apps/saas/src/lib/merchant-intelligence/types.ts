// Shared domain types for the Merchant Intelligence module.
// All values derived from real platform data — no fabricated fields.

// ── Shared sub-types ──────────────────────────────────────────────────────────

export type WilayaStat = {
  wilaya: string;
  orders: number;
  successRate: number;
  revenue: number;
};

export type ProviderStat = {
  provider: string;
  orders: number;
  successRate: number;
};

// ── Merchant scores ───────────────────────────────────────────────────────────

export type MerchantScores = {
  health: number;    // 0–100  (delivery success weighted against fraud block rate)
  delivery: number;  // 0–100  (pure delivery success + COD collection rate)
  trust: number;     // 0–100  (payment success, low block rate, subscription standing)
  composite: number; // weighted average of the three
};

// ── Merchant summary ──────────────────────────────────────────────────────────

export type MerchantIntelSummary = {
  merchantId: string;
  name: string;
  createdAt: string;
  accountStatus: string;

  // Order intelligence (from order_checks)
  totalOrders: number;
  blockedOrders: number;
  blockRate: number;       // 0–1
  avgBasketDzd: number;
  orderTrend: number[];    // last-12-month monthly order counts (sparkline)
  orderGrowthRate: number; // current-30d vs prev-30d, as a fraction (0.23 = +23%)

  // Delivery intelligence (from merchant_shipment_history)
  totalShipments: number;
  deliveredShipments: number;
  returnedShipments: number;
  refusedShipments: number;
  deliverySuccessRate: number; // 0–1
  grossRevenueDzd: number;     // sum(cod_amount) all shipments
  collectedRevenueDzd: number; // sum(cod_amount) WHERE payment_status = 'payed'
  codSuccessRate: number;      // payed / (total non-null cod_amount)
  revenueGrowthRate: number;   // current-30d vs prev-30d revenue, as a fraction

  // Customer intelligence
  uniqueCustomers: number;

  // Provider (dominant)
  topProvider: string | null;

  // Computed scores
  scores: MerchantScores;

  // Top dimensions
  topWilayas: WilayaStat[];
};

// ── Category intelligence ─────────────────────────────────────────────────────

export type AdRecommendation = "increase" | "maintain" | "reduce" | "pause";

export type CategoryIntel = {
  categoryName: string;
  totalOrders: number;
  totalUnits: number;
  grossRevenueDzd: number;
  deliveredOrders: number;
  returnedOrders: number;
  refusedOrders: number;
  pendingOrders: number;
  deliverySuccessRate: number; // 0–1
  avgOrderValueDzd: number;
  topWilayas: WilayaStat[];
  worstWilayas: WilayaStat[];
  adRecommendation: AdRecommendation;
  adRecommendationReason: string;
};

// ── Wilaya intelligence ───────────────────────────────────────────────────────

export type WilayaIntel = {
  wilaya: string;
  totalShipments: number;
  deliveredShipments: number;
  returnedShipments: number;
  refusedShipments: number;
  noAnswerShipments: number;
  deliverySuccessRate: number; // 0–1
  grossRevenueDzd: number;
  avgCodAmountDzd: number;
  avgDeliveryTimeDays: number | null;
  bestProvider: string | null;
  bestProviderSuccessRate: number | null;
  providerBreakdown: ProviderStat[];
  topCategories: Array<{ category: string; orders: number }>;
};

// ── Provider intelligence ─────────────────────────────────────────────────────

export type ProviderIntel = {
  provider: string;
  totalShipments: number;
  deliveredShipments: number;
  returnedShipments: number;
  refusedShipments: number;
  noAnswerShipments: number;
  pendingShipments: number;
  deliverySuccessRate: number; // 0–1
  returnRate: number;          // 0–1
  avgDeliveryTimeDays: number | null;
  codSuccessRate: number;      // payed / total
  merchantCount: number;
  topWilayas: WilayaStat[];
  worstWilayas: WilayaStat[];
};

// ── Insight engine ────────────────────────────────────────────────────────────

export type InsightType =
  | "merchant_growth"
  | "merchant_decline"
  | "category_opportunity"
  | "category_risk"
  | "wilaya_opportunity"
  | "wilaya_risk"
  | "provider_advantage"
  | "fraud_spike"
  | "delivery_failure_spike"
  | "revenue_drop"
  | "cod_refusal_spike";

export type InsightSeverity = "info" | "warning" | "critical";

export type BusinessInsight = {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  body: string;
  merchantId: string | null;
  merchantName: string | null;
};

export type BusinessAlert = {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  body: string;
  merchantId: string | null;
  merchantName: string | null;
};

// ── Platform overview (cross-merchant) ───────────────────────────────────────

export type PlatformOverview = {
  totalMerchants: number;
  activeMerchants: number;
  totalShipments: number;
  deliveredShipments: number;
  returnedShipments: number;
  platformDeliverySuccessRate: number;
  platformGrossRevenueDzd: number;
  platformCollectedRevenueDzd: number;
  totalOrderChecks: number;
  totalBlockedOrders: number;
  platformBlockRate: number;
  topCategories: Array<{ category: string; orders: number; successRate: number }>;
  topWilayas: WilayaStat[];
  topProviders: ProviderStat[];
};
