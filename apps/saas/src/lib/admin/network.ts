import { createClient } from "@/lib/supabase/server";
import { extractOutcomeContext } from "@/lib/delivery-intelligence/outcome";

const NETWORK_OVERVIEW_SAMPLE_LIMIT = 3000;

export async function getNetworkOverview() {
  const supabase = createClient();

  const [stores, accounts, syncedOrders, customers, fingerprints, highRisk, failedSyncs, providerHealthRows, topRiskCustomersRows, topRiskPhonesRows, topRiskAddressesRows, wilayaRows, dataQualityRows] = await Promise.all([
    supabase.from("stores").select("id", { count: "exact", head: true }),
    supabase.from("merchant_delivery_accounts").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("delivery_orders").select("id", { count: "exact", head: true }),
    supabase.from("customer_identity").select("id", { count: "exact", head: true }),
    supabase.from("identity_fingerprint").select("id", { count: "exact", head: true }),
    supabase.from("customer_reputation").select("identity_id", { count: "exact", head: true }).gte("reputation_score", 76),
    supabase.from("delivery_sync_logs").select("id", { count: "exact", head: true }).eq("status", "failed"),
    supabase.from("delivery_sync_logs").select("provider, status"),
    supabase
      .from("customer_reputation")
      .select("identity_id, reputation_score, risk_level, total_orders, returned_orders, refused_orders, merchant_count")
      .order("reputation_score", { ascending: false })
      .limit(20),
    supabase
      .from("delivery_orders")
      .select("customer_phone_hash, status")
      .not("customer_phone_hash", "is", null)
      .order("synced_at", { ascending: false })
      .limit(NETWORK_OVERVIEW_SAMPLE_LIMIT),
    supabase
      .from("delivery_orders")
      .select("normalized_address, status")
      .not("normalized_address", "is", null)
      .order("synced_at", { ascending: false })
      .limit(NETWORK_OVERVIEW_SAMPLE_LIMIT),
    supabase
      .from("wilaya_performance")
      .select("wilaya, orders, return_rate, delivery_rate")
      .order("return_rate", { ascending: false })
      .limit(15),
    supabase
      .from("delivery_orders")
      .select("id, customer_phone_hash, normalized_address, order_amount")
      .order("synced_at", { ascending: false })
      .limit(NETWORK_OVERVIEW_SAMPLE_LIMIT)
  ]);

  if (providerHealthRows.error) throw providerHealthRows.error;
  if (topRiskCustomersRows.error) throw topRiskCustomersRows.error;
  if (topRiskPhonesRows.error) throw topRiskPhonesRows.error;
  if (topRiskAddressesRows.error) throw topRiskAddressesRows.error;
  if (wilayaRows.error) throw wilayaRows.error;
  if (dataQualityRows.error) throw dataQualityRows.error;

  const providerHealthMap = new Map<string, { total: number; failed: number; success: number }>();
  for (const row of providerHealthRows.data ?? []) {
    const current = providerHealthMap.get(row.provider) ?? { total: 0, failed: 0, success: 0 };
    current.total += 1;
    if (row.status === "failed") {
      current.failed += 1;
    } else {
      current.success += 1;
    }
    providerHealthMap.set(row.provider, current);
  }

  const providerHealth = Array.from(providerHealthMap.entries()).map(([provider, value]) => ({
    provider,
    totalSyncs: value.total,
    failedSyncs: value.failed,
    successRate: value.total ? Math.round((value.success / value.total) * 100) : 0
  }));

  const phoneStats = new Map<string, { total: number; problematic: number }>();
  for (const row of topRiskPhonesRows.data ?? []) {
    const key = row.customer_phone_hash ?? "";
    if (!key) continue;
    const current = phoneStats.get(key) ?? { total: 0, problematic: 0 };
    current.total += 1;
    if (["RETURNED", "REFUSED", "CANCELLED"].includes(row.status)) {
      current.problematic += 1;
    }
    phoneStats.set(key, current);
  }

  const topRiskPhones = Array.from(phoneStats.entries())
    .map(([phoneHash, value]) => ({
      phoneHash,
      totalOrders: value.total,
      problematicOrders: value.problematic,
      riskRatio: value.total ? Number((value.problematic / value.total).toFixed(3)) : 0
    }))
    .sort((a, b) => b.riskRatio - a.riskRatio)
    .slice(0, 15);

  const addressStats = new Map<string, { total: number; problematic: number }>();
  for (const row of topRiskAddressesRows.data ?? []) {
    const key = row.normalized_address ?? "";
    if (!key) continue;
    const current = addressStats.get(key) ?? { total: 0, problematic: 0 };
    current.total += 1;
    if (["RETURNED", "REFUSED", "CANCELLED"].includes(row.status)) {
      current.problematic += 1;
    }
    addressStats.set(key, current);
  }

  const topRiskAddresses = Array.from(addressStats.entries())
    .map(([address, value]) => ({
      address,
      totalOrders: value.total,
      problematicOrders: value.problematic,
      riskRatio: value.total ? Number((value.problematic / value.total).toFixed(3)) : 0
    }))
    .sort((a, b) => b.riskRatio - a.riskRatio)
    .slice(0, 15);

  const totalRows = dataQualityRows.data?.length ?? 0;
  const missingPhone = (dataQualityRows.data ?? []).filter((row) => !row.customer_phone_hash).length;
  const missingAddress = (dataQualityRows.data ?? []).filter((row) => !row.normalized_address).length;
  const missingAmount = (dataQualityRows.data ?? []).filter((row) => row.order_amount === null).length;
  const dataQuality = {
    totalRows,
    missingPhone,
    missingAddress,
    missingAmount,
    completenessRate: totalRows
      ? Number(((((totalRows * 3) - missingPhone - missingAddress - missingAmount) / (totalRows * 3)) * 100).toFixed(2))
      : 0
  };

  return {
    connectedStores: stores.count ?? 0,
    connectedDeliveryAccounts: accounts.count ?? 0,
    totalOrders: syncedOrders.count ?? 0,
    trackedCustomers: customers.count ?? 0,
    identityFingerprints: fingerprints.count ?? 0,
    highRiskCustomers: highRisk.count ?? 0,
    failedSyncs: failedSyncs.count ?? 0,
    providerHealth,
    topRiskCustomers: topRiskCustomersRows.data ?? [],
    topRiskPhones,
    topRiskAddresses,
    topWilayaRankings: wilayaRows.data ?? [],
    dataQuality
  };
}

export async function searchReputationExplorer(params: {
  phoneHash?: string;
  name?: string;
  identityId?: string;
}) {
  const supabase = createClient();

  let identityQuery = supabase
    .from("customer_identity")
    .select("id, phone_hash, customer_name, normalized_address, wilaya, commune, updated_at")
    .limit(50);

  if (params.identityId) {
    identityQuery = identityQuery.eq("id", params.identityId);
  }

  if (params.phoneHash) {
    identityQuery = identityQuery.eq("phone_hash", params.phoneHash);
  }

  if (params.name) {
    identityQuery = identityQuery.ilike("customer_name", `%${params.name}%`);
  }

  const { data: identities, error } = await identityQuery;
  if (error) {
    throw error;
  }

  if (!identities?.length) {
    return [];
  }

  const identityIds = identities.map((identity) => identity.id);
  const [reputationsResult, timelineResult] = await Promise.all([
    supabase
      .from("customer_reputation")
      .select("identity_id, total_orders, delivered_orders, returned_orders, refused_orders, cancelled_orders, delivered_count, returned_count, client_cancelled_count, no_answer_count, fake_order_count, phone_unreachable_count, refused_count, not_picked_up_count, bad_address_count, merchant_count, reputation_score, risk_level, updated_at")
      .in("identity_id", identityIds),
    supabase
      .from("delivery_orders")
      .select("identity_id, status, normalized_outcome_reason, source_payload, synced_at, provider")
      .in("identity_id", identityIds)
      .order("synced_at", { ascending: false })
      .limit(500)
  ]);

  let reputationRows = (reputationsResult.data ?? []) as Array<{
    identity_id: string;
    total_orders: number;
    delivered_orders: number;
    returned_orders: number;
    refused_orders: number;
    cancelled_orders: number;
    delivered_count?: number | null;
    returned_count?: number | null;
    client_cancelled_count?: number | null;
    no_answer_count?: number | null;
    fake_order_count?: number | null;
    phone_unreachable_count?: number | null;
    refused_count?: number | null;
    not_picked_up_count?: number | null;
    bad_address_count?: number | null;
    merchant_count: number;
    reputation_score: number;
    risk_level: string;
    updated_at: string;
  }>;
  if (reputationsResult.error && /fake_order_count/i.test(reputationsResult.error.message ?? "")) {
    const fallbackReputations = await supabase
      .from("customer_reputation")
      .select("identity_id, total_orders, delivered_orders, returned_orders, refused_orders, cancelled_orders, delivered_count, returned_count, client_cancelled_count, no_answer_count, phone_unreachable_count, refused_count, not_picked_up_count, bad_address_count, merchant_count, reputation_score, risk_level, updated_at")
      .in("identity_id", identityIds);

    if (fallbackReputations.error) {
      throw fallbackReputations.error;
    }

    reputationRows = (fallbackReputations.data ?? []) as Array<{
      identity_id: string;
      total_orders: number;
      delivered_orders: number;
      returned_orders: number;
      refused_orders: number;
      cancelled_orders: number;
      delivered_count?: number | null;
      returned_count?: number | null;
      client_cancelled_count?: number | null;
      no_answer_count?: number | null;
      fake_order_count?: number | null;
      phone_unreachable_count?: number | null;
      refused_count?: number | null;
      not_picked_up_count?: number | null;
      bad_address_count?: number | null;
      merchant_count: number;
      reputation_score: number;
      risk_level: string;
      updated_at: string;
    }>;
  } else if (reputationsResult.error) {
    throw reputationsResult.error;
  }
  let timelineRows = (timelineResult.data ?? []) as Array<{
    identity_id: string | null;
    status: string;
    normalized_outcome_reason?: string | null;
    source_payload?: Record<string, unknown> | null;
    synced_at: string;
    provider: string;
  }>;
  if (timelineResult.error && /normalized_outcome_reason/i.test(timelineResult.error.message ?? "")) {
    const fallbackTimeline = await supabase
      .from("delivery_orders")
      .select("identity_id, status, source_payload, synced_at, provider")
      .in("identity_id", identityIds)
      .order("synced_at", { ascending: false })
      .limit(500);

    if (fallbackTimeline.error) {
      throw fallbackTimeline.error;
    }

    timelineRows = (fallbackTimeline.data ?? []) as Array<{
      identity_id: string | null;
      status: string;
      normalized_outcome_reason?: string | null;
      source_payload?: Record<string, unknown> | null;
      synced_at: string;
      provider: string;
    }>;
  } else if (timelineResult.error) {
    throw timelineResult.error;
  }

  const reputationByIdentity = new Map(reputationRows.map((row) => [row.identity_id, row]));

  const timelineByIdentity = new Map<string, Array<{ status: string; normalized_outcome_reason: string | null; synced_at: string; provider: string }>>();
  const providerBreakdownByIdentity = new Map<string, Record<string, number>>();
  for (const row of timelineRows) {
    if (!row.identity_id) continue;
    const normalizedStatus = String(row.status ?? "").toUpperCase();
    const statusForOutcome = (
      normalizedStatus === "CONFIRMED"
      || normalizedStatus === "DELIVERED"
      || normalizedStatus === "RETURNED"
      || normalizedStatus === "REFUSED"
      || normalizedStatus === "CANCELLED"
      || normalizedStatus === "IN_TRANSIT"
      || normalizedStatus === "PENDING"
    )
      ? normalizedStatus as "CONFIRMED" | "DELIVERED" | "RETURNED" | "REFUSED" | "CANCELLED" | "IN_TRANSIT" | "PENDING"
      : "PENDING";

    const derivedOutcome = extractOutcomeContext({
      payload: row.source_payload ?? {},
      normalizedStatus: statusForOutcome
    }).normalizedOutcomeReason;

    const current = timelineByIdentity.get(row.identity_id) ?? [];
    current.push({
      status: row.status,
      normalized_outcome_reason: row.normalized_outcome_reason ?? derivedOutcome,
      synced_at: row.synced_at,
      provider: row.provider
    });
    timelineByIdentity.set(row.identity_id, current);

    const providerBreakdown = providerBreakdownByIdentity.get(row.identity_id) ?? {};
    providerBreakdown[row.provider] = (providerBreakdown[row.provider] ?? 0) + 1;
    providerBreakdownByIdentity.set(row.identity_id, providerBreakdown);
  }

  return identities.map((identity) => ({
    identity,
    reputation: reputationByIdentity.get(identity.id) ?? null,
    timeline: timelineByIdentity.get(identity.id) ?? [],
    providerBreakdown: providerBreakdownByIdentity.get(identity.id) ?? {}
  }));
}
