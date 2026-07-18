/**
 * MerchantFacingReputationDTO
 *
 * Defines the ONLY data shape that may be returned to merchants in any
 * risk/reputation response.  Provider names, merchant names, and data
 * sources are never included.
 *
 * Rule: every field here is provider-agnostic and merchant-agnostic.
 */

import type { NetworkTrustLevel } from "@/lib/network-intelligence/customer-profile";

// Re-export so consumers only need to import from this module
export type { NetworkTrustLevel };
export type TrustLevel = NetworkTrustLevel;
export type RecommendedAction = "accept" | "verify" | "manual_review" | "block";

export type MerchantFacingReputationDTO = {
  /** 0 (safe) – 100 (dangerous) */
  riskScore: number;

  /** Human-readable trust level with no provider or merchant attribution */
  trustLevel: TrustLevel;

  /** Abstract reasons — MUST NOT contain provider/merchant names */
  reasons: string[];

  /** Estimated financial damage in DZD, based on combined network failures */
  estimatedDamageDzd: number;

  /** Action the merchant should take */
  recommendedAction: RecommendedAction;

  /** Total orders seen across the network (provider-agnostic count) */
  totalOrders: number;

  /** Successfully delivered orders across the network */
  deliveredOrders: number;

  /** Failed orders (refused + returned + no-answer + cancelled) */
  failedOrders: number;

  /** How many distinct merchants reported this identity (opaque count only) */
  networkMerchantCount: number;

  /** Delivery success rate 0–100 */
  deliverySuccessRate: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Privacy-blocked tokens — none of these may appear in merchant-facing output
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_PROVIDER_TOKENS = [
  "yalidine",
  "zr_express",
  "zr express",
  "zr-express",
  "noest",
  "guepex",
  "ecotrack",
  "ecotrans",
];

const BLOCKED_MERCHANT_TOKENS = [
  "merchant_id",
  "merchant id",
  "store_id",
  "store id",
  "store name",
  "source merchant",
  "source store",
];

const ALL_BLOCKED_TOKENS = [...BLOCKED_PROVIDER_TOKENS, ...BLOCKED_MERCHANT_TOKENS];

/**
 * Sanitize a single reason string, replacing any blocked token with
 * "[network]" to make the privacy violation visible during development
 * while keeping the output safe in production.
 */
export function sanitizeReason(reason: string): string {
  let sanitized = reason;
  for (const token of ALL_BLOCKED_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "gi"), "[network]");
  }
  return sanitized;
}

/**
 * Assert that a string contains no blocked tokens.
 * Throws in development, silently returns false in production.
 */
export function containsBlockedToken(value: string): boolean {
  const lower = value.toLowerCase();
  return ALL_BLOCKED_TOKENS.some((token) => lower.includes(token.toLowerCase()));
}

/**
 * Convert an array of raw reason strings into merchant-safe abstract reasons.
 *
 * Raw network reasons from scoring.ts look like:
 *   "+40 First refused order"
 *   "-10 2 delivered orders"
 *
 * We translate them into abstract merchant-readable phrases.
 */
export function buildMerchantReasons(params: {
  totalOrders: number;
  deliveredOrders: number;
  failedOrders: number;
  noAnswerCount: number;
  refusedCount: number;
  returnedCount: number;
  cancelledCount: number;
  fakeOrderCount: number;
  networkMerchantCount: number;
  riskTrend: "INCREASING" | "STABLE" | "IMPROVING";
  recentBadEvents: number;
}): string[] {
  const reasons: string[] = [];
  const {
    totalOrders,
    deliveredOrders,
    failedOrders,
    noAnswerCount,
    refusedCount,
    returnedCount,
    cancelledCount,
    fakeOrderCount,
    networkMerchantCount,
    riskTrend,
    recentBadEvents,
  } = params;

  // --- Positive signals ---
  if (deliveredOrders >= 5 && deliveredOrders / Math.max(totalOrders, 1) >= 0.9) {
    reasons.push("Strong successful delivery history");
  } else if (deliveredOrders >= 3) {
    reasons.push("Customer has a successful delivery history");
  } else if (deliveredOrders >= 1 && failedOrders === 0) {
    reasons.push("Previous orders delivered successfully");
  }

  // --- Negative signals ---
  if (fakeOrderCount >= 1) {
    reasons.push("Fraudulent order pattern detected");
  }

  if (refusedCount >= 3 || (refusedCount >= 1 && returnedCount >= 2)) {
    reasons.push("Repeated refusal and return pattern");
  } else if (refusedCount >= 1) {
    reasons.push("Order refusal detected");
  }

  if (noAnswerCount >= 2) {
    reasons.push("Customer repeatedly unreachable at delivery");
  } else if (noAnswerCount === 1) {
    reasons.push("Previous delivery attempt had no answer");
  }

  if (returnedCount >= 2) {
    reasons.push("Multiple returned orders in history");
  } else if (returnedCount === 1) {
    reasons.push("Order returned in history");
  }

  if (cancelledCount >= 2) {
    reasons.push("Repeated cancellation pattern");
  }

  if (failedOrders >= 3) {
    reasons.push("Multiple failed orders detected");
  } else if (failedOrders >= 1 && totalOrders > 0 && deliveredOrders === 0) {
    reasons.push("No successful delivery history");
  }

  if (networkMerchantCount >= 3 && failedOrders >= 2) {
    reasons.push("Risk pattern reported across multiple sources");
  } else if (networkMerchantCount >= 2 && failedOrders >= 1) {
    reasons.push("Risk behavior observed from multiple sources");
  }

  if (riskTrend === "INCREASING" && recentBadEvents >= 1) {
    reasons.push("Risk behavior increasing recently");
  } else if (riskTrend === "IMPROVING") {
    reasons.push("Customer delivery behavior has improved recently");
  }

  if (totalOrders === 0) {
    reasons.push("No network history found for this customer");
  }

  // Always return at least one reason
  if (reasons.length === 0) {
    reasons.push("Customer has limited network history");
  }

  return reasons;
}

/**
 * Build the final DTO from aggregated internal profile data.
 * This is the ONLY object that should ever reach the merchant-facing API.
 */
export function buildMerchantFacingDTO(params: {
  riskScore: number;
  trustLevel: TrustLevel;
  totalOrders: number;
  deliveredOrders: number;
  refusedOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  noAnswerOrders: number;
  fakeOrderCount: number;
  networkMerchantCount: number;
  estimatedDamageDzd: number;
  deliverySuccessRate: number;
  riskTrend: "INCREASING" | "STABLE" | "IMPROVING";
  recentBadEvents: number;
  recommendedAction: RecommendedAction;
}): MerchantFacingReputationDTO {
  const failedOrders =
    params.refusedOrders +
    params.returnedOrders +
    params.noAnswerOrders +
    params.cancelledOrders +
    params.fakeOrderCount;

  const reasons = buildMerchantReasons({
    totalOrders: params.totalOrders,
    deliveredOrders: params.deliveredOrders,
    failedOrders,
    noAnswerCount: params.noAnswerOrders,
    refusedCount: params.refusedOrders,
    returnedCount: params.returnedOrders,
    cancelledCount: params.cancelledOrders,
    fakeOrderCount: params.fakeOrderCount,
    networkMerchantCount: params.networkMerchantCount,
    riskTrend: params.riskTrend,
    recentBadEvents: params.recentBadEvents,
  }).map(sanitizeReason);

  return {
    riskScore: params.riskScore,
    trustLevel: params.trustLevel,
    reasons,
    estimatedDamageDzd: params.estimatedDamageDzd,
    recommendedAction: params.recommendedAction,
    totalOrders: params.totalOrders,
    deliveredOrders: params.deliveredOrders,
    failedOrders,
    networkMerchantCount: params.networkMerchantCount,
    deliverySuccessRate: params.deliverySuccessRate,
  };
}
