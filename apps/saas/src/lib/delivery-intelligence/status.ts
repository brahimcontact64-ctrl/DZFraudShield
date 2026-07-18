import type { NormalizedDeliveryStatus } from "@/lib/delivery-intelligence/types";

const DEFAULT_MAP: Record<string, NormalizedDeliveryStatus> = {
  CONFIRMED: "CONFIRMED",
  CONFIRM: "CONFIRMED",
  CONFIRMEE: "CONFIRMED",
  CONFIRMÉ: "CONFIRMED",
  DELIVERED: "DELIVERED",
  LIVRE: "DELIVERED",
  LIVREE: "DELIVERED",
  LIVRÉE: "DELIVERED",
  DELIVER: "DELIVERED",
  SUCCESS: "DELIVERED",
  RETURNED: "RETURNED",
  RETOUR: "RETURNED",
  RETOURNE: "RETURNED",
  RETOURNÉ: "RETURNED",
  FAILED_DELIVERY: "RETURNED",
  REFUSED: "REFUSED",
  REFUS: "REFUSED",
  REJECTED: "REFUSED",
  REJECT: "REFUSED",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  ANNULE: "CANCELLED",
  ANNULÉ: "CANCELLED",
  IN_TRANSIT: "IN_TRANSIT",
  TRANSIT: "IN_TRANSIT",
  SHIPPED: "IN_TRANSIT",
  EN_ROUTE: "IN_TRANSIT",
  ON_THE_WAY: "IN_TRANSIT",
  PENDING: "PENDING",
  WAITING: "PENDING",
  CREATED: "PENDING",
  NEW: "PENDING"
};

export function normalizeDeliveryStatus(
  rawStatus: unknown,
  customMap?: Record<string, NormalizedDeliveryStatus> | null
): NormalizedDeliveryStatus {
  const value = String(rawStatus ?? "").trim();
  if (!value) {
    return "PENDING";
  }

  const normalized = value.toUpperCase();
  const merged = {
    ...DEFAULT_MAP,
    ...(customMap ?? {})
  };

  return merged[normalized] ?? "PENDING";
}
