import { createClient } from "@/lib/supabase/server";

export type NetworkTrustLevel = "TRUSTED" | "NORMAL" | "WATCHLIST" | "HIGH_RISK" | "BLACKLIST";
export type RiskTrend = "INCREASING" | "STABLE" | "IMPROVING";

const DEFAULT_AVERAGE_ORDER_VALUE = 3500;
const DEFAULT_SHIPPING_COST = 500;
const SHIPPING_COST = Number(process.env.DZFS_SHIPPING_COST_DZD ?? DEFAULT_SHIPPING_COST);

export type CustomerNetworkProfile = {
  totalOrders: number;
  deliveredOrders: number;
  refusedOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  noAnswerOrders: number;
  fakeOrderCount: number;
  phoneUnreachableOrders: number;
  notPickedUpOrders: number;
  badAddressOrders: number;
  merchantCount: number;
  providerCount: number;
  deliverySuccessRate: number;
  averageOrderValue: number;
  estimatedDamageDzd: number;
  merchantImpactScore: number;
  networkTrustLevel: NetworkTrustLevel;
  merchantConfidenceScore: number;
  riskTrend: RiskTrend;
  firstSeen: string | null;
  lastSeen: string | null;
  linkedNames: string[];
  linkedAddresses: string[];
  linkedWilayas: string[];
  networkInsights: string[];
  recentBadEvents: number;
  priorBadEvents: number;
};

type CustomerProfileCacheEntry = {
  expiresAt: number;
  value: CustomerNetworkProfile;
};

const CUSTOMER_PROFILE_CACHE_TTL_MS = 45_000;
const customerProfileCache = new Map<string, CustomerProfileCacheEntry>();

function customerProfileCacheKey(identityIds: string[]): string {
  const normalized = Array.from(new Set(identityIds)).sort();
  return `cust_profile:${normalized.join(",")}`;
}

function readCustomerProfileCache(key: string): CustomerNetworkProfile | undefined {
  const cached = customerProfileCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    customerProfileCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function computeNetworkTrustLevel(params: {
  deliveredOrders: number;
  refusedOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  noAnswerOrders: number;
  fakeOrderCount: number;
  deliverySuccessRate: number;
}): NetworkTrustLevel {
  const {
    deliveredOrders,
    refusedOrders,
    returnedOrders,
    cancelledOrders,
    noAnswerOrders,
    fakeOrderCount,
    deliverySuccessRate
  } = params;

  const refusalSignals = refusedOrders + returnedOrders;

  // Repeated refusals/returns are considered a critical fraud pattern.
  if (fakeOrderCount >= 2 || refusedOrders >= 3 || refusalSignals >= 5) {
    return "BLACKLIST";
  }

  // Multiple cancellations are high-risk even without a long history.
  if (cancelledOrders >= 2 || fakeOrderCount >= 1 || refusalSignals >= 3) {
    return "HIGH_RISK";
  }

  // Strong confirmed delivery history is trusted.
  if (deliveredOrders >= 5 && deliverySuccessRate > 90) {
    return "TRUSTED";
  }

  // A single cancellation with zero successful deliveries is already watchlist.
  if ((cancelledOrders >= 1 && deliveredOrders === 0) || refusalSignals >= 1 || deliverySuccessRate < 60) {
    return "WATCHLIST";
  }

  return "NORMAL";
}

function computeRiskTrend(recentBadEvents: number, recentTotal: number, priorBadEvents: number, priorTotal: number): RiskTrend {
  if (recentTotal === 0 && priorTotal === 0) return "STABLE";

  const recentRate = recentTotal > 0 ? recentBadEvents / recentTotal : 0;
  const priorRate = priorTotal > 0 ? priorBadEvents / priorTotal : 0;

  const delta = recentRate - priorRate;

  if (delta > 0.15) return "INCREASING";
  if (delta < -0.15) return "IMPROVING";
  return "STABLE";
}

function computeMerchantConfidenceScore(params: {
  merchantCount: number;
  deliverySuccessRate: number;
  totalOrders: number;
}): number {
  let score = 0;

  score += Math.min(40, params.merchantCount * 8);

  if (params.deliverySuccessRate >= 90) {
    score += 40;
  } else if (params.deliverySuccessRate >= 70) {
    score += 25;
  } else if (params.deliverySuccessRate >= 50) {
    score += 12;
  }

  score += Math.min(20, params.totalOrders * 2);

  return Math.min(100, Math.round(score));
}

function computeMerchantImpactScore(params: {
  refusedOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  noAnswerOrders: number;
  fakeOrderCount: number;
  averageOrderValue: number;
}): number {
  // All undelivered failure signals cost the network an order value loss
  const badOrders = params.refusedOrders + params.returnedOrders + params.noAnswerOrders + params.fakeOrderCount;
  const damage = badOrders * params.averageOrderValue + params.cancelledOrders * SHIPPING_COST;
  return Math.round(damage);
}

function generateNetworkInsights(profile: Omit<CustomerNetworkProfile, "networkInsights">): string[] {
  const insights: string[] = [];
  const {
    merchantCount,
    totalOrders,
    deliveredOrders,
    refusedOrders,
    returnedOrders,
    fakeOrderCount,
    estimatedDamageDzd,
    deliverySuccessRate,
    networkTrustLevel,
    riskTrend,
    recentBadEvents
  } = profile;

  if (merchantCount >= 2) {
    insights.push(`This customer has a history across ${merchantCount} network sources.`);
  }

  if (estimatedDamageDzd >= 1000) {
    insights.push(`This customer caused an estimated ${estimatedDamageDzd.toLocaleString("fr-DZ")} DZD in network losses.`);
  }

  if (recentBadEvents >= 1) {
    insights.push(`This customer had ${recentBadEvents} failed order${recentBadEvents > 1 ? "s" : ""} in the last 30 days.`);
  }

  if (totalOrders > 0 && deliveredOrders === 0) {
    insights.push("This customer has never successfully received an order.");
  }

  if (fakeOrderCount >= 1) {
    insights.push(`This customer is flagged for ${fakeOrderCount} fake order${fakeOrderCount > 1 ? "s" : ""}.`);
  }

  if (refusedOrders >= 2) {
    insights.push(`This customer refused ${refusedOrders} order${refusedOrders > 1 ? "s" : ""} across the network.`);
  }

  if (returnedOrders >= 2) {
    insights.push(`This customer returned ${returnedOrders} order${returnedOrders > 1 ? "s" : ""} across the network.`);
  }

  if (networkTrustLevel === "TRUSTED") {
    insights.push("This customer is trusted by the network with a strong delivery history.");
  }

  if (riskTrend === "INCREASING") {
    insights.push("This customer's risk behavior is increasing recently.");
  } else if (riskTrend === "IMPROVING") {
    insights.push("This customer's delivery behavior has improved recently.");
  }

  if (deliverySuccessRate >= 90 && totalOrders >= 3) {
    insights.push(`Strong delivery success rate: ${deliverySuccessRate}%.`);
  }

  return insights;
}

export async function buildCustomerNetworkProfile(
  identityIds: string[],
  options?: {
    diagnostics?: { addRead: (count?: number) => void; addWrite: (count?: number) => void };
    preloadedIdentityRows?: Array<{ id: string; customer_name: string | null; normalized_address: string | null; wilaya: string | null }>;
  }
): Promise<CustomerNetworkProfile> {
  const empty: CustomerNetworkProfile = {
    totalOrders: 0,
    deliveredOrders: 0,
    refusedOrders: 0,
    returnedOrders: 0,
    cancelledOrders: 0,
    noAnswerOrders: 0,
    fakeOrderCount: 0,
    phoneUnreachableOrders: 0,
    notPickedUpOrders: 0,
    badAddressOrders: 0,
    merchantCount: 0,
    providerCount: 0,
    deliverySuccessRate: 0,
    averageOrderValue: DEFAULT_AVERAGE_ORDER_VALUE,
    estimatedDamageDzd: 0,
    merchantImpactScore: 0,
    networkTrustLevel: "NORMAL",
    merchantConfidenceScore: 0,
    riskTrend: "STABLE",
    firstSeen: null,
    lastSeen: null,
    linkedNames: [],
    linkedAddresses: [],
    linkedWilayas: [],
    networkInsights: [],
    recentBadEvents: 0,
    priorBadEvents: 0
  };

  if (identityIds.length === 0) {
    return empty;
  }

  const cacheKey = customerProfileCacheKey(identityIds);
  const cached = readCustomerProfileCache(cacheKey);
  if (cached) {
    return cached;
  }

  const supabase = createClient();
  const boundedIdentityIds = Array.from(new Set(identityIds)).slice(0, 80);
  const identityReadLimit = Math.max(20, Math.min(200, boundedIdentityIds.length * 2));

  const [deliveryStats, identityRows] = await Promise.all([
    supabase
      .from("customer_delivery_stats")
      .select("identity_id, total_delivery_orders, delivered_count, refused_count, returned_count, cancelled_count, no_answer_count, fake_order_count, phone_unreachable_count, not_picked_up_count, bad_address_count, merchant_count, provider_count, avg_order_amount, first_seen, last_seen, recent_bad_events, recent_total_orders, prior_bad_events, prior_total_orders")
      .in("identity_id", boundedIdentityIds)
      .limit(identityReadLimit),
    options?.preloadedIdentityRows
      ? Promise.resolve({ data: options.preloadedIdentityRows, error: null })
      : supabase
          .from("customer_identity")
          .select("id, customer_name, normalized_address, wilaya")
          .in("id", boundedIdentityIds)
          .limit(identityReadLimit)
  ]);
  options?.diagnostics?.addRead(options?.preloadedIdentityRows ? 1 : 2);

  if (deliveryStats.error || !deliveryStats.data?.length) {
    return empty;
  }

  let totalOrders = 0;
  let deliveredOrders = 0;
  let refusedOrders = 0;
  let returnedOrders = 0;
  let cancelledOrders = 0;
  let noAnswerOrders = 0;
  let fakeOrderCount = 0;
  let phoneUnreachableOrders = 0;
  let notPickedUpOrders = 0;
  let badAddressOrders = 0;
  let merchantCount = 0;
  let providerCount = 0;
  let totalValue = 0;
  let valueOrderCount = 0;
  let recentBadEvents = 0;
  let recentTotalOrders = 0;
  let priorBadEvents = 0;
  let priorTotalOrders = 0;
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  for (const row of deliveryStats.data) {
    totalOrders += Number(row.total_delivery_orders ?? 0);
    deliveredOrders += Number(row.delivered_count ?? 0);
    refusedOrders += Number(row.refused_count ?? 0);
    returnedOrders += Number(row.returned_count ?? 0);
    cancelledOrders += Number(row.cancelled_count ?? 0);
    noAnswerOrders += Number(row.no_answer_count ?? 0);
    fakeOrderCount += Number(row.fake_order_count ?? 0);
    phoneUnreachableOrders += Number(row.phone_unreachable_count ?? 0);
    notPickedUpOrders += Number(row.not_picked_up_count ?? 0);
    badAddressOrders += Number(row.bad_address_count ?? 0);
    merchantCount = Math.max(merchantCount, Number(row.merchant_count ?? 0));
    providerCount = Math.max(providerCount, Number(row.provider_count ?? 0));

    const avgValue = Number(row.avg_order_amount ?? 0);
    if (avgValue > 0) {
      totalValue += avgValue;
      valueOrderCount += 1;
    }

    recentBadEvents += Number(row.recent_bad_events ?? 0);
    recentTotalOrders += Number(row.recent_total_orders ?? 0);
    priorBadEvents += Number(row.prior_bad_events ?? 0);
    priorTotalOrders += Number(row.prior_total_orders ?? 0);

    const rowFirst = row.first_seen ? String(row.first_seen) : null;
    const rowLast = row.last_seen ? String(row.last_seen) : null;

    if (rowFirst && (!firstSeen || rowFirst < firstSeen)) {
      firstSeen = rowFirst;
    }

    if (rowLast && (!lastSeen || rowLast > lastSeen)) {
      lastSeen = rowLast;
    }
  }

  const averageOrderValue = valueOrderCount > 0 ? Math.round(totalValue / valueOrderCount) : DEFAULT_AVERAGE_ORDER_VALUE;
  const deliverySuccessRate = totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0;
  const networkTrustLevel = computeNetworkTrustLevel({
    deliveredOrders,
    refusedOrders,
    returnedOrders,
    cancelledOrders,
    noAnswerOrders,
    fakeOrderCount,
    deliverySuccessRate
  });
  const riskTrend = computeRiskTrend(recentBadEvents, recentTotalOrders, priorBadEvents, priorTotalOrders);
  const merchantImpactScore = computeMerchantImpactScore({
    refusedOrders,
    returnedOrders,
    cancelledOrders,
    noAnswerOrders,
    fakeOrderCount,
    averageOrderValue
  });
  const estimatedDamageDzd = merchantImpactScore;
  const merchantConfidenceScore = computeMerchantConfidenceScore({
    merchantCount,
    deliverySuccessRate,
    totalOrders
  });

  const linkedNames: string[] = [];
  const linkedAddresses: string[] = [];
  const linkedWilayas: string[] = [];

  for (const row of identityRows.data ?? []) {
    if (row.customer_name) {
      const name = String(row.customer_name).trim();
      if (name && !linkedNames.includes(name)) {
        linkedNames.push(name);
      }
    }

    if (row.normalized_address) {
      const addr = String(row.normalized_address).trim();
      if (addr && !linkedAddresses.includes(addr)) {
        linkedAddresses.push(addr);
      }
    }

    if (row.wilaya) {
      const w = String(row.wilaya).trim();
      if (w && !linkedWilayas.includes(w)) {
        linkedWilayas.push(w);
      }
    }
  }

  const profileWithoutInsights: Omit<CustomerNetworkProfile, "networkInsights"> = {
    totalOrders,
    deliveredOrders,
    refusedOrders,
    returnedOrders,
    cancelledOrders,
    noAnswerOrders,
    fakeOrderCount,
    phoneUnreachableOrders,
    notPickedUpOrders,
    badAddressOrders,
    merchantCount,
    providerCount,
    deliverySuccessRate,
    averageOrderValue,
    estimatedDamageDzd,
    merchantImpactScore,
    networkTrustLevel,
    merchantConfidenceScore,
    riskTrend,
    firstSeen,
    lastSeen,
    linkedNames,
    linkedAddresses,
    linkedWilayas,
    recentBadEvents,
    priorBadEvents
  };

  const result = {
    ...profileWithoutInsights,
    networkInsights: generateNetworkInsights(profileWithoutInsights)
  };

  customerProfileCache.set(cacheKey, {
    expiresAt: Date.now() + CUSTOMER_PROFILE_CACHE_TTL_MS,
    value: result,
  });

  return result;
}

export async function getTopRiskCustomers(merchantId: string, limit = 10): Promise<Array<{
  identityId: string;
  customerName: string | null;
  phoneHash: string | null;
  wilaya: string | null;
  riskLevel: NetworkTrustLevel;
  refusedOrders: number;
  merchantCount: number;
  estimatedDamageDzd: number;
  totalOrders: number;
  deliverySuccessRate: number;
  lastSeen: string | null;
}>> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from("top_risk_customers")
    .select("identity_id, customer_name, phone_hash, wilaya, refused_like_count, merchant_count, estimated_damage_dzd, total_orders, last_seen")
    .gt("refused_like_count", 0)
    .order("estimated_damage_dzd", { ascending: false })
    .limit(limit);

  if (error || !data) {
    return [];
  }

  return data.map((row) => {
    const total = Number(row.total_orders ?? 0);
    const refused = Number(row.refused_like_count ?? 0);
    const successRate = total > 0 ? Math.round(((total - refused) / total) * 100) : 0;

    let riskLevel: NetworkTrustLevel = "NORMAL";
    if (refused >= 4) riskLevel = "BLACKLIST";
    else if (refused >= 2) riskLevel = "HIGH_RISK";
    else if (refused >= 1) riskLevel = "WATCHLIST";

    return {
      identityId: String(row.identity_id ?? ""),
      customerName: row.customer_name ? String(row.customer_name) : null,
      phoneHash: row.phone_hash ? String(row.phone_hash) : null,
      wilaya: row.wilaya ? String(row.wilaya) : null,
      riskLevel,
      refusedOrders: refused,
      merchantCount: Number(row.merchant_count ?? 0),
      estimatedDamageDzd: Number(row.estimated_damage_dzd ?? 0),
      totalOrders: total,
      deliverySuccessRate: successRate,
      lastSeen: row.last_seen ? String(row.last_seen) : null
    };
  });
}

export function trustLevelLabel(level: NetworkTrustLevel): string {
  switch (level) {
    case "TRUSTED": return "Trusted";
    case "WATCHLIST": return "Watchlist";
    case "HIGH_RISK": return "High Risk";
    case "BLACKLIST": return "Blacklist";
    default: return "Normal";
  }
}

export function trustLevelColor(level: NetworkTrustLevel): string {
  switch (level) {
    case "TRUSTED": return "bg-emerald-100 text-emerald-800";
    case "NORMAL": return "bg-slate-100 text-slate-700";
    case "WATCHLIST": return "bg-amber-100 text-amber-800";
    case "HIGH_RISK": return "bg-orange-100 text-orange-900";
    case "BLACKLIST": return "bg-rose-200 text-rose-900";
  }
}

export function trustLevelToRecommendedAction(level: NetworkTrustLevel): "accept" | "verify" | "manual_review" | "block" {
  switch (level) {
    case "TRUSTED":
      return "accept";
    case "NORMAL":
      return "accept";
    case "WATCHLIST":
      return "verify";
    case "HIGH_RISK":
      return "manual_review";
    case "BLACKLIST":
      return "block";
  }
}
