import { unstable_noStore as noStore } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { mapLegacyShipmentStatus, toHumanDeliveryStatus, type DeliveryLifecycleStatus } from "@/lib/delivery-intelligence/tracking-engine";

const DEFAULT_SHIPPING_COST_DZD = Number(process.env.DZFS_SHIPPING_COST_DZD ?? 500);

type RawProductItem = {
  product_name?: string | null;
  productName?: string | null;
  quantity?: number | null;
  item_total?: number | null;
  itemTotal?: number | null;
  product_cost?: number | null;
  productCost?: number | null;
  cost?: number | null;
  stock_quantity?: number | null;
  stockQuantity?: number | null;
};

type CheckRow = {
  id: string;
  created_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  wilaya: string | null;
  risk_score: number | null;
  recommended_action: string | null;
  total_amount: number | null;
  cart_total: number | null;
  product_items: unknown;
};

type ShipmentRow = {
  id: string;
  order_check_id: string;
  provider: string;
  shipment_status: string;
  delivery_status: string | null;
  delivery_status_updated_at: string | null;
  delivery_company_name: string | null;
  tracking_number: string | null;
  label_pdf_url: string | null;
  labels_url: string | null;
  label_url: string | null;
  shipment_created_at: string | null;
  updated_at: string;
};

type ShipmentEventRow = {
  shipment_id: string;
  old_status: string | null;
  new_status: string;
  event_date: string;
};

type RiskEventRow = {
  order_check_id: string | null;
  payload: {
    intelligence?: {
      customerNetworkProfile?: {
        networkTrustLevel?: string;
      };
    };
  } | null;
};

type ReputationRow = {
  id: string;
  trust_level: string | null;
  merchant_count: number | null;
  delivered_count: number | null;
  failed_count: number | null;
  returned_count: number | null;
};

type NotificationRow = {
  id: string;
  provider: string | null;
  level: "info" | "warning" | "critical";
  event_type: string;
  title: string | null;
  notification_type: string | null;
  message: string;
  created_at: string;
  resolved_at: string | null;
  deleted_at: string | null;
};

export type OverviewMetricSnapshot = {
  ordersToday: number;
  confirmedOrders: number;
  refusedOrders: number;
  noAnswerOrders: number;
  activeShipments: number;
  deliveredOrders: number;
  returnRate: number;
  revenueDzd: number;
  savedLossesDzd: number;
};

export type OverviewOrderCard = {
  id: string;
  customerName: string;
  wilaya: string;
  riskScore: number;
  trustLevel: string;
  recommendation: "Confirm" | "Verify" | "Refuse";
};

export type OverviewData = {
  metrics: OverviewMetricSnapshot;
  recentOrders: OverviewOrderCard[];
};

export type ShipmentControlCard = {
  id: string;
  trackingNumber: string;
  provider: string;
  shipmentStatus: DeliveryLifecycleStatus;
  shipmentStatusLabel: string;
  labelLink: string | null;
  createdDate: string | null;
  lastCourierUpdate: string;
  lastUpdateDate: string;
  deliveryCompanyName: string;
  statusHistory: Array<{
    oldStatus: string | null;
    newStatus: DeliveryLifecycleStatus;
    eventDate: string;
    newStatusLabel: string;
  }>;
};

export type NetworkMerchantView = {
  id: string;
  trustLevel: string;
  seenByMerchants: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  recommendation: "Confirm" | "Verify" | "Refuse";
};

export type MerchantNotificationView = {
  id: string;
  event: string;
  message: string;
  provider: string | null;
  level: "info" | "warning" | "critical";
  createdAt: string;
  resolved: boolean;
};

export type ShipmentLifecycleStats = {
  deliveredParcels: number;
  refusedParcels: number;
  unreachableCustomers: number;
  returnRate: number;
  deliverySuccessRate: number;
};

export type InsightsSummary = {
  revenueDzd: number;
  deliveredOrders: number;
  returnedOrders: number;
  returnRate: number;
  shippingCostPerOrderDzd: number;
  shippingCostTotalDzd: number;
  grossProfitDzd: number;
  productCostTotalDzd: number | null;
  netProfitDzd: number | null;
};

export type InsightsProduct = {
  productName: string;
  revenueDzd: number;
  deliveredOrders: number;
  returnedOrders: number;
  returnRate: number;
};

export type InsightsCustomer = {
  customer: string;
  deliveredOrders: number;
  revenueDzd: number;
  returnRate: number;
};

export type InsightsWilaya = {
  wilaya: string;
  deliveredOrders: number;
  returnedOrders: number;
  revenueDzd: number;
  returnRate: number;
};

export type InsightsCourier = {
  provider: string;
  deliveredOrders: number;
  returnedOrders: number;
  failedOrders: number;
  deliveryRate: number;
};

export type InsightsData = {
  summary: InsightsSummary;
  topProducts: InsightsProduct[];
  bestCustomers: InsightsCustomer[];
  topWilayas: InsightsWilaya[];
  courierPerformance: InsightsCourier[];
};

export type SmartInventoryProduct = {
  productName: string;
  revenueDzd: number;
  deliveredOrders: number;
  returnedOrders: number;
  returnRate: number;
  salesVelocityPerDay: number;
  estimatedStockHealth: "Healthy" | "Low" | "Critical";
  message: string;
  stockQuantity: number | null;
};

function normalizeProviderName(provider: string): string {
  return provider.replace(/_/g, " ");
}

function normalizeRecommendation(raw: string | null | undefined): "Confirm" | "Verify" | "Refuse" {
  const value = String(raw ?? "verify").toLowerCase();
  if (value === "accept") return "Confirm";
  if (value === "block") return "Refuse";
  return "Verify";
}

function normalizeTrustLevel(raw: string | null | undefined): string {
  const value = String(raw ?? "NORMAL").toUpperCase();
  if (value === "TRUSTED") return "TRUSTED";
  if (value === "BLACKLIST") return "BLACKLIST";
  if (value === "HIGH_RISK") return "HIGH_RISK";
  if (value === "WATCHLIST") return "WATCHLIST";
  return "NORMAL";
}

function recommendationFromTrustLevel(raw: string | null | undefined): "Confirm" | "Verify" | "Refuse" {
  const trust = normalizeTrustLevel(raw);
  if (trust === "TRUSTED") return "Confirm";
  if (trust === "HIGH_RISK" || trust === "BLACKLIST") return "Refuse";
  return "Verify";
}

function normalizeShipmentStatus(rawDeliveryStatus: string | null | undefined, legacyStatus: string | null | undefined): ShipmentControlCard["shipmentStatus"] {
  const value = String(rawDeliveryStatus ?? "").trim().toUpperCase();
  if (value) {
    return value as DeliveryLifecycleStatus;
  }

  const normalizedLegacy = String(legacyStatus ?? "CREATED").toUpperCase();
  if (normalizedLegacy === "DELIVERED") return "DELIVERED_SUCCESSFULLY";
  if (normalizedLegacy === "IN_TRANSIT") return "IN_TRANSIT";
  if (normalizedLegacy === "FAILED" || normalizedLegacy === "CANCELLED") return "DELIVERY_FAILED";
  if (normalizedLegacy === "PENDING") return "AWAITING_PICKUP";
  return mapLegacyShipmentStatus("CREATED");
}

function isDeliveredShipmentStatus(status: ShipmentControlCard["shipmentStatus"]): boolean {
  return status === "DELIVERED_SUCCESSFULLY";
}

function isReturnedShipmentStatus(status: ShipmentControlCard["shipmentStatus"]): boolean {
  return status === "CUSTOMER_REFUSED_PARCEL"
    || status === "RETURNED_TO_SENDER"
    || status === "RETURN_RECEIVED_BY_MERCHANT";
}

function isFailedShipmentStatus(status: ShipmentControlCard["shipmentStatus"]): boolean {
  return status === "DELIVERY_FAILED" || status === "CUSTOMER_UNREACHABLE";
}

function parseProductItems(value: unknown): Array<{ productName: string; quantity: number; itemTotal: number; productCost: number | null; stockQuantity: number | null }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const item = entry as RawProductItem;
      const productName = String(item.product_name ?? item.productName ?? "").trim();
      if (!productName) {
        return null;
      }

      const quantity = Math.max(0, Number(item.quantity ?? 0));
      const itemTotal = Number(item.item_total ?? item.itemTotal ?? 0);
      const rawCost = Number(item.product_cost ?? item.productCost ?? item.cost ?? NaN);
      const rawStock = Number(item.stock_quantity ?? item.stockQuantity ?? NaN);

      return {
        productName,
        quantity,
        itemTotal,
        productCost: Number.isFinite(rawCost) ? rawCost : null,
        stockQuantity: Number.isFinite(rawStock) ? rawStock : null
      };
    })
    .filter((item): item is { productName: string; quantity: number; itemTotal: number; productCost: number | null; stockQuantity: number | null } => Boolean(item));
}

function safeOrderAmount(row: Pick<CheckRow, "total_amount" | "cart_total">): number {
  return Number(row.total_amount ?? row.cart_total ?? 0);
}

function rate(part: number, total: number): number {
  if (!total) {
    return 0;
  }
  return Number(((part / total) * 100).toFixed(2));
}

const MERCHANT_OPS_SAMPLE_LIMIT = 180;
const MERCHANT_OPS_ID_WINDOW = 220;

async function fetchChecksAndShipments(merchantId: string) {
  const supabase = createClient();
  const [checksResult, shipmentsResult] = await Promise.all([
    supabase
      .from("order_checks")
      .select("id, created_at, customer_name, customer_phone, wilaya, risk_score, recommended_action, total_amount, cart_total, product_items")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(MERCHANT_OPS_SAMPLE_LIMIT),
    supabase
      .from("merchant_shipments")
      .select("id, order_check_id, provider, shipment_status, delivery_status, delivery_status_updated_at, delivery_company_name, tracking_number, label_pdf_url, labels_url, label_url, shipment_created_at, updated_at")
      .eq("merchant_id", merchantId)
      .order("updated_at", { ascending: false })
        .limit(MERCHANT_OPS_SAMPLE_LIMIT)
  ]);

  if (checksResult.error) {
    throw checksResult.error;
  }
  if (shipmentsResult.error) {
    throw shipmentsResult.error;
  }

  return {
    checks: (checksResult.data ?? []) as CheckRow[],
    shipments: (shipmentsResult.data ?? []) as ShipmentRow[]
  };
}

export async function getOverviewData(merchantId: string): Promise<OverviewData> {
  noStore();
  const supabase = createClient();

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todayIso = start.toISOString();

  const [checksResult, acceptedDecisionsCountResult, blockedDecisionsCountResult, blockedDecisionIdsResult, noAnswerResult, activeShipmentsResult, deliveredShipmentsCountResult, deliveredShipmentsResult, returnShipmentsResult, recentChecksResult] = await Promise.all([
    supabase
      .from("order_checks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .gte("created_at", todayIso),
    supabase
      .from("merchant_decisions")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("decision", "ACCEPTED"),
    supabase
      .from("merchant_decisions")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("decision", "BLOCKED"),
    supabase
      .from("merchant_decisions")
      .select("order_check_id")
      .eq("merchant_id", merchantId)
      .eq("decision", "BLOCKED")
      .order("created_at", { ascending: false })
      .limit(MERCHANT_OPS_ID_WINDOW),
    supabase
      .from("risk_events")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("event_type", "call_center_no_answer")
      .gte("created_at", todayIso),
    supabase
      .from("merchant_shipments")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .in("shipment_status", ["CREATED", "LABEL_READY", "PICKED_UP", "IN_TRANSIT"]),
    supabase
      .from("merchant_shipments")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("shipment_status", "DELIVERED"),
    supabase
      .from("merchant_shipments")
      .select("order_check_id")
      .eq("merchant_id", merchantId)
      .eq("shipment_status", "DELIVERED")
      .order("updated_at", { ascending: false })
      .limit(MERCHANT_OPS_ID_WINDOW),
    supabase
      .from("merchant_shipments")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .in("shipment_status", ["RETURNED", "REFUSED", "FAILED", "CANCELLED"]),
    supabase
      .from("order_checks")
      .select("id, customer_name, wilaya, risk_score, recommended_action")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(12)
  ]);

  if (checksResult.error) throw checksResult.error;
  if (acceptedDecisionsCountResult.error) throw acceptedDecisionsCountResult.error;
  if (blockedDecisionsCountResult.error) throw blockedDecisionsCountResult.error;
  if (blockedDecisionIdsResult.error) throw blockedDecisionIdsResult.error;
  if (noAnswerResult.error) throw noAnswerResult.error;
  if (activeShipmentsResult.error) throw activeShipmentsResult.error;
  if (deliveredShipmentsCountResult.error) throw deliveredShipmentsCountResult.error;
  if (deliveredShipmentsResult.error) throw deliveredShipmentsResult.error;
  if (returnShipmentsResult.error) throw returnShipmentsResult.error;
  if (recentChecksResult.error) throw recentChecksResult.error;

  const confirmedOrders = acceptedDecisionsCountResult.count ?? 0;
  const refusedOrders = blockedDecisionsCountResult.count ?? 0;

  const deliveredCheckIds = Array.from(
    new Set((deliveredShipmentsResult.data ?? []).map((row) => row.order_check_id).filter((value): value is string => Boolean(value)))
  );

  let revenueDzd = 0;
  if (deliveredCheckIds.length > 0) {
    const deliveredChecks = await supabase
      .from("order_checks")
      .select("id, total_amount, cart_total")
      .eq("merchant_id", merchantId)
      .in("id", deliveredCheckIds);

    if (deliveredChecks.error) {
      throw deliveredChecks.error;
    }

    revenueDzd = (deliveredChecks.data ?? []).reduce((sum, row) => sum + Number(row.total_amount ?? row.cart_total ?? 0), 0);
  }

  const refusedDecisionIds = Array.from(
    new Set((blockedDecisionIdsResult.data ?? []).map((row) => row.order_check_id).filter((value): value is string => Boolean(value)))
  );

  let savedLossesDzd = 0;
  if (refusedDecisionIds.length > 0) {
    const refusedChecks = await supabase
      .from("order_checks")
      .select("id, total_amount, cart_total")
      .eq("merchant_id", merchantId)
      .in("id", refusedDecisionIds);

    if (refusedChecks.error) {
      throw refusedChecks.error;
    }

    savedLossesDzd = (refusedChecks.data ?? []).reduce((sum, row) => sum + Number(row.total_amount ?? row.cart_total ?? 0), 0);
  }

  const recentCheckIds = (recentChecksResult.data ?? []).map((row) => row.id);
  const riskEventsResult = recentCheckIds.length
    ? await supabase
        .from("risk_events")
        .select("order_check_id, payload")
        .eq("merchant_id", merchantId)
        .eq("event_type", "risk_check_created")
        .in("order_check_id", recentCheckIds)
    : { data: [], error: null };

  if (riskEventsResult.error) throw riskEventsResult.error;

  const trustMap = new Map<string, string>();
  for (const event of (riskEventsResult.data ?? []) as RiskEventRow[]) {
    if (!event.order_check_id || trustMap.has(event.order_check_id)) continue;
    trustMap.set(event.order_check_id, normalizeTrustLevel(event.payload?.intelligence?.customerNetworkProfile?.networkTrustLevel));
  }

  const recentOrders: OverviewOrderCard[] = (recentChecksResult.data ?? []).map((row) => ({
    id: row.id,
    customerName: row.customer_name ?? "Unknown Customer",
    wilaya: row.wilaya ?? "Unknown Wilaya",
    riskScore: Number(row.risk_score ?? 0),
    trustLevel: trustMap.get(row.id) ?? "NORMAL",
    recommendation: normalizeRecommendation(row.recommended_action)
  }));

  const deliveredCount = deliveredShipmentsCountResult.count ?? 0;
  const returnCount = returnShipmentsResult.count ?? 0;

  return {
    metrics: {
      ordersToday: checksResult.count ?? 0,
      confirmedOrders,
      refusedOrders,
      noAnswerOrders: noAnswerResult.count ?? 0,
      activeShipments: activeShipmentsResult.count ?? 0,
      deliveredOrders: deliveredCount,
      returnRate: rate(returnCount, deliveredCount + returnCount),
      revenueDzd,
      savedLossesDzd
    },
    recentOrders
  };
}

export async function listShipmentControlCards(merchantId: string): Promise<ShipmentControlCard[]> {
  noStore();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_shipments")
    .select("id, order_check_id, tracking_number, provider, shipment_status, delivery_status, delivery_status_updated_at, delivery_company_name, label_pdf_url, labels_url, label_url, shipment_created_at, updated_at")
    .eq("merchant_id", merchantId)
    .order("updated_at", { ascending: false })
    .limit(80);

  if (error) throw error;

  const shipments = (data ?? []) as ShipmentRow[];
  const shipmentIds = shipments.map((row) => row.id);

  let eventsByShipment = new Map<string, ShipmentEventRow[]>();
  if (shipmentIds.length > 0) {
    const { data: eventRows, error: eventsError } = await supabase
      .from("shipment_events")
      .select("shipment_id, old_status, new_status, event_date")
      .in("shipment_id", shipmentIds)
      .order("event_date", { ascending: false })
      .limit(600);

    if (eventsError) throw eventsError;

    for (const event of (eventRows ?? []) as ShipmentEventRow[]) {
      const current = eventsByShipment.get(event.shipment_id) ?? [];
      current.push(event);
      eventsByShipment.set(event.shipment_id, current);
    }
  }

  return shipments.map((row) => {
    const statusHistory = (eventsByShipment.get(row.id) ?? []).slice(0, 12).map((event) => ({
      oldStatus: event.old_status,
      newStatus: normalizeShipmentStatus(event.new_status, row.shipment_status),
      eventDate: event.event_date,
      newStatusLabel: toHumanDeliveryStatus(event.new_status),
    }));

    const currentStatus = normalizeShipmentStatus(row.delivery_status, row.shipment_status);
    const lastUpdateDate = row.delivery_status_updated_at ?? statusHistory[0]?.eventDate ?? row.updated_at;

    return {
    id: row.id,
    trackingNumber: row.tracking_number ?? "Pending",
    provider: normalizeProviderName(row.provider),
    shipmentStatus: currentStatus,
    shipmentStatusLabel: toHumanDeliveryStatus(currentStatus),
    labelLink: row.label_pdf_url ?? row.labels_url ?? row.label_url,
    createdDate: row.shipment_created_at,
    lastCourierUpdate: row.updated_at,
    lastUpdateDate,
    deliveryCompanyName: row.delivery_company_name ?? normalizeProviderName(row.provider),
    statusHistory,
    };
  });
}

export async function getShipmentLifecycleStats(merchantId: string): Promise<ShipmentLifecycleStats> {
  noStore();
  const supabase = createClient();

  const { data, error } = await supabase
    .from("merchant_shipments")
    .select("shipment_status, delivery_status")
    .eq("merchant_id", merchantId)
    .limit(2000);

  if (error) throw error;

  let deliveredParcels = 0;
  let refusedParcels = 0;
  let unreachableCustomers = 0;
  let returnedParcels = 0;
  let finalOutcomeTotal = 0;

  for (const row of data ?? []) {
    const status = normalizeShipmentStatus(
      (row as { delivery_status?: string | null }).delivery_status ?? null,
      (row as { shipment_status?: string | null }).shipment_status ?? null
    );

    if (status === "DELIVERED_SUCCESSFULLY") {
      deliveredParcels += 1;
      finalOutcomeTotal += 1;
      continue;
    }

    if (status === "CUSTOMER_REFUSED_PARCEL") {
      refusedParcels += 1;
      returnedParcels += 1;
      finalOutcomeTotal += 1;
      continue;
    }

    if (status === "CUSTOMER_UNREACHABLE") {
      unreachableCustomers += 1;
      finalOutcomeTotal += 1;
      continue;
    }

    if (status === "RETURNED_TO_SENDER" || status === "RETURN_RECEIVED_BY_MERCHANT") {
      returnedParcels += 1;
      finalOutcomeTotal += 1;
    }
  }

  return {
    deliveredParcels,
    refusedParcels,
    unreachableCustomers,
    returnRate: rate(returnedParcels, deliveredParcels + returnedParcels),
    deliverySuccessRate: rate(deliveredParcels, finalOutcomeTotal),
  };
}

export async function listNetworkMerchantView(merchantId: string): Promise<NetworkMerchantView[]> {
  noStore();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("customer_reputation")
    .select("id, trust_level, merchant_count, delivered_count, failed_count, returned_count")
    .eq("merchant_id", merchantId)
    .order("updated_at", { ascending: false })
    .limit(120);

  if (error) throw error;

  return ((data ?? []) as ReputationRow[]).map((row) => {
    const failedDeliveries = Number(row.failed_count ?? 0) + Number(row.returned_count ?? 0);
    return {
      id: row.id,
      trustLevel: normalizeTrustLevel(row.trust_level),
      seenByMerchants: Number(row.merchant_count ?? 0),
      successfulDeliveries: Number(row.delivered_count ?? 0),
      failedDeliveries,
      recommendation: recommendationFromTrustLevel(row.trust_level)
    };
  });
}

function mapNotificationEvent(eventType: string, message: string): MerchantNotificationView["event"] | null {
  const normalized = `${eventType} ${message}`.toLowerCase();
  if (normalized.includes("picked_up") || normalized.includes("picked up")) return "Parcel Picked Up";
  if (normalized.includes("out_for_delivery") || normalized.includes("out for delivery")) return "Out For Delivery";
  if (normalized.includes("unreachable")) return "Customer Unreachable";
  if (normalized.includes("return_received") || normalized.includes("return received")) return "Return Received";
  if (normalized.includes("delivered")) return "Shipment Delivered";
  if (normalized.includes("returned") || normalized.includes("refused")) return "Shipment Returned";
  if (normalized.includes("webhook") && normalized.includes("fail")) return "Webhook Failure";
  if (normalized.includes("credential") || normalized.includes("expiry") || normalized.includes("suspended") || normalized.includes("invalid")) {
    return "Credential Expiry";
  }
  if (normalized.includes("api")) return "API Error";
  if (normalized.includes("provider") || normalized.includes("sync") || normalized.includes("connection") || normalized.includes("attention_required")) {
    return "Provider Error";
  }
  return null;
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export async function listMerchantNotifications(merchantId: string): Promise<MerchantNotificationView[]> {
  noStore();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_notifications")
    .select("id, provider, level, event_type, title, notification_type, message, created_at, resolved_at, deleted_at")
    .eq("merchant_id", merchantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) throw error;

  return ((data ?? []) as NotificationRow[])
    .map((row) => {
      const event = mapNotificationEvent(row.event_type, row.message);
      const fallbackEvent = row.title
        ?? (row.notification_type ? toTitleCase(row.notification_type) : null)
        ?? toTitleCase(row.event_type || "notification");
      return {
        id: row.id,
        event: event ?? fallbackEvent,
        message: row.message,
        provider: row.provider,
        level: row.level,
        createdAt: row.created_at,
        resolved: Boolean(row.resolved_at)
      } as MerchantNotificationView;
    })
    .filter((row): row is MerchantNotificationView => Boolean(row));
}

export async function getInsightsData(merchantId: string): Promise<InsightsData> {
  noStore();
  const { checks, shipments } = await fetchChecksAndShipments(merchantId);

  const checkMap = new Map(checks.map((check) => [check.id, check]));

  const productMap = new Map<string, {
    revenueDzd: number;
    deliveredOrders: Set<string>;
    returnedOrders: Set<string>;
  }>();

  const customerMap = new Map<string, { deliveredOrders: number; returnedOrders: number; revenueDzd: number }>();
  const wilayaMap = new Map<string, { deliveredOrders: number; returnedOrders: number; revenueDzd: number }>();
  const providerMap = new Map<string, { deliveredOrders: number; returnedOrders: number; failedOrders: number; total: number }>();

  let deliveredOrders = 0;
  let returnedOrders = 0;
  let revenueDzd = 0;
  let shippingCount = 0;
  let productCostTotalDzd = 0;
  let hasProductCost = false;

  for (const shipment of shipments) {
    const check = checkMap.get(shipment.order_check_id);
    if (!check) continue;

    const status = normalizeShipmentStatus(shipment.delivery_status, shipment.shipment_status);
    const amount = safeOrderAmount(check);
    const provider = normalizeProviderName(shipment.provider);
    const providerStats = providerMap.get(provider) ?? { deliveredOrders: 0, returnedOrders: 0, failedOrders: 0, total: 0 };
    providerStats.total += 1;

    if (isDeliveredShipmentStatus(status)) {
      deliveredOrders += 1;
      revenueDzd += amount;
      providerStats.deliveredOrders += 1;
      shippingCount += 1;
    } else if (isReturnedShipmentStatus(status)) {
      returnedOrders += 1;
      providerStats.returnedOrders += 1;
      shippingCount += 1;
    } else if (isFailedShipmentStatus(status)) {
      providerStats.failedOrders += 1;
      shippingCount += 1;
    }

    providerMap.set(provider, providerStats);

    const customerKey = String(check.customer_phone ?? check.customer_name ?? "Unknown Customer").trim() || "Unknown Customer";
    const customerStats = customerMap.get(customerKey) ?? { deliveredOrders: 0, returnedOrders: 0, revenueDzd: 0 };
    if (isDeliveredShipmentStatus(status)) {
      customerStats.deliveredOrders += 1;
      customerStats.revenueDzd += amount;
    }
    if (isReturnedShipmentStatus(status) || isFailedShipmentStatus(status)) {
      customerStats.returnedOrders += 1;
    }
    customerMap.set(customerKey, customerStats);

    const wilayaKey = String(check.wilaya ?? "Unknown Wilaya").trim() || "Unknown Wilaya";
    const wilayaStats = wilayaMap.get(wilayaKey) ?? { deliveredOrders: 0, returnedOrders: 0, revenueDzd: 0 };
    if (isDeliveredShipmentStatus(status)) {
      wilayaStats.deliveredOrders += 1;
      wilayaStats.revenueDzd += amount;
    }
    if (isReturnedShipmentStatus(status) || isFailedShipmentStatus(status)) {
      wilayaStats.returnedOrders += 1;
    }
    wilayaMap.set(wilayaKey, wilayaStats);

    const productItems = parseProductItems(check.product_items);
    for (const item of productItems) {
      const productStats = productMap.get(item.productName) ?? {
        revenueDzd: 0,
        deliveredOrders: new Set<string>(),
        returnedOrders: new Set<string>()
      };

      if (isDeliveredShipmentStatus(status)) {
        productStats.revenueDzd += Number(item.itemTotal);
        productStats.deliveredOrders.add(check.id);

        if (item.productCost !== null) {
          hasProductCost = true;
          productCostTotalDzd += item.productCost * Math.max(item.quantity, 1);
        }
      }

      if (isReturnedShipmentStatus(status) || isFailedShipmentStatus(status)) {
        productStats.returnedOrders.add(check.id);
      }

      productMap.set(item.productName, productStats);
    }
  }

  const shippingCostTotalDzd = shippingCount * DEFAULT_SHIPPING_COST_DZD;
  const grossProfitDzd = revenueDzd - shippingCostTotalDzd;
  const netProfitDzd = hasProductCost ? grossProfitDzd - productCostTotalDzd : null;

  const topProducts: InsightsProduct[] = Array.from(productMap.entries())
    .map(([productName, stats]) => ({
      productName,
      revenueDzd: Number(stats.revenueDzd.toFixed(2)),
      deliveredOrders: stats.deliveredOrders.size,
      returnedOrders: stats.returnedOrders.size,
      returnRate: rate(stats.returnedOrders.size, stats.deliveredOrders.size + stats.returnedOrders.size)
    }))
    .sort((left, right) => right.revenueDzd - left.revenueDzd)
    .slice(0, 10);

  const bestCustomers: InsightsCustomer[] = Array.from(customerMap.entries())
    .map(([customer, stats]) => ({
      customer,
      deliveredOrders: stats.deliveredOrders,
      revenueDzd: Number(stats.revenueDzd.toFixed(2)),
      returnRate: rate(stats.returnedOrders, stats.deliveredOrders + stats.returnedOrders)
    }))
    .sort((left, right) => right.revenueDzd - left.revenueDzd)
    .slice(0, 10);

  const topWilayas: InsightsWilaya[] = Array.from(wilayaMap.entries())
    .map(([wilaya, stats]) => ({
      wilaya,
      deliveredOrders: stats.deliveredOrders,
      returnedOrders: stats.returnedOrders,
      revenueDzd: Number(stats.revenueDzd.toFixed(2)),
      returnRate: rate(stats.returnedOrders, stats.deliveredOrders + stats.returnedOrders)
    }))
    .sort((left, right) => right.revenueDzd - left.revenueDzd)
    .slice(0, 10);

  const courierPerformance: InsightsCourier[] = Array.from(providerMap.entries())
    .map(([provider, stats]) => ({
      provider,
      deliveredOrders: stats.deliveredOrders,
      returnedOrders: stats.returnedOrders,
      failedOrders: stats.failedOrders,
      deliveryRate: rate(stats.deliveredOrders, stats.total)
    }))
    .sort((left, right) => right.deliveredOrders - left.deliveredOrders);

  return {
    summary: {
      revenueDzd: Number(revenueDzd.toFixed(2)),
      deliveredOrders,
      returnedOrders,
      returnRate: rate(returnedOrders, deliveredOrders + returnedOrders),
      shippingCostPerOrderDzd: DEFAULT_SHIPPING_COST_DZD,
      shippingCostTotalDzd: Number(shippingCostTotalDzd.toFixed(2)),
      grossProfitDzd: Number(grossProfitDzd.toFixed(2)),
      productCostTotalDzd: hasProductCost ? Number(productCostTotalDzd.toFixed(2)) : null,
      netProfitDzd: netProfitDzd === null ? null : Number(netProfitDzd.toFixed(2))
    },
    topProducts,
    bestCustomers,
    topWilayas,
    courierPerformance
  };
}

export async function getSmartInventoryData(merchantId: string): Promise<SmartInventoryProduct[]> {
  noStore();
  const { checks, shipments } = await fetchChecksAndShipments(merchantId);
  const checkMap = new Map(checks.map((check) => [check.id, check]));

  const recentWindowStart = Date.now() - 14 * 24 * 60 * 60 * 1000;

  const productMap = new Map<string, {
    revenueDzd: number;
    deliveredOrders: Set<string>;
    returnedOrders: Set<string>;
    soldUnitsRecent14: number;
    stockQuantity: number | null;
  }>();

  for (const shipment of shipments) {
    const check = checkMap.get(shipment.order_check_id);
    if (!check) continue;

    const status = normalizeShipmentStatus(shipment.delivery_status, shipment.shipment_status);
    const checkCreated = new Date(check.created_at).getTime();
    const productItems = parseProductItems(check.product_items);

    for (const item of productItems) {
      const current = productMap.get(item.productName) ?? {
        revenueDzd: 0,
        deliveredOrders: new Set<string>(),
        returnedOrders: new Set<string>(),
        soldUnitsRecent14: 0,
        stockQuantity: null
      };

      if (isDeliveredShipmentStatus(status)) {
        current.revenueDzd += Number(item.itemTotal);
        current.deliveredOrders.add(check.id);
        if (checkCreated >= recentWindowStart) {
          current.soldUnitsRecent14 += Math.max(item.quantity, 0);
        }
      }

      if (isReturnedShipmentStatus(status) || isFailedShipmentStatus(status)) {
        current.returnedOrders.add(check.id);
      }

      if (item.stockQuantity !== null) {
        current.stockQuantity = current.stockQuantity === null ? item.stockQuantity : Math.min(current.stockQuantity, item.stockQuantity);
      }

      productMap.set(item.productName, current);
    }
  }

  return Array.from(productMap.entries())
    .map(([productName, stats]) => {
      const deliveredOrders = stats.deliveredOrders.size;
      const returnedOrders = stats.returnedOrders.size;
      const totalOrders = deliveredOrders + returnedOrders;
      const salesVelocityPerDay = Number((stats.soldUnitsRecent14 / 14).toFixed(2));
      const returnRate = rate(returnedOrders, totalOrders);

      let estimatedStockHealth: "Healthy" | "Low" | "Critical" = "Healthy";
      let message = "Sales trend is stable.";

      if (stats.stockQuantity !== null) {
        if (stats.stockQuantity <= 5) {
          estimatedStockHealth = "Critical";
          message = "Stock quantity is very low. Restock immediately.";
        } else if (stats.stockQuantity <= 15) {
          estimatedStockHealth = "Low";
          message = "Stock quantity is getting low. Plan restock soon.";
        } else {
          estimatedStockHealth = "Healthy";
          message = "Stock quantity is healthy.";
        }
      } else {
        if (salesVelocityPerDay >= 3) {
          estimatedStockHealth = "Critical";
          message = "Product selling unusually fast. Consider restocking soon.";
        } else if (salesVelocityPerDay >= 1.2 || returnRate >= 30) {
          estimatedStockHealth = "Low";
          message = "Inventory pressure rising from sales velocity and outcomes.";
        }
      }

      return {
        productName,
        revenueDzd: Number(stats.revenueDzd.toFixed(2)),
        deliveredOrders,
        returnedOrders,
        returnRate,
        salesVelocityPerDay,
        estimatedStockHealth,
        message,
        stockQuantity: stats.stockQuantity
      } satisfies SmartInventoryProduct;
    })
    .sort((left, right) => right.revenueDzd - left.revenueDzd)
    .slice(0, 30);
}
