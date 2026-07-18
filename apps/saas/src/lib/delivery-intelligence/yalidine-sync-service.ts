import { extractOutcomeContext, normalizeOutcomeReason } from "@/lib/delivery-intelligence/outcome";
import { normalizeDeliveryStatus } from "@/lib/delivery-intelligence/status";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import type { NormalizedDeliveryOrder, NormalizedDeliveryStatus, NormalizedOutcomeReason } from "@/lib/delivery-intelligence/types";

type JsonRecord = Record<string, unknown>;

function readPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);

  let cursor: unknown = value;
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

    cursor = (cursor as JsonRecord)[part];
  }

  return cursor;
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function firstString(record: JsonRecord, paths: string[]): string | null {
  for (const path of paths) {
    const candidate = coerceString(readPath(record, path));
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function firstNumber(record: JsonRecord, paths: string[]): number | null {
  for (const path of paths) {
    const value = readPath(record, path);
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeYalidineStatusToken(rawStatus: unknown): string {
  return toToken(String(rawStatus ?? "")).toUpperCase();
}

function parseIsoDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizePrimaryPhone(record: JsonRecord): { primaryPhone: string | null; phones: string[] } {
  const rawCandidates = [
    firstString(record, [
      "customer_phone",
      "phone",
      "mobile",
      "recipient_phone",
      "recipientPhone",
      "recipient.phone",
      "receiverPhone",
      "contact.phone",
      "to_mobile",
      "to_phone",
      "client_phone",
    ]),
    firstString(record, ["customer.phone", "receiver.phone", "recipient.mobile"]),
  ].filter((value): value is string => Boolean(value));

  const normalized = Array.from(new Set(rawCandidates
    .map((value) => normalizeAlgerianPhone(value) ?? value.trim())
    .filter((value) => value.length > 0)));

  return {
    primaryPhone: normalized[0] ?? null,
    phones: normalized,
  };
}

const YALIDINE_STATUS_TO_INTERNAL: Record<string, NormalizedDeliveryStatus> = {
  DELIVERED: "DELIVERED",
  LIVRE: "DELIVERED",
  LIVREE: "DELIVERED",
  LIVREE_AU_CLIENT: "DELIVERED",
  SUCCESS: "DELIVERED",
  COMPLETED: "DELIVERED",
  RETURNED: "RETURNED",
  RETOUR: "RETURNED",
  RETOURNE: "RETURNED",
  RETOURNE_AU_VENDEUR: "RETURNED",
  REFUSED: "REFUSED",
  REFUS: "REFUSED",
  REJECTED: "REFUSED",
  TENTATIVE_ECHOUEE: "REFUSED",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  ANNULE: "CANCELLED",
  ANNULER: "CANCELLED",
  PENDING: "PENDING",
  WAITING: "PENDING",
  NEW: "PENDING",
  CREATED: "PENDING",
  VERS_WILAYA: "PENDING",
  IN_TRANSIT: "IN_TRANSIT",
  TRANSIT: "IN_TRANSIT",
  EN_ROUTE: "IN_TRANSIT",
  ON_THE_WAY: "IN_TRANSIT",
};

function inferYalidineOutcomeFromSignals(params: {
  providerStatusRaw: string | null;
  providerSituationRaw: string | null;
  providerReasonRaw: string | null;
  normalizedStatus: NormalizedDeliveryStatus;
}): NormalizedOutcomeReason {
  const token = toToken([
    params.providerStatusRaw,
    params.providerSituationRaw,
    params.providerReasonRaw,
  ].filter(Boolean).join(" | "));

  if (/(tentative_echouee|tentative_echoue|echec_tentative)/.test(token)) {
    return "NO_ANSWER";
  }

  if (/(no_answer|sans_reponse|ne_repond|pas_de_reponse|does_not_answer|injoignable)/.test(token)) {
    return "NO_ANSWER";
  }

  if (/(refus|refuse|refused|rejected)/.test(token)) {
    return "REFUSED";
  }

  if (/(retour|returned|return_to_sender|echec_livraison)/.test(token)) {
    return "RETURNED";
  }

  if (/(annul|cancel|commande_annulee|commande_anulee)/.test(token)) {
    return "CLIENT_CANCELLED";
  }

  if (/(livr|delivered|success|completed)/.test(token)) {
    return "DELIVERED";
  }

  return normalizeOutcomeReason({
    normalizedStatus: params.normalizedStatus,
    providerStatusRaw: params.providerStatusRaw,
    providerSituationRaw: params.providerSituationRaw,
    providerReasonRaw: params.providerReasonRaw,
  });
}

function statusFromOutcome(outcome: NormalizedOutcomeReason, fallback: NormalizedDeliveryStatus): NormalizedDeliveryStatus {
  if (outcome === "DELIVERED") return "DELIVERED";
  if (outcome === "RETURNED") return "RETURNED";
  if (outcome === "REFUSED" || outcome === "NO_ANSWER") return "REFUSED";
  if (outcome === "CLIENT_CANCELLED") return "CANCELLED";
  return fallback;
}

export function normalizeYalidineStatus(rawStatus: unknown, customMap?: Record<string, NormalizedDeliveryStatus> | null): NormalizedDeliveryStatus {
  const base = normalizeYalidineStatusToken(rawStatus);
  if (base && YALIDINE_STATUS_TO_INTERNAL[base]) {
    return YALIDINE_STATUS_TO_INTERNAL[base];
  }

  return normalizeDeliveryStatus(base || rawStatus, customMap);
}

export function extractYalidineOrders(payload: JsonRecord, ordersPath?: string): JsonRecord[] {
  const candidates: unknown[] = [
    ordersPath ? readPath(payload, ordersPath) : undefined,
    readPath(payload, "data"),
    readPath(payload, "data.orders"),
    payload.orders,
    payload.results,
    payload.parcels,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object");
    }
  }

  return [];
}

export function parseYalidineNextCursor(payload: JsonRecord): string | null {
  const nextPage = readPath(payload, "pagination.nextPage")
    ?? readPath(payload, "pagination.next_page")
    ?? readPath(payload, "meta.next_page")
    ?? readPath(payload, "links.next")
    ?? null;

  if (nextPage === null || nextPage === undefined || nextPage === "") {
    return null;
  }

  return String(nextPage);
}

export function mapYalidineParcelToOrder(params: {
  parcel: JsonRecord;
  statusMapping?: Record<string, NormalizedDeliveryStatus> | null;
}): NormalizedDeliveryOrder | null {
  const { parcel } = params;
  const externalOrderId = firstString(parcel, ["id", "order_id", "reference", "tracking", "tracking_number", "parcel_id"]);
  if (!externalOrderId) {
    return null;
  }

  const phoneInfo = normalizePrimaryPhone(parcel);
  const rawStatus = firstString(parcel, ["last_status", "status", "state", "state.name", "status.name", "situation", "situation.name"]);
  const baseStatus = normalizeYalidineStatus(rawStatus, params.statusMapping);

  const outcomeFromContext = extractOutcomeContext({
    payload: parcel,
    normalizedStatus: baseStatus,
  });

  const normalizedOutcomeReason = inferYalidineOutcomeFromSignals({
    providerStatusRaw: outcomeFromContext.providerStatusRaw,
    providerSituationRaw: outcomeFromContext.providerSituationRaw,
    providerReasonRaw: outcomeFromContext.providerReasonRaw,
    normalizedStatus: baseStatus,
  });

  const normalizedStatus = statusFromOutcome(normalizedOutcomeReason, baseStatus);
  const createdAt = parseIsoDate(firstString(parcel, ["created_at", "createdAt", "created", "date_creation"]));
  const deliveredAt = parseIsoDate(firstString(parcel, ["delivered_at", "deliveredAt", "delivery_date", "date_livraison"]));
  const returnedAt = parseIsoDate(firstString(parcel, ["returned_at", "returnedAt", "return_date", "date_retour"]));
  const updatedAt = parseIsoDate(firstString(parcel, ["date_last_status", "updated_at", "updatedAt", "last_state_update_at", "date_update"]));

  return {
    external_order_id: externalOrderId,
    customer_external_id: firstString(parcel, ["customer_id", "customer.id", "client_id"]),
    tracking_number: firstString(parcel, ["tracking", "tracking_number", "trackingNumber"]),
    customer_name: firstString(parcel, ["customer_name", "name", "client_name", "recipient_name", "recipient.name", "to_name"]),
    customer_phone: phoneInfo.primaryPhone,
    customer_address: firstString(parcel, ["customer_address", "address", "recipient_address", "recipient.address", "to_address"]),
    wilaya: firstString(parcel, ["wilaya", "wilaya_name", "to_wilaya_name", "recipient.wilaya"]),
    commune: firstString(parcel, ["commune", "commune_name", "to_commune_name", "recipient.commune"]),
    order_amount: firstNumber(parcel, ["order_amount", "amount", "price", "total", "cod_amount"]),
    status: normalizedStatus,
    created_at: createdAt,
    delivered_at: deliveredAt,
    returned_at: returnedAt,
    last_state_update_at: updatedAt,
    provider_status_raw: outcomeFromContext.providerStatusRaw,
    provider_situation_raw: outcomeFromContext.providerSituationRaw,
    provider_reason_raw: outcomeFromContext.providerReasonRaw,
    normalized_outcome_reason: normalizedOutcomeReason,
    synced_at: new Date().toISOString(),
    items: [],
    raw_payload: {
      ...parcel,
      phone_numbers: phoneInfo.phones,
    },
  };
}