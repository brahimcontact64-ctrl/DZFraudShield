import { createClient } from "@/lib/supabase/server";
import { normalizeAlgerianPhone } from "@/lib/security/phone";

const DELIVERY_DASHBOARD_SAMPLE_LIMIT = 2000;

function toRate(part: number, total: number): number {
  if (!total) {
    return 0;
  }

  return Number(((part / total) * 100).toFixed(2));
}

export function computeLifetimeSuccessRate(delivered: number, returned: number): number {
  const denominator = delivered + returned;
  if (!denominator) {
    return 0;
  }

  return Number(((delivered / denominator) * 100).toFixed(1));
}

export type DeliverySummaryOrderRow = {
  status: string | null;
  identity_id?: string | null;
  customer_phone?: string | null;
  customer_name?: string | null;
};

export function computeDeliverySummaryMetrics(orderRows: DeliverySummaryOrderRow[]) {
  const byStatus = orderRows.reduce((acc, row) => {
    const key = row.status || "PENDING";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalOrders = orderRows.length;
  const deliveredOrders = byStatus.DELIVERED ?? 0;
  const returnedOrders = byStatus.RETURNED ?? 0;

  const riskyCustomers = new Map<string, { label: string; total: number; delivered: number; returned: number; phone: string | null }>();
  const riskyPhones = new Map<string, { total: number; delivered: number; returned: number }>();

  for (const row of orderRows) {
    const canonicalPhone = normalizeAlgerianPhone(row.customer_phone ?? "") ?? null;
    const customerKey = row.identity_id ?? canonicalPhone ?? row.customer_name ?? "Unknown";
    const customerLabel = row.customer_name?.trim() || canonicalPhone || String(customerKey);
    const customerStats = riskyCustomers.get(customerKey) ?? {
      label: customerLabel,
      total: 0,
      delivered: 0,
      returned: 0,
      phone: canonicalPhone
    };

    customerStats.total += 1;
    if (row.status === "DELIVERED") customerStats.delivered += 1;
    if (row.status === "RETURNED") customerStats.returned += 1;
    riskyCustomers.set(customerKey, customerStats);

    if (canonicalPhone) {
      const phoneStats = riskyPhones.get(canonicalPhone) ?? { total: 0, delivered: 0, returned: 0 };
      phoneStats.total += 1;
      if (row.status === "DELIVERED") phoneStats.delivered += 1;
      if (row.status === "RETURNED") phoneStats.returned += 1;
      riskyPhones.set(canonicalPhone, phoneStats);
    }
  }

  const topRiskyCustomers = Array.from(riskyCustomers.entries())
    .map(([id, stats]) => ({
      id,
      label: stats.label,
      phone: stats.phone,
      total_orders: stats.total,
      delivered_orders: stats.delivered,
      returned_orders: stats.returned,
      return_rate: toRate(stats.returned, stats.total)
    }))
    .sort((left, right) => {
      if (right.return_rate !== left.return_rate) return right.return_rate - left.return_rate;
      if (right.returned_orders !== left.returned_orders) return right.returned_orders - left.returned_orders;
      return right.total_orders - left.total_orders;
    })
    .slice(0, 10);

  const topRiskyPhoneNumbers = Array.from(riskyPhones.entries())
    .map(([phone, stats]) => ({
      phone,
      total_orders: stats.total,
      delivered_orders: stats.delivered,
      returned_orders: stats.returned,
      return_rate: toRate(stats.returned, stats.total)
    }))
    .sort((left, right) => {
      if (right.return_rate !== left.return_rate) return right.return_rate - left.return_rate;
      if (right.returned_orders !== left.returned_orders) return right.returned_orders - left.returned_orders;
      return right.total_orders - left.total_orders;
    })
    .slice(0, 10);

  return {
    byStatus,
    totalOrders,
    deliveredOrders,
    returnedOrders,
    deliveryRate: toRate(deliveredOrders, totalOrders),
    returnRate: toRate(returnedOrders, totalOrders),
    topRiskyCustomers,
    topRiskyPhoneNumbers
  };
}

export async function getDeliveryProviders() {
  const supabase = createClient();
  const { data, error } = await supabase.from("delivery_providers").select("code, name, is_active, config_schema").order("name", { ascending: true });
  if (error) {
    throw error;
  }

  const visibilityByProvider: Record<string, { visibleToMerchants: boolean; comingSoon: boolean }> = {
    zr_express: { visibleToMerchants: true, comingSoon: false },
    yalidine: { visibleToMerchants: true, comingSoon: false },
    procolis: { visibleToMerchants: true, comingSoon: false },
    ecotrack: { visibleToMerchants: false, comingSoon: true },
    guepex: { visibleToMerchants: false, comingSoon: true },
    noest: { visibleToMerchants: false, comingSoon: true },
    custom: { visibleToMerchants: false, comingSoon: true }
  };

  return (data ?? []).map((provider) => {
    const flags = visibilityByProvider[provider.code] ?? { visibleToMerchants: false, comingSoon: true };
    return {
      id: provider.code,
      code: provider.code,
      name: provider.name,
      enabled: Boolean(provider.is_active),
      is_active: provider.is_active,
      visible_to_merchants: flags.visibleToMerchants,
      coming_soon: flags.comingSoon,
      config_schema: provider.config_schema ?? null
    };
  });
}

export async function getDeliveryAccountsDashboard(merchantId: string) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_delivery_accounts")
    .select("id, provider, provider_name, account_label, base_url, auth_type, endpoints, field_mapping, status_mapping, active, connection_status, failure_streak, suspended_until, last_connection_test_at, last_error_message, last_sync_at, created_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getCustomerReputationDashboard(merchantId: string) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("delivery_orders")
    .select("identity_id")
    .eq("merchant_id", merchantId)
    .not("identity_id", "is", null)
    .order("synced_at", { ascending: false })
    .limit(DELIVERY_DASHBOARD_SAMPLE_LIMIT);

  if (error) {
    throw error;
  }

  const identityIds = Array.from(new Set((data ?? []).map((row) => row.identity_id).filter(Boolean)));
  if (!identityIds.length) {
    return [];
  }

  const { data: rows, error: reputationError } = await supabase
    .from("customer_reputation")
    .select("identity_id, total_orders, delivered_orders, returned_orders, refused_orders, cancelled_orders, merchant_count, reputation_score, risk_level, updated_at")
    .in("identity_id", identityIds)
    .order("reputation_score", { ascending: true })
    .limit(100);

  if (reputationError) {
    throw reputationError;
  }

  return (rows ?? []).map((row) => {
    const totalOrders = Number(row.total_orders ?? 0);
    const returnedOrders = Number(row.returned_orders ?? 0);
    return {
      ...row,
      return_rate: toRate(returnedOrders, totalOrders)
    };
  });
}

export async function getIdentityFingerprintDashboard() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("identity_fingerprint")
    .select("id, fingerprint_hash, confidence_score, created_at, identity_links(count)")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getMarketInsightsDashboard(merchantId: string) {
  const supabase = createClient();

  const [insights, categories, wilayas] = await Promise.all([
    supabase
      .from("market_insights")
      .select("id, insight_type, insight_key, insight_text, metric_payload, generated_at")
      .eq("merchant_id", merchantId)
      .order("generated_at", { ascending: false })
      .limit(30),
    supabase
      .from("category_performance")
      .select("category, orders, delivery_rate, return_rate, average_order_value, period_start, period_end")
      .eq("merchant_id", merchantId)
      .eq("wilaya", "ALL")
      .order("orders", { ascending: false })
      .limit(15),
    supabase
      .from("wilaya_performance")
      .select("wilaya, orders, delivery_rate, return_rate, average_order_value, period_start, period_end")
      .eq("merchant_id", merchantId)
      .order("orders", { ascending: false })
      .limit(20)
  ]);

  if (insights.error) throw insights.error;
  if (categories.error) throw categories.error;
  if (wilayas.error) throw wilayas.error;

  return {
    insights: insights.data ?? [],
    categories: categories.data ?? [],
    wilayas: wilayas.data ?? []
  };
}

export async function getDeliverySuccessChartData(merchantId: string) {
  const supabase = createClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("delivery_orders")
    .select("synced_at, status")
    .eq("merchant_id", merchantId)
    .gte("synced_at", since)
    .order("synced_at", { ascending: true });

  if (error) {
    throw error;
  }

  const grouped = new Map<string, { delivered: number; returned: number; refused: number; total: number }>();
  for (const row of data ?? []) {
    const day = new Date(row.synced_at).toISOString().slice(0, 10);
    const current = grouped.get(day) ?? { delivered: 0, returned: 0, refused: 0, total: 0 };
    current.total += 1;
    if (row.status === "DELIVERED") current.delivered += 1;
    if (row.status === "RETURNED") current.returned += 1;
    if (row.status === "REFUSED") current.refused += 1;
    grouped.set(day, current);
  }

  return Array.from(grouped.entries()).map(([day, value]) => ({ day, ...value }));
}

export async function getMerchantDeliverySummary(merchantId: string) {
  const supabase = createClient();

  const [orders, identityRows, checks] = await Promise.all([
    supabase
      .from("delivery_orders")
      .select("status, identity_id, customer_phone, customer_name", { count: "exact" })
      .eq("merchant_id", merchantId)
      .order("synced_at", { ascending: false })
      .limit(DELIVERY_DASHBOARD_SAMPLE_LIMIT),
    supabase
      .from("delivery_orders")
      .select("identity_id")
      .eq("merchant_id", merchantId)
      .not("identity_id", "is", null)
      .order("synced_at", { ascending: false })
      .limit(DELIVERY_DASHBOARD_SAMPLE_LIMIT),
    supabase
      .from("order_checks")
      .select("network_risk_score, network_recommendation")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(500)
  ]);

  if (orders.error) throw orders.error;
  if (identityRows.error) throw identityRows.error;
  if (checks.error) throw checks.error;

  const merchantIdentityIds = Array.from(new Set((identityRows.data ?? []).map((row) => row.identity_id).filter(Boolean)));
  let customerReputationProfiles = 0;
  if (merchantIdentityIds.length) {
    const { count, error } = await supabase
      .from("customer_reputation")
      .select("identity_id", { count: "exact", head: true })
      .in("identity_id", merchantIdentityIds);
    if (error) throw error;
    customerReputationProfiles = count ?? 0;
  }

  const orderRows = orders.data ?? [];
  const checksRows = checks.data ?? [];

  const metrics = computeDeliverySummaryMetrics(orderRows);

  const avgRisk = checksRows.length
    ? Math.round(checksRows.reduce((sum, row) => sum + Number(row.network_risk_score ?? 0), 0) / checksRows.length)
    : 0;

  const recommendationCounts = checksRows.reduce((acc, row) => {
    const rec = row.network_recommendation ?? "REVIEW";
    acc[rec] = (acc[rec] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalOrders = orders.count ?? metrics.totalOrders;

  return {
    ordersSynced: totalOrders,
    customerReputationProfiles,
    averageRiskScore: avgRisk,
    recommendationCounts,
    deliveryStatusBreakdown: metrics.byStatus,
    total_orders: totalOrders,
    delivered_orders: metrics.deliveredOrders,
    returned_orders: metrics.returnedOrders,
    delivery_rate: metrics.deliveryRate,
    return_rate: metrics.returnRate,
    top_risky_customers: metrics.topRiskyCustomers,
    top_risky_phone_numbers: metrics.topRiskyPhoneNumbers
  };
}
