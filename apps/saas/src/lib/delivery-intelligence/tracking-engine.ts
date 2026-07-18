import { createClient } from "@/lib/supabase/server";
import type { MerchantShipmentStatus } from "@/lib/delivery-intelligence/shipment-service";
import type { NormalizedDeliveryOrder } from "@/lib/delivery-intelligence/types";

export const DELIVERY_LIFECYCLE_STATUSES = [
  "SHIPMENT_CREATED",
  "AWAITING_PICKUP",
  "PICKED_UP",
  "IN_SORTING_CENTER",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION_CITY",
  "OUT_FOR_DELIVERY",
  "DELIVERED_SUCCESSFULLY",
  "CUSTOMER_REFUSED_PARCEL",
  "CUSTOMER_UNREACHABLE",
  "DELIVERY_FAILED",
  "RETURNED_TO_SENDER",
  "RETURN_RECEIVED_BY_MERCHANT",
] as const;

export type DeliveryLifecycleStatus = (typeof DELIVERY_LIFECYCLE_STATUSES)[number];

const NOTIFIABLE_STATUSES = new Set<DeliveryLifecycleStatus>([
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED_SUCCESSFULLY",
  "CUSTOMER_REFUSED_PARCEL",
  "CUSTOMER_UNREACHABLE",
  "RETURNED_TO_SENDER",
  "RETURN_RECEIVED_BY_MERCHANT",
]);

type MerchantShipmentTrackingRow = {
  id: string;
  tracking_number: string | null;
  shipment_id: string | null;
  shipment_status: MerchantShipmentStatus;
  delivery_status: string | null;
  delivery_status_updated_at: string | null;
};

function normalizeStatusText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

function hasAnyToken(haystack: string, tokens: string[]): boolean {
  return tokens.some((token) => haystack.includes(token));
}

export function toHumanDeliveryStatus(status: string | null | undefined): string {
  return String(status ?? "")
    .trim()
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function mapLegacyShipmentStatus(status: MerchantShipmentStatus): DeliveryLifecycleStatus {
  if (status === "DELIVERED") return "DELIVERED_SUCCESSFULLY";
  if (status === "IN_TRANSIT") return "IN_TRANSIT";
  if (status === "FAILED") return "DELIVERY_FAILED";
  if (status === "CANCELLED") return "DELIVERY_FAILED";
  if (status === "PENDING") return "AWAITING_PICKUP";
  return "SHIPMENT_CREATED";
}

export function mapProviderStatusToLifecycle(params: {
  normalizedStatus: NormalizedDeliveryOrder["status"];
  providerStatusRaw?: string | null;
  providerSituationRaw?: string | null;
  providerReasonRaw?: string | null;
  trackingNumber?: string | null;
}): DeliveryLifecycleStatus {
  const rawStack = [
    params.providerStatusRaw,
    params.providerSituationRaw,
    params.providerReasonRaw,
    params.normalizedStatus,
  ]
    .map((value) => normalizeStatusText(value))
    .filter(Boolean)
    .join("_");

  if (
    hasAnyToken(rawStack, [
      "RETURN_RECEIVED",
      "RETURN_RECEIVE",
      "RECUPERE_PAR_FOURNISSEUR",
      "RETOUR_RECU",
      "RECEIVED_BY_MERCHANT",
      "RETURN_COMPLETED",
    ])
  ) {
    return "RETURN_RECEIVED_BY_MERCHANT";
  }

  if (hasAnyToken(rawStack, ["REFUSED", "REFUS", "REJECTED", "REJECT"])) {
    return "CUSTOMER_REFUSED_PARCEL";
  }

  if (
    hasAnyToken(rawStack, [
      "UNREACHABLE",
      "PHONE_UNREACHABLE",
      "NO_ANSWER",
      "NOT_ANSWERING",
      "NO_RESPONSE",
      "INJOIGNABLE",
      "UNCONTACTABLE",
    ])
  ) {
    return "CUSTOMER_UNREACHABLE";
  }

  if (
    hasAnyToken(rawStack, [
      "DELIVERED",
      "LIVRE",
      "LIVREE",
      "COMPLETED",
      "DONE",
      "SUCCESS",
      "RECOUVERT",
    ])
  ) {
    return "DELIVERED_SUCCESSFULLY";
  }

  if (hasAnyToken(rawStack, ["RETURNED", "RETOUR", "RETURN_TO_SENDER", "RTS"])) {
    return "RETURNED_TO_SENDER";
  }

  if (hasAnyToken(rawStack, ["FAILED", "ECHEC", "FAIL", "UNDELIVERABLE"])) {
    return "DELIVERY_FAILED";
  }

  if (
    hasAnyToken(rawStack, [
      "OUT_FOR_DELIVERY",
      "EN_LIVRAISON",
      "COURIER_DELIVERY",
      "DISTRIBUTION",
      "LAST_MILE",
    ])
  ) {
    return "OUT_FOR_DELIVERY";
  }

  if (
    hasAnyToken(rawStack, [
      "ARRIVED_AT_DESTINATION",
      "DESTINATION_CITY",
      "ARRIVED_DESTINATION",
      "ARRIVAL_DESTINATION",
      "DESTINATION_HUB",
    ])
  ) {
    return "ARRIVED_AT_DESTINATION_CITY";
  }

  if (hasAnyToken(rawStack, ["SORTING", "TRI", "SORT_CENTER", "HUB_PROCESSING"])) {
    return "IN_SORTING_CENTER";
  }

  if (hasAnyToken(rawStack, ["IN_TRANSIT", "TRANSIT", "EN_ROUTE", "ON_THE_WAY", "SHIPPED"])) {
    return "IN_TRANSIT";
  }

  if (hasAnyToken(rawStack, ["PICKED_UP", "COLLECTED", "RAMASSE", "PICKUP_DONE"])) {
    return "PICKED_UP";
  }

  if (hasAnyToken(rawStack, ["AWAITING_PICKUP", "WAITING_PICKUP", "WAITING_COLLECTION", "READY_FOR_PICKUP"])) {
    return "AWAITING_PICKUP";
  }

  if (params.trackingNumber) {
    return "SHIPMENT_CREATED";
  }

  return "AWAITING_PICKUP";
}

function buildNotificationTemplate(status: DeliveryLifecycleStatus) {
  if (status === "PICKED_UP") {
    return {
      title: "Parcel picked up",
      message: "The courier has picked up your parcel.",
      type: "delivery_parcel_picked_up",
    };
  }

  if (status === "OUT_FOR_DELIVERY") {
    return {
      title: "Parcel out for delivery",
      message: "Your parcel is out for delivery.",
      type: "delivery_out_for_delivery",
    };
  }

  if (status === "DELIVERED_SUCCESSFULLY") {
    return {
      title: "Parcel delivered",
      message: "Your parcel was delivered successfully.",
      type: "delivery_delivered",
    };
  }

  if (status === "CUSTOMER_REFUSED_PARCEL") {
    return {
      title: "Customer refused parcel",
      message: "The customer refused this parcel.",
      type: "delivery_customer_refused",
    };
  }

  if (status === "CUSTOMER_UNREACHABLE") {
    return {
      title: "Customer unreachable",
      message: "Delivery failed because the customer could not be reached.",
      type: "delivery_customer_unreachable",
    };
  }

  if (status === "RETURN_RECEIVED_BY_MERCHANT") {
    return {
      title: "Return received",
      message: "The returned parcel has been received by your store.",
      type: "delivery_return_received",
    };
  }

  return {
    title: "Parcel returned",
    message: "This parcel has been returned to sender.",
    type: "delivery_returned",
  };
}

async function findShipmentForOrder(params: {
  merchantId: string;
  provider: string;
  order: NormalizedDeliveryOrder;
}): Promise<MerchantShipmentTrackingRow | null> {
  const supabase = createClient();

  if (params.order.tracking_number) {
    const byTracking = await supabase
      .from("merchant_shipments")
      .select("id, tracking_number, shipment_id, shipment_status, delivery_status, delivery_status_updated_at")
      .eq("merchant_id", params.merchantId)
      .eq("provider", params.provider)
      .eq("tracking_number", params.order.tracking_number)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!byTracking.error && byTracking.data) {
      return byTracking.data as MerchantShipmentTrackingRow;
    }
  }

  const byShipmentId = await supabase
    .from("merchant_shipments")
    .select("id, tracking_number, shipment_id, shipment_status, delivery_status, delivery_status_updated_at")
    .eq("merchant_id", params.merchantId)
    .eq("provider", params.provider)
    .eq("shipment_id", params.order.external_order_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byShipmentId.error) {
    return null;
  }

  return (byShipmentId.data as MerchantShipmentTrackingRow | null) ?? null;
}

export async function syncShipmentLifecycleFromOrder(params: {
  merchantId: string;
  provider: string;
  order: NormalizedDeliveryOrder;
}) {
  const shipment = await findShipmentForOrder(params);
  if (!shipment?.id) {
    return;
  }

  const newStatus = mapProviderStatusToLifecycle({
    normalizedStatus: params.order.status,
    providerStatusRaw: params.order.provider_status_raw,
    providerSituationRaw: params.order.provider_situation_raw,
    providerReasonRaw: params.order.provider_reason_raw,
    trackingNumber: params.order.tracking_number,
  });

  const oldStatus = (shipment.delivery_status as DeliveryLifecycleStatus | null) ?? mapLegacyShipmentStatus(shipment.shipment_status);
  const eventDate = params.order.last_state_update_at ?? params.order.synced_at ?? new Date().toISOString();

  const supabase = createClient();

  const { error: updateError } = await supabase
    .from("merchant_shipments")
    .update({
      delivery_status: newStatus,
      delivery_status_updated_at: eventDate,
      delivery_company_name: params.provider,
      updated_at: new Date().toISOString(),
    })
    .eq("id", shipment.id);

  if (updateError) {
    throw updateError;
  }

  if (oldStatus === newStatus) {
    return;
  }

  const { error: eventError } = await supabase.from("shipment_events").insert({
    shipment_id: shipment.id,
    provider: params.provider,
    old_status: oldStatus,
    new_status: newStatus,
    event_date: eventDate,
    raw_payload: {
      trackingNumber: params.order.tracking_number,
      normalizedStatus: params.order.status,
      providerStatusRaw: params.order.provider_status_raw,
      providerSituationRaw: params.order.provider_situation_raw,
      providerReasonRaw: params.order.provider_reason_raw,
      payload: params.order.raw_payload,
    },
  });

  if (eventError) {
    throw eventError;
  }

  if (!NOTIFIABLE_STATUSES.has(newStatus)) {
    return;
  }

  const template = buildNotificationTemplate(newStatus);

  await supabase.from("merchant_notifications").insert({
    merchant_id: params.merchantId,
    provider: params.provider,
    level: newStatus === "DELIVERED_SUCCESSFULLY" ? "info" : "warning",
    event_type: template.type,
    title: template.title,
    notification_type: "shipment_update",
    message: `${template.message} Tracking: ${params.order.tracking_number ?? "N/A"}`,
    metadata: {
      shipment_id: shipment.id,
      old_status: oldStatus,
      new_status: newStatus,
      tracking_number: params.order.tracking_number,
      event_date: eventDate,
    },
  });
}
