// Financial impact estimation helpers.
// All estimates are derived from real merchant metrics — never fabricated.
//
// Methodology:
//   Savings    = cost avoided by taking recommended action
//   Revenue    = additional revenue unlocked by taking recommended action
//
// Both are conservative estimates to avoid over-promising.

// ── Constants ─────────────────────────────────────────────────────────────────

// Fraction of returns that can realistically be avoided per category of recommendation.
const RETURN_AVOIDANCE_RATE_PROVIDER_SWITCH  = 0.15; // 15% fewer returns with better provider
const RETURN_AVOIDANCE_RATE_STOPDESK         = 0.12; // 12% fewer returns with stop desk
const RETURN_AVOIDANCE_RATE_CONFIRMATION     = 0.10; // 10% fewer fake orders with confirmation call
const RETURN_AVOIDANCE_RATE_AD_PAUSE         = 0.30; // 30% of current returns avoidable by pausing
const RETURN_AVOIDANCE_RATE_AD_REDUCE        = 0.15; // 15% of current returns avoidable by reducing
const FRAUD_AVOIDANCE_RATE                   = 0.08; // 8% of blocked orders could be caught earlier

// Revenue uplift rates.
const REVENUE_UPLIFT_AD_INCREASE             = 0.20; // 20% more delivered revenue with increased ads
const REVENUE_UPLIFT_REGION_FOCUS            = 0.15; // 15% uplift when targeting good regions
const REVENUE_UPLIFT_PRODUCT_PROMOTE         = 0.20; // 20% more orders on promoted products
const REVENUE_UPLIFT_GROWTH_MERCHANT         = 0.10; // 10% incremental from capitalising growth

// ── Helpers ───────────────────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n / 100) * 100; // round to nearest 100 DZD
}

// ── Advertising ───────────────────────────────────────────────────────────────

export function adPauseSavings(
  returnedOrders: number,
  avgOrderValueDzd: number,
): number {
  return round(returnedOrders * avgOrderValueDzd * RETURN_AVOIDANCE_RATE_AD_PAUSE);
}

export function adReduceSavings(
  returnedOrders: number,
  avgOrderValueDzd: number,
): number {
  return round(returnedOrders * avgOrderValueDzd * RETURN_AVOIDANCE_RATE_AD_REDUCE);
}

export function adIncreaseRevenue(
  deliveredOrders: number,
  avgOrderValueDzd: number,
): number {
  return round(deliveredOrders * avgOrderValueDzd * REVENUE_UPLIFT_AD_INCREASE);
}

export function regionFocusRevenue(
  highSuccessOrders: number,
  avgOrderValueDzd: number,
): number {
  return round(highSuccessOrders * avgOrderValueDzd * REVENUE_UPLIFT_REGION_FOCUS);
}

// ── Delivery ──────────────────────────────────────────────────────────────────

export function providerSwitchSavings(
  totalShipments: number,
  currentFailureRate: number,
  betterProviderSuccessRate: number,
  avgCodAmountDzd: number,
): number {
  const improvementRate = Math.max(0, betterProviderSuccessRate - (1 - currentFailureRate));
  const savedShipments = totalShipments * improvementRate * RETURN_AVOIDANCE_RATE_PROVIDER_SWITCH;
  return round(savedShipments * avgCodAmountDzd);
}

export function stopdeskSavings(
  returnedShipments: number,
  avgCodAmountDzd: number,
): number {
  return round(returnedShipments * avgCodAmountDzd * RETURN_AVOIDANCE_RATE_STOPDESK);
}

export function confirmationCallSavings(
  totalOrders: number,
  blockRate: number,
  avgBasketDzd: number,
): number {
  // Potential fake orders that slipped through and could be caught by calls
  const estimatedFakeOrders = totalOrders * blockRate * FRAUD_AVOIDANCE_RATE;
  return round(estimatedFakeOrders * avgBasketDzd);
}

// ── Products ──────────────────────────────────────────────────────────────────

export function highReturnProductSavings(
  returnedOrders: number,
  avgUnitPriceDzd: number,
): number {
  return round(returnedOrders * avgUnitPriceDzd * 0.5); // recover 50% of return losses
}

export function discontinueProductSavings(
  returnedOrders: number,
  avgUnitPriceDzd: number,
): number {
  return round(returnedOrders * avgUnitPriceDzd * 0.7); // avoid 70% of ongoing losses
}

export function promoteProductRevenue(
  deliveredOrders: number,
  avgUnitPriceDzd: number,
): number {
  return round(deliveredOrders * avgUnitPriceDzd * REVENUE_UPLIFT_PRODUCT_PROMOTE);
}

// ── Pricing ───────────────────────────────────────────────────────────────────

export function codPriceIncreaseSavingsRevenue(
  deliveredOrders: number,
  currentAvgCodDzd: number,
  increaseRate: number, // e.g. 0.05 for +5%
): number {
  return round(deliveredOrders * currentAvgCodDzd * increaseRate);
}

// ── Merchant health ───────────────────────────────────────────────────────────

export function fraudSpikeSavings(
  blockedOrders: number,
  avgBasketDzd: number,
): number {
  // If fraud controls tighten, some blocked orders are legitimate orders recovered
  return round(blockedOrders * avgBasketDzd * 0.05); // conservative: 5% are recoverable orders
}

export function growthMerchantRevenue(
  currentRevenueDzd: number,
  growthRate: number,
): number {
  return round(currentRevenueDzd * Math.min(growthRate, 1.0) * REVENUE_UPLIFT_GROWTH_MERCHANT);
}

// ── Regional ──────────────────────────────────────────────────────────────────

export function regionalOpportunityRevenue(
  totalShipmentsInWilaya: number,
  deliverySuccessRate: number,
  avgCodAmountDzd: number,
): number {
  const deliveredRevenue = totalShipmentsInWilaya * deliverySuccessRate * avgCodAmountDzd;
  return round(deliveredRevenue * REVENUE_UPLIFT_REGION_FOCUS);
}

export function regionalRiskSavings(
  returnedShipmentsInWilaya: number,
  avgCodAmountDzd: number,
): number {
  return round(returnedShipmentsInWilaya * avgCodAmountDzd * RETURN_AVOIDANCE_RATE_AD_PAUSE);
}
