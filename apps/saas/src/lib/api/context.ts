import { createClient } from "@/lib/supabase/server";

type RiskContextRecord = {
  merchantDelivered: number;
  merchantFailed: number;
  merchantCancelled: number;
  merchantReturned: number;
  globalBadReports: number;
  globalGoodReports: number;
  recentIpOrders: number;
  recentDeviceOrders: number;
  repeatedOrdersByPhoneInWindow: number;
  networkTotalOrders: number;
  networkDeliveredOrders: number;
  networkReturnedOrders: number;
  networkRefusedOrders: number;
  networkMerchantCount: number;
  networkReputationScore: number;
};

type RiskContextCacheEntry = {
  expiresAt: number;
  value: RiskContextRecord;
};

const RISK_CONTEXT_CACHE_TTL_MS = 45_000;
const riskContextCache = new Map<string, RiskContextCacheEntry>();

function buildRiskContextCacheKey(params: {
  merchantId: string;
  phoneHash?: string;
  ipHash?: string;
  deviceHash?: string;
}) {
  return [
    "risk_ctx",
    params.merchantId,
    params.phoneHash ?? "",
    params.ipHash ?? "",
    params.deviceHash ?? "",
  ].join(":");
}

function readRiskContextCache(cacheKey: string): RiskContextRecord | undefined {
  const cached = riskContextCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    riskContextCache.delete(cacheKey);
    return undefined;
  }
  return cached.value;
}

export async function getRiskContext(params: {
  merchantId: string;
  phoneHash?: string;
  ipHash?: string;
  deviceHash?: string;
  diagnostics?: { addRead: (count?: number) => void };
}) {
  const cacheKey = buildRiskContextCacheKey(params);
  const cached = readRiskContextCache(cacheKey);
  if (cached) {
    return cached;
  }

  const supabase = createClient();

  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000).toISOString();

  const [merchantRep, globalRep, ipRecent, deviceRecent, repeatedPhone] = await Promise.all([
    supabase
      .from("merchant_customer_reputation")
      .select("delivered_count, failed_count, cancelled_count, returned_count")
      .eq("merchant_id", params.merchantId)
      .eq("phone_hash", params.phoneHash ?? "")
      .maybeSingle(),
    supabase
      .from("global_phone_reputation")
      .select("good_reports, bad_reports")
      .eq("phone_hash", params.phoneHash ?? "")
      .maybeSingle(),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", params.merchantId)
      .eq("ip_hash", params.ipHash ?? "")
      .gte("created_at", tenMinutesAgo),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", params.merchantId)
      .eq("device_hash", params.deviceHash ?? "")
      .gte("created_at", tenMinutesAgo),
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", params.merchantId)
      .eq("phone_hash", params.phoneHash ?? "")
      .gte("created_at", tenMinutesAgo)
  ]);
  params.diagnostics?.addRead(5);

  const result = {
    merchantDelivered: merchantRep.data?.delivered_count ?? 0,
    merchantFailed: merchantRep.data?.failed_count ?? 0,
    merchantCancelled: merchantRep.data?.cancelled_count ?? 0,
    merchantReturned: merchantRep.data?.returned_count ?? 0,
    globalBadReports: globalRep.data?.bad_reports ?? 0,
    globalGoodReports: globalRep.data?.good_reports ?? 0,
    recentIpOrders: ipRecent.count ?? 0,
    recentDeviceOrders: deviceRecent.count ?? 0,
    repeatedOrdersByPhoneInWindow: repeatedPhone.count ?? 0,
    networkTotalOrders: 0,
    networkDeliveredOrders: 0,
    networkReturnedOrders: 0,
    networkRefusedOrders: 0,
    networkMerchantCount: 0,
    networkReputationScore: 50
  };

  riskContextCache.set(cacheKey, {
    expiresAt: Date.now() + RISK_CONTEXT_CACHE_TTL_MS,
    value: result,
  });

  return result;
}
