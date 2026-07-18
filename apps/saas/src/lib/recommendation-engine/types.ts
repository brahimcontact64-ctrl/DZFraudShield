// Shared types for the Recommendation Engine.
// All recommendations are derived from real platform data — never fabricated.

// ── Category ──────────────────────────────────────────────────────────────────

export type RecommendationCategory =
  | "advertising"
  | "delivery"
  | "products"
  | "pricing"
  | "merchant_health"
  | "regional"
  | "customer";

// ── Type ──────────────────────────────────────────────────────────────────────

export type RecommendationType =
  // Advertising
  | "advertising_increase"
  | "advertising_reduce"
  | "advertising_pause"
  | "advertising_region_focus"
  // Delivery
  | "delivery_provider_switch"
  | "delivery_use_stopdesk"
  | "delivery_confirmation_calls"
  | "delivery_prepayment"
  | "delivery_free_shipping_region"
  // Products
  | "product_best_seller"
  | "product_growing"
  | "product_declining"
  | "product_high_returns"
  | "product_bundle_opportunity"
  | "product_discontinue"
  | "product_promote_region"
  // Pricing
  | "pricing_increase_cod"
  | "pricing_reduce_discount"
  | "pricing_free_shipping_threshold"
  | "pricing_margin_improvement"
  // Merchant health
  | "merchant_growing"
  | "merchant_needs_attention"
  | "merchant_fraud_spike"
  | "merchant_customer_decline"
  | "merchant_delivery_decline"
  | "merchant_cod_refusal"
  // Regional
  | "regional_opportunity"
  | "regional_risk"
  | "regional_emerging"
  | "regional_high_value"
  // Customer
  | "customer_repeat_buyers"
  | "customer_new_declining"
  | "customer_high_value_segment";

// ── Priority ──────────────────────────────────────────────────────────────────

export type RecommendationPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// ── Recommended action ────────────────────────────────────────────────────────

export type RecommendedAction = {
  label: string;
  description: string;
};

// ── Core recommendation ───────────────────────────────────────────────────────

export type Recommendation = {
  id: string;
  merchantId: string | null;
  merchantName: string | null;
  category: RecommendationCategory;
  type: RecommendationType;
  priority: RecommendationPriority;
  title: string;
  description: string;
  reason: string;
  businessImpact: string;
  estimatedSavingsDzd: number;
  estimatedRevenueIncreaseDzd: number;
  confidenceScore: number;   // 0–100
  generatedAt: string;
  requiredDataSources: string[];
  recommendedActions: RecommendedAction[];
  // Optional context fields
  productId?: string;
  productName?: string;
  wilaya?: string;
  provider?: string;
  categoryName?: string;
};

// ── Engine output ─────────────────────────────────────────────────────────────

export type RecommendationEngineSummary = {
  totalRecommendations: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  totalEstimatedSavingsDzd: number;
  totalEstimatedRevenueDzd: number;
  merchantsAnalyzed: number;
  categoryCounts: Record<RecommendationCategory, number>;
  generatedAt: string;
};

export type RecommendationEngineOutput = {
  recommendations: Recommendation[];
  summary: RecommendationEngineSummary;
};
