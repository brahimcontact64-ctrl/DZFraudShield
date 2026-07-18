import { createClient } from "@/lib/supabase/server";
import type { MerchantDecisionValue } from "@/lib/merchant-decisions";
import type { MerchantShipmentStatus } from "@/lib/delivery-intelligence/shipment-service";

export type CallCenterQueue = "NEW" | "CALL_LATER" | "NO_ANSWER" | "CONFIRMED" | "REFUSED";

export type CallCenterCard = {
  id: string;
  createdAt: string;
  customerName: string;
  phone: string | null;
  wilaya: string | null;
  commune: string | null;
  address: string | null;
  orderAmount: number;
  riskScore: number;
  recommendedAction: string | null;
  queue: CallCenterQueue;
  localSuccessfulDeliveries: number;
  localFailedAttempts: number;
  localTotalOrders: number;
  localSuccessRate: number;
  lastMerchantOrderAt: string | null;
  returningCustomer: boolean;
  networkOrders: number;
  networkMerchantCount: number;
  networkDeliveredOrders: number;
  networkRefusedOrders: number;
  networkReturnedOrders: number;
  networkReturnRate: number;
  networkTrustLevel: string | null;
  networkLastActivityAt: string | null;
  lastCallEventAt: string | null;
  lastCallEventLabel: string | null;
  customerTimeline: Array<{
    status: "Delivered" | "Refused" | "Returned" | "Confirmed" | "Checked";
    date: string;
  }>;
  shipment: {
    provider: string;
    trackingNumber: string | null;
    labelUrl: string | null;
    labelsUrl: string | null;
    labelPdfUrl: string | null;
    shipmentStatus: MerchantShipmentStatus;
    shipmentError: string | null;
  } | null;
};

type OrderCheckRow = {
  id: string;
  created_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  phone_raw: string | null;
  wilaya: string | null;
  city: string | null;
  shipping_wilaya: string | null;
  shipping_commune: string | null;
  customer_address: string | null;
  address: string | null;
  risk_score: number | null;
  recommended_action: string | null;
  cart_total: number | null;
  total_amount: number | null;
  phone_hash: string | null;
};

function deriveCityFromAddress(address: string | null | undefined): string | null {
  const raw = String(address ?? "").trim();
  if (!raw) {
    return null;
  }

  const candidates = raw
    .split(/[;,|-]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^\d+$/.test(part));

  return candidates[0] ?? null;
}

type RiskEventRow = {
  order_check_id: string | null;
  event_type: string;
  created_at: string;
  payload: {
    intelligence?: {
      customerNetworkProfile?: {
        totalOrders?: number;
        merchantCount?: number;
        deliveredOrders?: number;
        refusedOrders?: number;
        returnedOrders?: number;
        networkTrustLevel?: string;
      };
    };
  } | null;
};

type MerchantDecisionRow = {
  order_check_id: string;
  decision: MerchantDecisionValue;
  created_at?: string | null;
};

type MerchantHistoryRow = {
  phone_hash: string;
  total_orders: number | null;
  delivered_count: number | null;
  failed_count: number | null;
  updated_at: string | null;
};

type ShipmentRow = {
  order_check_id: string;
  provider: string;
  tracking_number: string | null;
  label_url: string | null;
  labels_url: string | null;
  label_pdf_url: string | null;
  shipment_status: MerchantShipmentStatus;
  shipment_error: string | null;
  raw_response: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function readPath(input: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  let cursor: unknown = input;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }

    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

function firstString(input: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(input, path);
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractDeliveryTerritory(raw: Record<string, unknown> | null | undefined): {
  wilayaName: string | null;
  communeName: string | null;
} {
  if (!raw) {
    return { wilayaName: null, communeName: null };
  }

  return {
    wilayaName: firstString(raw, [
      "delivery_wilaya_name",
      "deliveryWilayaName",
      "receiver.delivery_wilaya_name",
      "receiver.deliveryWilayaName",
      "data.delivery_wilaya_name",
      "data.deliveryWilayaName",
      "payload.delivery_wilaya_name",
      "payload.deliveryWilayaName",
      "parcel.delivery_wilaya_name",
      "parcel.deliveryWilayaName",
      "parcel.receiver.wilaya",
      "parcel.receiver.wilayaName",
      "data.receiver.wilaya",
      "data.receiver.wilayaName",
    ]),
    communeName: firstString(raw, [
      "delivery_commune_name",
      "deliveryCommuneName",
      "receiver.delivery_commune_name",
      "receiver.deliveryCommuneName",
      "data.delivery_commune_name",
      "data.deliveryCommuneName",
      "payload.delivery_commune_name",
      "payload.deliveryCommuneName",
      "parcel.delivery_commune_name",
      "parcel.deliveryCommuneName",
      "parcel.receiver.commune",
      "parcel.receiver.district",
      "parcel.receiver.communeName",
      "data.receiver.commune",
      "data.receiver.district",
      "data.receiver.communeName",
    ]),
  };
}

type HistoricalCheckRow = {
  id: string;
  phone_hash: string;
  created_at: string;
};

const CALL_CENTER_EVENT_LABELS: Record<string, string> = {
  call_center_call_later: "Call later",
  call_center_no_answer: "No answer"
};

export function deriveCallCenterQueue(input: {
  decision?: MerchantDecisionValue | null;
  lastEventType?: string | null;
}): CallCenterQueue {
  if (input.decision === "ACCEPTED") return "CONFIRMED";
  if (input.decision === "BLOCKED") return "REFUSED";
  if (input.lastEventType === "call_center_no_answer") return "NO_ANSWER";
  if (input.lastEventType === "call_center_call_later") return "CALL_LATER";
  return "NEW";
}

export function buildWhatsAppUrl(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("213")) return `https://wa.me/${digits}`;
  if (digits.startsWith("0")) return `https://wa.me/213${digits.slice(1)}`;
  return `https://wa.me/${digits}`;
}

export async function listCallCenterCards(merchantId: string, limit = 60): Promise<CallCenterCard[]> {
  const supabase = createClient();

  const { data: checks, error: checksError } = await supabase
    .from("order_checks")
    .select("id, created_at, customer_name, customer_phone, phone_raw, wilaya, city, shipping_wilaya, shipping_commune, customer_address, address, risk_score, recommended_action, cart_total, total_amount, phone_hash")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (checksError) throw checksError;

  const rows = (checks ?? []) as OrderCheckRow[];
  if (rows.length === 0) {
    return [];
  }

  const checkIds = rows.map((row) => row.id);
  const phoneHashes = Array.from(new Set(rows.map((row) => row.phone_hash).filter((value): value is string => Boolean(value))));

  const [{ data: decisions }, { data: riskEvents }, { data: merchantHistory }, { data: shipmentRows }, { data: historicalChecks }] = await Promise.all([
    supabase
      .from("merchant_decisions")
      .select("order_check_id, decision, created_at")
      .eq("merchant_id", merchantId)
      .in("order_check_id", checkIds),
    supabase
      .from("risk_events")
      .select("order_check_id, event_type, created_at, payload")
      .eq("merchant_id", merchantId)
      .in("order_check_id", checkIds)
      .in("event_type", ["risk_check_created", "call_center_call_later", "call_center_no_answer"])
      .order("created_at", { ascending: false }),
    phoneHashes.length
      ? supabase
          .from("merchant_customer_reputation")
          .select("phone_hash, total_orders, delivered_count, failed_count, updated_at")
          .eq("merchant_id", merchantId)
          .in("phone_hash", phoneHashes)
      : Promise.resolve({ data: [] }),
    supabase
      .from("merchant_shipments")
      .select("order_check_id, provider, tracking_number, label_url, labels_url, label_pdf_url, shipment_status, shipment_error, raw_response, created_at, updated_at")
      .eq("merchant_id", merchantId)
      .in("order_check_id", checkIds),
    phoneHashes.length
      ? supabase
          .from("order_checks")
          .select("id, phone_hash, created_at")
          .eq("merchant_id", merchantId)
          .in("phone_hash", phoneHashes)
          .order("created_at", { ascending: false })
        .limit(Math.max(limit * 6, 120))
      : Promise.resolve({ data: [] })
  ]);

  const historicalRows = (historicalChecks ?? []) as HistoricalCheckRow[];
  const historicalCheckIds = historicalRows.map((row) => row.id);

  const [historicalDecisionsResult, historicalShipmentsResult] = historicalCheckIds.length
    ? await Promise.all([
        supabase
          .from("merchant_decisions")
          .select("order_check_id, decision, created_at")
          .eq("merchant_id", merchantId)
          .in("order_check_id", historicalCheckIds),
        supabase
          .from("merchant_shipments")
          .select("order_check_id, shipment_status, created_at, updated_at")
          .eq("merchant_id", merchantId)
          .in("order_check_id", historicalCheckIds)
      ])
    : [{ data: [] }, { data: [] }];

  const decisionMap = new Map<string, MerchantDecisionRow>();
  for (const row of (decisions ?? []) as MerchantDecisionRow[]) {
    decisionMap.set(row.order_check_id, row);
  }

  const latestCallEvent = new Map<string, RiskEventRow>();
  const riskCheckEvent = new Map<string, RiskEventRow>();
  for (const row of (riskEvents ?? []) as RiskEventRow[]) {
    if (!row.order_check_id) continue;
    if (row.event_type === "risk_check_created" && !riskCheckEvent.has(row.order_check_id)) {
      riskCheckEvent.set(row.order_check_id, row);
    }
    if ((row.event_type === "call_center_call_later" || row.event_type === "call_center_no_answer") && !latestCallEvent.has(row.order_check_id)) {
      latestCallEvent.set(row.order_check_id, row);
    }
  }

  const merchantHistoryMap = new Map<string, MerchantHistoryRow>();
  for (const row of (merchantHistory ?? []) as MerchantHistoryRow[]) {
    merchantHistoryMap.set(row.phone_hash, row);
  }

  const shipmentMap = new Map<string, ShipmentRow>();
  for (const row of (shipmentRows ?? []) as ShipmentRow[]) {
    shipmentMap.set(row.order_check_id, row);
  }

  const timelineDecisionMap = new Map<string, MerchantDecisionRow>();
  for (const row of (historicalDecisionsResult.data ?? []) as MerchantDecisionRow[]) {
    timelineDecisionMap.set(row.order_check_id, row);
  }

  const timelineShipmentMap = new Map<string, { shipment_status: string | null; created_at: string | null; updated_at: string | null }>();
  for (const row of (historicalShipmentsResult.data ?? []) as Array<{ order_check_id: string; shipment_status: string | null; created_at: string | null; updated_at: string | null }>) {
    if (!timelineShipmentMap.has(row.order_check_id)) {
      timelineShipmentMap.set(row.order_check_id, row);
    }
  }

  const checksByPhoneHash = new Map<string, HistoricalCheckRow[]>();
  for (const row of historicalRows) {
    const bucket = checksByPhoneHash.get(row.phone_hash) ?? [];
    bucket.push(row);
    checksByPhoneHash.set(row.phone_hash, bucket);
  }

  return rows.map((row) => {
    const decision = decisionMap.get(row.id)?.decision ?? null;
    const lastEvent = latestCallEvent.get(row.id) ?? null;
    const profile = riskCheckEvent.get(row.id)?.payload?.intelligence?.customerNetworkProfile;
    const history = row.phone_hash ? merchantHistoryMap.get(row.phone_hash) : null;
    const shipment = shipmentMap.get(row.id) ?? null;
    const territoryFromShipment = extractDeliveryTerritory(shipment?.raw_response);
    const localTotalOrders = Number(history?.total_orders ?? 0);
    const localSuccessfulDeliveries = Number(history?.delivered_count ?? 0);
    const localFailedAttempts = Number(history?.failed_count ?? 0);
    const localSuccessRate = localTotalOrders > 0 ? Math.round((localSuccessfulDeliveries / localTotalOrders) * 100) : 0;
    const networkDeliveredOrders = Number(profile?.deliveredOrders ?? 0);
    const networkRefusedOrders = Number(profile?.refusedOrders ?? 0);
    const networkReturnedOrders = Number(profile?.returnedOrders ?? 0);
    const networkTotalOutcomes = networkDeliveredOrders + networkRefusedOrders + networkReturnedOrders;
    const networkReturnRate = networkTotalOutcomes > 0
      ? Math.round(((networkRefusedOrders + networkReturnedOrders) / networkTotalOutcomes) * 100)
      : 0;

    const customerTimeline = row.phone_hash
      ? (checksByPhoneHash.get(row.phone_hash) ?? [])
          .slice(0, 12)
          .map((historicalCheck) => {
            const historicalShipment = timelineShipmentMap.get(historicalCheck.id);
            const historicalDecision = timelineDecisionMap.get(historicalCheck.id)?.decision ?? null;

            let status: "Delivered" | "Refused" | "Returned" | "Confirmed" | "Checked" = "Checked";
            if (historicalShipment?.shipment_status === "DELIVERED") {
              status = "Delivered";
            } else if (historicalShipment?.shipment_status === "RETURNED" || historicalShipment?.shipment_status === "FAILED" || historicalShipment?.shipment_status === "CANCELLED") {
              status = "Returned";
            } else if (historicalDecision === "BLOCKED") {
              status = "Refused";
            } else if (historicalDecision === "ACCEPTED") {
              status = "Confirmed";
            }

            return {
              status,
              date: historicalShipment?.updated_at ?? historicalShipment?.created_at ?? historicalCheck.created_at
            };
          })
          .slice(0, 4)
      : [];

    return {
      id: row.id,
      createdAt: row.created_at,
      customerName: row.customer_name ?? "Unknown Customer",
      phone: row.customer_phone ?? row.phone_raw ?? null,
      wilaya: territoryFromShipment.wilayaName ?? row.shipping_wilaya ?? row.wilaya ?? null,
      commune: territoryFromShipment.communeName ?? row.shipping_commune ?? row.city ?? deriveCityFromAddress(row.customer_address ?? row.address),
      address: row.customer_address ?? row.address ?? null,
      orderAmount: Number(row.total_amount ?? row.cart_total ?? 0),
      riskScore: Number(row.risk_score ?? 0),
      recommendedAction: row.recommended_action ?? null,
      queue: deriveCallCenterQueue({ decision, lastEventType: lastEvent?.event_type ?? null }),
      localSuccessfulDeliveries,
      localFailedAttempts,
      localTotalOrders,
      localSuccessRate,
      lastMerchantOrderAt: history?.updated_at ?? null,
      returningCustomer: localTotalOrders > 0 || localSuccessfulDeliveries > 0 || localFailedAttempts > 0,
      networkOrders: Number(profile?.totalOrders ?? 0),
      networkMerchantCount: Number(profile?.merchantCount ?? 0),
      networkDeliveredOrders,
      networkRefusedOrders,
      networkReturnedOrders,
      networkReturnRate,
      networkTrustLevel: profile?.networkTrustLevel ?? null,
      networkLastActivityAt: riskCheckEvent.get(row.id)?.created_at ?? null,
      lastCallEventAt: lastEvent?.created_at ?? null,
      lastCallEventLabel: lastEvent ? CALL_CENTER_EVENT_LABELS[lastEvent.event_type] ?? lastEvent.event_type : null,
      customerTimeline,
      shipment: shipment ? {
        provider: shipment.provider,
        trackingNumber: shipment.tracking_number,
        labelUrl: shipment.label_url,
        labelsUrl: shipment.labels_url,
        labelPdfUrl: shipment.label_pdf_url,
        shipmentStatus: shipment.shipment_status,
        shipmentError: shipment.shipment_error,
      } : null,
    } satisfies CallCenterCard;
  });
}
