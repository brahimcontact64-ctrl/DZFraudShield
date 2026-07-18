import { createClient } from "@/lib/supabase/server";
import { unstable_noStore as noStore } from "next/cache";
import { getDashboardSessionUser } from "@/lib/auth/session-server";
import { resolveCurrentMerchant } from "@/lib/merchant/resolve";
import { type NetworkTrustLevel } from "@/lib/network-intelligence/customer-profile";

export type TopRiskCustomerRow = {
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
};

export type TopRiskyWilayaRow = {
  wilaya: string;
  averageRiskScore: number;
  totalChecks: number;
};

export type DashboardProductItem = {
  product_name: string;
  quantity: number;
  item_total: number;
};

export type DashboardCheckRow = {
  id: string;
  created_at: string;
  order_id?: string | null;
  external_order_id?: string | null;
  customer_name?: string | null;
  wilaya?: string | null;
  risk_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK";
  recommended_action?: string | null;
  cart_total?: number | null;
  total_amount?: number | null;
  product_names?: string[] | null;
  product_items: DashboardProductItem[];
  product_summary: string;
};

export type MerchantDecisionDashboardRow = {
  id: string;
  createdAt: string;
  customerName: string | null;
  phone: string | null;
  riskLevel: string | null;
  recommendedAction: string | null;
  merchantDecision: "ACCEPTED" | "VERIFY_FIRST" | "BLOCKED";
};

export type MerchantDecisionDashboardStats = {
  acceptedOrders: number;
  verificationRequired: number;
  blockedOrders: number;
  systemAcceptedMerchantAccepted: number;
  systemBlockedMerchantBlocked: number;
  overrideAcceptedDespiteWarning: number;
  overrideBlockedDespiteApproval: number;
  overrideRate: number;
  recent: MerchantDecisionDashboardRow[];
};

export type MerchantMobileOpsSnapshot = {
  todayOrders: number;
  needConfirmation: number;
  shipmentsCreated: number;
  delivered: number;
  failedOrReturned: number;
  customerReputationAlerts: number;
};

type RiskEventPayload = {
  rawPayload?: {
    productNames?: string[];
    productItems?: Array<{
      productName?: string | null;
      quantity?: number | null;
      itemTotal?: number | null;
      product_name?: string | null;
      item_total?: number | null;
    }>;
  };
};

export async function resolveDashboardMerchantId(): Promise<string | null> {
  noStore();
  const merchant = await resolveCurrentMerchant();
  return merchant?.id ?? null;
}

export async function getDefaultMerchantId(): Promise<string | null> {
  return resolveDashboardMerchantId();
}

function normalizeProductItems(productItems: unknown): DashboardProductItem[] {
  if (!Array.isArray(productItems)) {
    return [];
  }

  return productItems
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const rawItem = item as {
        productName?: string | null;
        product_name?: string | null;
        quantity?: number | null;
        itemTotal?: number | null;
        item_total?: number | null;
      };

      const productName = rawItem.product_name ?? rawItem.productName ?? null;
      if (!productName) {
        return null;
      }

      return {
        product_name: productName,
        quantity: Number(rawItem.quantity ?? 0),
        item_total: Number(rawItem.item_total ?? rawItem.itemTotal ?? 0)
      };
    })
    .filter((item): item is DashboardProductItem => Boolean(item));
}

function buildProductSummary(productItems: DashboardProductItem[], productNames: string[]): string {
  if (productItems.length > 0) {
    return productItems
      .map((item) => `${item.product_name} x${item.quantity} (${item.item_total.toFixed(2)})`)
      .join(", ");
  }

  if (productNames.length > 0) {
    return productNames.join(", ");
  }

  return "-";
}

export async function listDashboardChecks(merchantId: string, options?: { level?: string; limit?: number }) {
  noStore();
  const supabase = createClient();
  let query = supabase
    .from("order_checks")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.level) {
    query = query.eq("risk_level", options.level.toUpperCase());
  }

  const { data: checks } = await query;
  const checkIds = (checks ?? []).map((check) => check.id);
  const { data: events } = checkIds.length
    ? await supabase
        .from("risk_events")
        .select("order_check_id, payload, created_at")
        .eq("merchant_id", merchantId)
        .eq("event_type", "risk_check_created")
        .in("order_check_id", checkIds)
        .order("created_at", { ascending: false })
    : { data: [] };

  const eventByCheckId = new Map<string, RiskEventPayload>();
  for (const event of events ?? []) {
    if (event.order_check_id && !eventByCheckId.has(event.order_check_id)) {
      eventByCheckId.set(event.order_check_id, (event.payload ?? {}) as RiskEventPayload);
    }
  }

  return (checks ?? []).map((check) => {
    const eventPayload = eventByCheckId.get(check.id);
    const fallbackProductItems = normalizeProductItems(eventPayload?.rawPayload?.productItems ?? []);
    const fallbackProductNames = Array.isArray(eventPayload?.rawPayload?.productNames)
      ? eventPayload?.rawPayload?.productNames.filter((name): name is string => Boolean(name))
      : [];
    const ownProductItems = normalizeProductItems((check as { product_items?: unknown }).product_items ?? []);
    const productItems = ownProductItems.length > 0 ? ownProductItems : fallbackProductItems;
    const productNames = Array.isArray(check.product_names) && check.product_names.length > 0
      ? check.product_names.filter((name: unknown): name is string => typeof name === "string" && Boolean(name))
      : fallbackProductNames;

    return {
      ...check,
      product_items: productItems,
      product_summary: buildProductSummary(productItems, productNames),
      product_names: productNames
    } as DashboardCheckRow;
  });
}

function buildTopRiskyWilayas(rows: Array<{ wilaya: string | null; risk_score: number | null }>): TopRiskyWilayaRow[] {
  const grouped = new Map<string, { totalChecks: number; scoreSum: number }>();

  for (const row of rows) {
    const wilaya = row.wilaya?.trim() || "Unknown";
    const score = Number(row.risk_score ?? 0);
    const current = grouped.get(wilaya) ?? { totalChecks: 0, scoreSum: 0 };
    current.totalChecks += 1;
    current.scoreSum += score;
    grouped.set(wilaya, current);
  }

  return Array.from(grouped.entries())
    .map(([wilaya, stats]) => ({
      wilaya,
      totalChecks: stats.totalChecks,
      averageRiskScore: stats.scoreSum / stats.totalChecks
    }))
    .sort((left, right) => {
      if (right.averageRiskScore !== left.averageRiskScore) {
        return right.averageRiskScore - left.averageRiskScore;
      }

      if (right.totalChecks !== left.totalChecks) {
        return right.totalChecks - left.totalChecks;
      }

      return left.wilaya.localeCompare(right.wilaya);
    })
    .slice(0, 10);
}

export async function getDashboardStats(merchantId: string) {
  const checks = await listDashboardChecks(merchantId, { limit: 50 });
  const blockedChecks = checks.filter((check) => check.risk_level === "BLOCK" || check.risk_level === "CRITICAL" || check.recommended_action === "block");
  const highRiskChecks = checks.filter((check) => check.risk_level === "HIGH" || check.risk_level === "CRITICAL" || check.risk_level === "BLOCK");
  const riskyRows = checks
    .filter((check) => check.risk_level === "HIGH" || check.risk_level === "CRITICAL" || check.risk_level === "BLOCK")
    .map((check) => ({ wilaya: check.wilaya ?? null, risk_score: check.risk_score ?? 0 }));
  const estimatedSavedLosses = blockedChecks.reduce((losses, row) => losses + Number(row.total_amount ?? row.cart_total ?? 0), 0);

  return {
    totalChecks: checks.length,
    blockedOrders: blockedChecks.length,
    highRiskOrders: highRiskChecks.length,
    estimatedSavedLosses,
    topRiskyWilayas: buildTopRiskyWilayas(riskyRows),
    recentChecks: checks.slice(0, 15)
  };
}

/** Maps a raw check row to a merchant-facing simplified risk status. */
export function merchantRiskStatusFromCheck(check: {
  risk_level: string;
  risk_score: number;
  recommended_action?: string | null;
}): { status: "CLEAN" | "WATCHLIST" | "RISKY" | "BLACKLISTED"; summary: string } {
  const level = (check.risk_level ?? "LOW").toUpperCase();
  const score = Number(check.risk_score ?? 0);

  if (level === "BLOCK" || level === "CRITICAL" || check.recommended_action === "block") {
    return { status: "BLACKLISTED", summary: "Multiple fraud signals detected" };
  }
  if (level === "HIGH" || check.recommended_action === "manual_review") {
    return { status: "RISKY", summary: `Risk score ${score} — review before shipping` };
  }
  if (level === "MEDIUM" || check.recommended_action === "verify") {
    return { status: "WATCHLIST", summary: `Risk score ${score} — verify before shipping` };
  }
  return { status: "CLEAN", summary: `Risk score ${score} — safe to ship` };
}

export async function getTopRiskCustomers(limit = 10): Promise<TopRiskCustomerRow[]> {
  noStore();
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

export async function getMerchantDecisionDashboardStats(merchantId: string): Promise<MerchantDecisionDashboardStats> {
  noStore();
  const supabase = createClient();

  const { data: decisions } = await supabase
    .from("merchant_decisions")
    .select("id, created_at, order_check_id, phone, decision, risk_level, recommended_action")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = decisions ?? [];
  const acceptedOrders = rows.filter((row) => row.decision === "ACCEPTED").length;
  const verificationRequired = rows.filter((row) => row.decision === "VERIFY_FIRST").length;
  const blockedOrders = rows.filter((row) => row.decision === "BLOCKED").length;

  const systemAcceptedMerchantAccepted = rows.filter((row) => row.recommended_action === "accept" && row.decision === "ACCEPTED").length;
  const systemBlockedMerchantBlocked = rows.filter((row) => row.recommended_action === "block" && row.decision === "BLOCKED").length;
  const overrideAcceptedDespiteWarning = rows.filter((row) => row.decision === "ACCEPTED" && row.recommended_action !== "accept").length;
  const overrideBlockedDespiteApproval = rows.filter((row) => row.decision === "BLOCKED" && row.recommended_action === "accept").length;
  const overrideCount = overrideAcceptedDespiteWarning + overrideBlockedDespiteApproval;
  const overrideRate = rows.length > 0 ? Math.round((overrideCount / rows.length) * 100) : 0;

  const orderCheckIds = rows.map((row) => row.order_check_id).filter(Boolean);
  const { data: checks } = orderCheckIds.length > 0
    ? await supabase
        .from("order_checks")
        .select("id, customer_name")
        .eq("merchant_id", merchantId)
        .in("id", orderCheckIds)
    : { data: [] as Array<{ id: string; customer_name: string | null }> };

  const customerByCheck = new Map((checks ?? []).map((check) => [check.id, check.customer_name]));

  const recent = rows.slice(0, 15).map((row) => ({
    id: row.id,
    createdAt: String(row.created_at),
    customerName: customerByCheck.get(row.order_check_id) ?? null,
    phone: row.phone ? String(row.phone) : null,
    riskLevel: row.risk_level ? String(row.risk_level) : null,
    recommendedAction: row.recommended_action ? String(row.recommended_action) : null,
    merchantDecision: row.decision as "ACCEPTED" | "VERIFY_FIRST" | "BLOCKED"
  }));

  return {
    acceptedOrders,
    verificationRequired,
    blockedOrders,
    systemAcceptedMerchantAccepted,
    systemBlockedMerchantBlocked,
    overrideAcceptedDespiteWarning,
    overrideBlockedDespiteApproval,
    overrideRate,
    recent
  };
}

export async function getMerchantMobileOpsSnapshot(merchantId: string): Promise<MerchantMobileOpsSnapshot> {
  noStore();
  const supabase = createClient();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todayIso = start.toISOString();

  const [
    todayOrders,
    needConfirmation,
    shipmentsCreated,
    delivered,
    failedOrReturned,
    customerReputationAlerts,
  ] = await Promise.all([
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .gte("created_at", todayIso),
    supabase
      .from("merchant_decisions")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("decision", "VERIFY_FIRST"),
    supabase
      .from("merchant_shipments")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .in("shipment_status", ["CREATED", "LABEL_READY", "IN_TRANSIT"]),
    supabase
      .from("merchant_shipments")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("shipment_status", "DELIVERED"),
    supabase
      .from("merchant_shipments")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .in("shipment_status", ["FAILED", "RETURNED", "REFUSED"]),
    supabase
      .from("customer_reputation")
      .select("phone_hash", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .gt("failed_count", 2),
  ]);

  return {
    todayOrders: todayOrders.count ?? 0,
    needConfirmation: needConfirmation.count ?? 0,
    shipmentsCreated: shipmentsCreated.count ?? 0,
    delivered: delivered.count ?? 0,
    failedOrReturned: failedOrReturned.count ?? 0,
    customerReputationAlerts: customerReputationAlerts.count ?? 0,
  };
}
