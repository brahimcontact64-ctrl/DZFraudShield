import { normalizeAddress, normalizeName } from "@/lib/delivery-intelligence/normalize";
import { performance } from "node:perf_hooks";
import { getGlobalReputationSnapshot, upsertCustomerIdentityFromDeliveryOrder } from "@/lib/delivery-intelligence/reputation";
import { getRiskContext } from "@/lib/api/context";
import { buildClusterInsights, buildIdentityInsights, type IdentityCandidate } from "@/lib/network-intelligence/identity";
import { buildCustomerNetworkProfile, trustLevelToRecommendedAction, type CustomerNetworkProfile } from "@/lib/network-intelligence/customer-profile";
import { buildNetworkRecommendation } from "@/lib/network-intelligence/scoring";
import { calculateRisk } from "@/lib/risk/engine";
import { hashWithSecret } from "@/lib/security/hash";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import { createClient } from "@/lib/supabase/server";

export type UnifiedRiskDiagnostics = {
  phoneNormalizationMs: number;
  rpcSnapshotMs: number;
  fallbackUsed: boolean;
  identityLookupMs: number;
  customerProfileLookupMs: number;
  merchantHistoryLookupMs: number;
  networkHistoryLookupMs: number;
  riskEventLookupMs: number;
  scoringCalculationMs: number;
  recommendationCalculationMs: number;
  dbReads: number;
  dbWrites: number;
};

type DiagnosticsCollector = {
  addRead: (count?: number) => void;
  addWrite: (count?: number) => void;
};

type RiskContextSnapshot = {
  identity: {
    identity_id: string | null;
    phone_hash: string | null;
    email_hash: string | null;
    address_hash: string | null;
  };
  customer_reputation: {
    total_orders: number;
    delivered_orders: number;
    refused_orders: number;
    returned_orders: number;
    no_answer_orders: number;
    cancelled_orders?: number;
    merchant_count?: number;
    provider_count?: number;
    last_seen_at: string | null;
    risk_level: string | null;
    trust_level: string | null;
    reputation_score?: number;
  };
  merchant_history: {
    total_orders_with_merchant: number;
    delivered_with_merchant: number;
    refused_with_merchant: number;
    returned_with_merchant: number;
    last_order_at: string | null;
  };
  network_history: {
    seen_by_merchants: number;
    total_network_orders: number;
    delivered_network_orders: number;
    refused_network_orders: number;
    returned_network_orders: number;
    return_rate: number;
    refusal_rate: number;
  };
  recent_risk_events: {
    count_7d: number;
    count_30d: number;
    last_event_at: string | null;
    latest_reasons: string[];
  };
  meta: {
    generated_at: string | null;
    source: string | null;
    recent_ip_orders?: number;
    recent_device_orders?: number;
    repeated_orders_by_phone_in_window?: number;
  };
};

function toSnapshotNumber(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function toSnapshotString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toSnapshotStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toSnapshotString(item))
    .filter((item): item is string => Boolean(item));
}

function toRiskContextSnapshot(value: unknown): RiskContextSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const data = value as Record<string, any>;
  const identity = (data.identity ?? {}) as Record<string, unknown>;
  const customerReputation = (data.customer_reputation ?? {}) as Record<string, unknown>;
  const merchantHistory = (data.merchant_history ?? {}) as Record<string, unknown>;
  const networkHistory = (data.network_history ?? {}) as Record<string, unknown>;
  const recentRiskEvents = (data.recent_risk_events ?? {}) as Record<string, unknown>;
  const meta = (data.meta ?? {}) as Record<string, unknown>;

  return {
    identity: {
      identity_id: toSnapshotString(identity.identity_id),
      phone_hash: toSnapshotString(identity.phone_hash),
      email_hash: toSnapshotString(identity.email_hash),
      address_hash: toSnapshotString(identity.address_hash),
    },
    customer_reputation: {
      total_orders: toSnapshotNumber(customerReputation.total_orders),
      delivered_orders: toSnapshotNumber(customerReputation.delivered_orders),
      refused_orders: toSnapshotNumber(customerReputation.refused_orders),
      returned_orders: toSnapshotNumber(customerReputation.returned_orders),
      no_answer_orders: toSnapshotNumber(customerReputation.no_answer_orders),
      cancelled_orders: toSnapshotNumber(customerReputation.cancelled_orders),
      merchant_count: toSnapshotNumber(customerReputation.merchant_count),
      provider_count: toSnapshotNumber(customerReputation.provider_count),
      last_seen_at: toSnapshotString(customerReputation.last_seen_at),
      risk_level: toSnapshotString(customerReputation.risk_level),
      trust_level: toSnapshotString(customerReputation.trust_level),
      reputation_score: toSnapshotNumber(customerReputation.reputation_score, 50),
    },
    merchant_history: {
      total_orders_with_merchant: toSnapshotNumber(merchantHistory.total_orders_with_merchant),
      delivered_with_merchant: toSnapshotNumber(merchantHistory.delivered_with_merchant),
      refused_with_merchant: toSnapshotNumber(merchantHistory.refused_with_merchant),
      returned_with_merchant: toSnapshotNumber(merchantHistory.returned_with_merchant),
      last_order_at: toSnapshotString(merchantHistory.last_order_at),
    },
    network_history: {
      seen_by_merchants: toSnapshotNumber(networkHistory.seen_by_merchants),
      total_network_orders: toSnapshotNumber(networkHistory.total_network_orders),
      delivered_network_orders: toSnapshotNumber(networkHistory.delivered_network_orders),
      refused_network_orders: toSnapshotNumber(networkHistory.refused_network_orders),
      returned_network_orders: toSnapshotNumber(networkHistory.returned_network_orders),
      return_rate: toSnapshotNumber(networkHistory.return_rate),
      refusal_rate: toSnapshotNumber(networkHistory.refusal_rate),
    },
    recent_risk_events: {
      count_7d: toSnapshotNumber(recentRiskEvents.count_7d),
      count_30d: toSnapshotNumber(recentRiskEvents.count_30d),
      last_event_at: toSnapshotString(recentRiskEvents.last_event_at),
      latest_reasons: toSnapshotStringArray(recentRiskEvents.latest_reasons),
    },
    meta: {
      generated_at: toSnapshotString(meta.generated_at),
      source: toSnapshotString(meta.source),
      recent_ip_orders: toSnapshotNumber(meta.recent_ip_orders),
      recent_device_orders: toSnapshotNumber(meta.recent_device_orders),
      repeated_orders_by_phone_in_window: toSnapshotNumber(meta.repeated_orders_by_phone_in_window),
    },
  };
}

export type UnifiedRiskInput = {
  merchantId: string;
  orderId?: string;
  storeId?: string;
  phone?: string | null;
  customerPhone?: string | null;
  customerName?: string | null;
  address?: string | null;
  customerAddress?: string | null;
  city?: string | null;
  commune?: string | null;
  wilaya?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  cartTotal?: number | null;
  totalAmount?: number | null;
  productCount?: number | null;
  paymentMethod?: string | null;
  isCod?: boolean | null;
  productNames?: string[];
  productItems?: Array<{ productName: string; quantity: number; itemTotal: number }>;
};

export type UnifiedRiskOutput = {
  normalizedPhone: string | null;
  phoneHash: string | null;
  ipHash: string;
  deviceHash: string;
  addressHash: string | null;
  identityId: string | null;
  risk: ReturnType<typeof calculateRisk>;
  globalReputation: Awaited<ReturnType<typeof getGlobalReputationSnapshot>>;
  networkIntelligence: ReturnType<typeof buildNetworkRecommendation>;
  identityInsights: ReturnType<typeof buildIdentityInsights>;
  clusterInsights: ReturnType<typeof buildClusterInsights>;
  customerNetworkProfile: CustomerNetworkProfile;
  diagnostics: UnifiedRiskDiagnostics;
};

function toNonEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

const actionSeverity: Record<"accept" | "verify" | "manual_review" | "block", number> = {
  accept: 0,
  verify: 1,
  manual_review: 2,
  block: 3
};

function levelFromAction(action: "accept" | "verify" | "manual_review" | "block"): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (action === "block") return "CRITICAL";
  if (action === "manual_review") return "HIGH";
  if (action === "verify") return "MEDIUM";
  return "LOW";
}

export async function evaluateUnifiedRisk(input: UnifiedRiskInput): Promise<UnifiedRiskOutput> {
  const diagnostics: UnifiedRiskDiagnostics = {
    phoneNormalizationMs: 0,
    rpcSnapshotMs: 0,
    fallbackUsed: true,
    identityLookupMs: 0,
    customerProfileLookupMs: 0,
    merchantHistoryLookupMs: 0,
    networkHistoryLookupMs: 0,
    riskEventLookupMs: 0,
    scoringCalculationMs: 0,
    recommendationCalculationMs: 0,
    dbReads: 0,
    dbWrites: 0,
  };

  const collector: DiagnosticsCollector = {
    addRead: (count = 1) => {
      diagnostics.dbReads += count;
    },
    addWrite: (count = 1) => {
      diagnostics.dbWrites += count;
    },
  };

  const phoneSecret = process.env.PHONE_HASH_SECRET;
  if (!phoneSecret) {
    throw new Error("Missing PHONE_HASH_SECRET");
  }

  const supabase = createClient();

  const phoneNormalizationStarted = performance.now();
  const resolvedPhone = toNonEmpty(input.customerPhone) ?? toNonEmpty(input.phone);
  const resolvedAddress = toNonEmpty(input.customerAddress) ?? toNonEmpty(input.address);
  const normalizedPhone = resolvedPhone ? normalizeAlgerianPhone(resolvedPhone) ?? resolvedPhone : null;
  const phoneHash = normalizedPhone ? hashWithSecret(normalizedPhone, phoneSecret) : null;
  const ipHash = hashWithSecret(toNonEmpty(input.ip) ?? "unknown", phoneSecret);
  const deviceHash = hashWithSecret(toNonEmpty(input.userAgent) ?? "unknown-device", phoneSecret);
  const addressHash = resolvedAddress ? hashWithSecret(resolvedAddress, phoneSecret) : null;
  diagnostics.phoneNormalizationMs = performance.now() - phoneNormalizationStarted;

  const rpcSnapshotStarted = performance.now();
  let rpcSnapshot: RiskContextSnapshot | null = null;
  if (phoneHash) {
    try {
      const rpcResult = await supabase.rpc("get_risk_context_snapshot", {
        p_merchant_id: input.merchantId,
        p_phone_hash: phoneHash,
        p_phone_e164: normalizedPhone,
        p_email_hash: null,
        p_address_hash: addressHash,
        p_ip_hash: ipHash,
        p_device_hash: deviceHash,
      });
      collector.addRead(1);
      if (!rpcResult.error) {
        rpcSnapshot = toRiskContextSnapshot(rpcResult.data);
      }
    } catch {
      rpcSnapshot = null;
    }
  }
  diagnostics.rpcSnapshotMs = performance.now() - rpcSnapshotStarted;
  diagnostics.fallbackUsed = !rpcSnapshot;

  const merchantHistoryStarted = performance.now();
  const networkHistoryStarted = performance.now();
  const identityLookupStarted = performance.now();
  let riskCtx: Awaited<ReturnType<typeof getRiskContext>>;
  let globalReputation: Awaited<ReturnType<typeof getGlobalReputationSnapshot>>;
  let identityId: string | null = null;

  if (rpcSnapshot) {
    riskCtx = {
      merchantDelivered: rpcSnapshot.merchant_history.delivered_with_merchant,
      merchantFailed: rpcSnapshot.merchant_history.refused_with_merchant,
      merchantCancelled: 0,
      merchantReturned: rpcSnapshot.merchant_history.returned_with_merchant,
      globalBadReports: rpcSnapshot.network_history.refused_network_orders,
      globalGoodReports: rpcSnapshot.network_history.delivered_network_orders,
      recentIpOrders: Number(rpcSnapshot.meta.recent_ip_orders ?? 0),
      recentDeviceOrders: Number(rpcSnapshot.meta.recent_device_orders ?? 0),
      repeatedOrdersByPhoneInWindow: Number(rpcSnapshot.meta.repeated_orders_by_phone_in_window ?? 0),
      networkTotalOrders: rpcSnapshot.network_history.total_network_orders,
      networkDeliveredOrders: rpcSnapshot.network_history.delivered_network_orders,
      networkReturnedOrders: rpcSnapshot.network_history.returned_network_orders,
      networkRefusedOrders: rpcSnapshot.network_history.refused_network_orders,
      networkMerchantCount: rpcSnapshot.network_history.seen_by_merchants,
      networkReputationScore: Number(rpcSnapshot.customer_reputation.reputation_score ?? 50),
    };

    globalReputation = {
      totalOrders: rpcSnapshot.customer_reputation.total_orders,
      deliveredOrders: rpcSnapshot.customer_reputation.delivered_orders,
      returnedOrders: rpcSnapshot.customer_reputation.returned_orders,
      refusedOrders: rpcSnapshot.customer_reputation.refused_orders,
      cancelledOrders: Number(rpcSnapshot.customer_reputation.cancelled_orders ?? 0),
      merchantCount: Number(rpcSnapshot.customer_reputation.merchant_count ?? rpcSnapshot.network_history.seen_by_merchants),
      providerCount: Number(rpcSnapshot.customer_reputation.provider_count ?? 0),
      firstSeen: null,
      lastSeen: rpcSnapshot.customer_reputation.last_seen_at,
      reputationScore: Number(rpcSnapshot.customer_reputation.reputation_score ?? 50),
      riskLevel:
        Number(rpcSnapshot.customer_reputation.reputation_score ?? 50) >= 80
          ? "LOW"
          : Number(rpcSnapshot.customer_reputation.reputation_score ?? 50) >= 50
            ? "MEDIUM"
            : "HIGH",
    };

    identityId = rpcSnapshot.identity.identity_id;

    diagnostics.identityLookupMs = diagnostics.rpcSnapshotMs;
    diagnostics.merchantHistoryLookupMs = diagnostics.rpcSnapshotMs / 2;
    diagnostics.networkHistoryLookupMs = diagnostics.rpcSnapshotMs / 2;
  } else {
    let upsertIdentity: Awaited<ReturnType<typeof upsertCustomerIdentityFromDeliveryOrder>>;
    [riskCtx, globalReputation, upsertIdentity] = await Promise.all([
      getRiskContext({
        merchantId: input.merchantId,
        phoneHash: phoneHash ?? undefined,
        ipHash,
        deviceHash,
        diagnostics: collector,
      }),
      getGlobalReputationSnapshot({
        customerPhone: resolvedPhone,
        customerAddress: resolvedAddress,
        wilaya: toNonEmpty(input.wilaya),
        commune: toNonEmpty(input.commune) ?? toNonEmpty(input.city),
        diagnostics: collector,
      }),
      upsertCustomerIdentityFromDeliveryOrder({
        customerPhone: resolvedPhone,
        customerName: toNonEmpty(input.customerName),
        customerAddress: resolvedAddress,
        wilaya: toNonEmpty(input.wilaya),
        commune: toNonEmpty(input.commune) ?? toNonEmpty(input.city),
        diagnostics: collector,
      }),
    ]);
    identityId = upsertIdentity?.identityId ?? null;
    diagnostics.merchantHistoryLookupMs = performance.now() - merchantHistoryStarted;
    diagnostics.networkHistoryLookupMs = performance.now() - networkHistoryStarted;
    diagnostics.identityLookupMs = performance.now() - identityLookupStarted;
  }

  const identitySelect = "id, phone_hash, customer_name, normalized_address, wilaya, commune";
  const normalizedCustomerName = normalizeName(input.customerName ?? null);
  const normalizedCustomerAddress = normalizeAddress(resolvedAddress ?? null);
  const resolvedWilaya = (input.wilaya ?? "").trim().toLowerCase();
  const resolvedCommune = ((input.commune ?? input.city) ?? "").trim().toLowerCase();

  const [phoneMatches, addressMatches, locationMatches] = await Promise.all([
    phoneHash
      ? supabase
          .from("customer_identity")
          .select(identitySelect)
          .eq("phone_hash", phoneHash)
          .limit(25)
      : Promise.resolve({ data: [] as any[] }),
    normalizedCustomerAddress
      ? supabase
          .from("customer_identity")
          .select(identitySelect)
          .eq("normalized_address", normalizedCustomerAddress)
          .limit(25)
      : Promise.resolve({ data: [] as any[] }),
    resolvedWilaya && resolvedCommune
      ? supabase
          .from("customer_identity")
          .select(identitySelect)
          .eq("wilaya", input.wilaya ?? "")
          .eq("commune", input.commune ?? input.city ?? "")
          .limit(25)
      : Promise.resolve({ data: [] as any[] })
  ]);
  collector.addRead(3);
  const preloadedIdentityRows = [...(phoneMatches.data ?? []), ...(addressMatches.data ?? []), ...(locationMatches.data ?? [])]
    .filter((row) => Boolean(row?.id))
    .map((row) => ({
      id: row.id,
      customer_name: row.customer_name ?? null,
      normalized_address: row.normalized_address ?? null,
      wilaya: row.wilaya ?? null,
    }));

  const candidateMap = new Map<string, IdentityCandidate>();
  for (const row of [...(phoneMatches.data ?? []), ...(addressMatches.data ?? []), ...(locationMatches.data ?? [])]) {
    if (!row?.id || row.id === identityId) {
      continue;
    }

    candidateMap.set(row.id, {
      id: row.id,
      phoneHashMatch: row.phone_hash === phoneHash,
      normalizedName: normalizeName(row.customer_name ?? null),
      normalizedAddress: row.normalized_address ?? null,
      wilaya: row.wilaya ?? null,
      commune: row.commune ?? null
    });
  }

  const identityInsights = buildIdentityInsights({
    normalizedName: normalizedCustomerName,
    normalizedAddress: normalizedCustomerAddress,
    wilaya: resolvedWilaya,
    commune: resolvedCommune,
    candidates: Array.from(candidateMap.values())
  });

  const linkedIdentityIds = Array.from(candidateMap.keys());

  let reputationRows: Array<{
    identity_id: string;
    refused_orders: number | null;
    returned_orders: number | null;
    no_answer_count?: number | null;
    fake_order_count?: number | null;
    phone_unreachable_count?: number | null;
    refused_count?: number | null;
    not_picked_up_count?: number | null;
    bad_address_count?: number | null;
    merchant_count?: number | null;
  }> = [];

  if (linkedIdentityIds.length > 0) {
    collector.addRead(1);
    const primaryReputation = await supabase
      .from("customer_reputation")
      .select("identity_id, refused_orders, returned_orders, no_answer_count, fake_order_count, phone_unreachable_count, refused_count, not_picked_up_count, bad_address_count, merchant_count")
      .in("identity_id", linkedIdentityIds);

    if (primaryReputation.error && /fake_order_count|refused_count/i.test(primaryReputation.error.message ?? "")) {
      collector.addRead(1);
      const fallbackReputation = await supabase
        .from("customer_reputation")
        .select("identity_id, refused_orders, returned_orders, no_answer_count, phone_unreachable_count, not_picked_up_count, bad_address_count, merchant_count")
        .in("identity_id", linkedIdentityIds);

      reputationRows = (fallbackReputation.data ?? []) as typeof reputationRows;
    } else {
      reputationRows = (primaryReputation.data ?? []) as typeof reputationRows;
    }
  }

  const reputationByIdentity = new Map<string, number>();
  let multiMerchantIncidents = 0;
  for (const row of reputationRows) {
    const totalIncidents =
      Number(row.refused_orders ?? 0)
      + Number(row.returned_orders ?? 0)
      + Number(row.no_answer_count ?? 0)
      + Number(row.fake_order_count ?? 0)
      + Number(row.phone_unreachable_count ?? 0)
      + Number(row.refused_count ?? 0)
      + Number(row.not_picked_up_count ?? 0)
      + Number(row.bad_address_count ?? 0);

    reputationByIdentity.set(row.identity_id, totalIncidents);

    if (totalIncidents > 0 && Number(row.merchant_count ?? 0) >= 2) {
      multiMerchantIncidents += 1;
    }
  }

  const addressIdentityIds = new Set((addressMatches.data ?? []).map((row) => row.id).filter((id) => id && id !== identityId));
  let addressLinkedRefusedCustomers = 0;

  for (const identityId of addressIdentityIds) {
    if ((reputationByIdentity.get(identityId) ?? 0) > 0) {
      addressLinkedRefusedCustomers += 1;
    }
  }

  const clusterInsights = buildClusterInsights({
    addressLinkedRefusedCustomers,
    phoneIdentityCount: identityInsights.phoneIdentityCount,
    multiMerchantIncidents
  });

  const networkIntelligence = buildNetworkRecommendation({
    totalOrders: globalReputation?.totalOrders ?? 0,
    deliveredOrders: globalReputation?.deliveredOrders ?? 0,
    returnedOrders: globalReputation?.returnedOrders ?? 0,
    refusedOrders: globalReputation?.refusedOrders ?? 0,
    cancelledOrders: globalReputation?.cancelledOrders ?? 0,
    merchantCount: globalReputation?.merchantCount ?? 0,
    suspiciousIdentityChanges: identityInsights.suspiciousIdentityChanges,
    addressLinkedRefusedCustomers: clusterInsights.addressLinkedRefusedCustomers,
    phoneIdentityCount: clusterInsights.phoneIdentityCount
  });

  const scoringStarted = performance.now();
  const risk = calculateRisk(
    {
      merchantId: input.merchantId,
      storeId: input.storeId,
      orderId: input.orderId,
      phoneRaw: resolvedPhone ?? undefined,
      customerPhone: resolvedPhone ?? undefined,
      phoneHash: phoneHash ?? undefined,
      customerName: toNonEmpty(input.customerName) ?? undefined,
      customerAddress: resolvedAddress ?? undefined,
      city: toNonEmpty(input.city) ?? undefined,
      wilaya: toNonEmpty(input.wilaya) ?? undefined,
      commune: toNonEmpty(input.commune) ?? toNonEmpty(input.city) ?? undefined,
      address: resolvedAddress ?? undefined,
      productNames: input.productNames ?? [],
      productItems: input.productItems ?? [],
      ip: toNonEmpty(input.ip) ?? undefined,
      userAgent: toNonEmpty(input.userAgent) ?? undefined,
      cartTotal: Number(input.cartTotal ?? input.totalAmount ?? 1),
      totalAmount: Number(input.totalAmount ?? input.cartTotal ?? 1),
      productCount: Number(input.productCount ?? 1),
      paymentMethod: toNonEmpty(input.paymentMethod) ?? undefined,
      isCod: Boolean(input.isCod ?? false)
    },
    {
      ...riskCtx,
      networkTotalOrders: globalReputation?.totalOrders ?? 0,
      networkDeliveredOrders: globalReputation?.deliveredOrders ?? 0,
      networkReturnedOrders: globalReputation?.returnedOrders ?? 0,
      networkRefusedOrders: globalReputation?.refusedOrders ?? 0,
      networkCancelledOrders: globalReputation?.cancelledOrders ?? 0,
      networkMerchantCount: globalReputation?.merchantCount ?? 0,
      networkReputationScore: networkIntelligence.score,
      networkReasons: networkIntelligence.reasons,
      identityConfidence: identityInsights.confidence,
      clusterRiskScore: clusterInsights.score,
      clusterReasons: clusterInsights.reasons,
      suspiciousIdentityChanges: identityInsights.suspiciousIdentityChanges
    }
  );
  diagnostics.scoringCalculationMs = performance.now() - scoringStarted;

  const allIdentityIds = [
    ...(identityId ? [identityId] : []),
    ...linkedIdentityIds
  ];

  const customerProfileLookupStarted = performance.now();
  const customerNetworkProfile = await buildCustomerNetworkProfile(allIdentityIds, {
    diagnostics: collector,
    preloadedIdentityRows,
  });
  diagnostics.customerProfileLookupMs = performance.now() - customerProfileLookupStarted;
  const recommendationStarted = performance.now();
  const trustMappedAction = trustLevelToRecommendedAction(customerNetworkProfile.networkTrustLevel);
  const finalAction = actionSeverity[trustMappedAction] > actionSeverity[risk.action]
    ? trustMappedAction
    : risk.action;

  const riskWithTrustGuardrail = finalAction === risk.action
    ? risk
    : {
        ...risk,
        action: finalAction,
        level: levelFromAction(finalAction),
        reasons: [
          `Network trust level ${customerNetworkProfile.networkTrustLevel} requires ${finalAction.replace("_", " ")}`,
          ...risk.reasons
        ].slice(0, 10)
      };
  diagnostics.recommendationCalculationMs = performance.now() - recommendationStarted;

  // Risk events are not consulted during evaluation; keep explicit marker for harness reports.
  diagnostics.riskEventLookupMs = 0;

  return {
    normalizedPhone,
    phoneHash,
    ipHash,
    deviceHash,
    addressHash,
    identityId: identityId ?? null,
    risk: riskWithTrustGuardrail,
    globalReputation,
    networkIntelligence,
    identityInsights,
    clusterInsights,
    customerNetworkProfile,
    diagnostics,
  };
}
