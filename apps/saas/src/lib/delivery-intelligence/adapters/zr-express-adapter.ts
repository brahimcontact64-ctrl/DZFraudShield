import type {
  DeliveryOrder,
  DeliveryProviderAdapter,
  DeliveryStatus,
  ShipmentCancelResult,
  ShipmentCreateInput,
  ShipmentCreateResult,
  ShipmentLabelResult,
  ShipmentTrackingResult,
  TestResult,
} from "@/lib/delivery-intelligence/adapters/provider-adapter";
import type { DeliverySyncResult, NormalizedDeliveryStatus, ProviderAuthConfig } from "@/lib/delivery-intelligence/types";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import { extractOutcomeContext } from "@/lib/delivery-intelligence/outcome";
import { resolveZrTerritories } from "@/lib/delivery-intelligence/zr-territory-resolver";

type JsonRecord = Record<string, unknown>;

const PAGE_SIZE = 100;

const ZR_STATUS_TO_INTERNAL_STATUS: Record<string, NormalizedDeliveryStatus> = {
  CREATED: "PENDING",
  NEW: "PENDING",
  PENDING: "PENDING",
  WAITING_PICKUP: "PENDING",
  WAITING_COLLECTION: "PENDING",
  AWAITING_PICKUP: "PENDING",
  CONFIRMED: "PENDING",
  READY: "PENDING",
  PICKED_UP: "IN_TRANSIT",
  COLLECTED: "IN_TRANSIT",
  IN_TRANSIT: "IN_TRANSIT",
  TRANSIT: "IN_TRANSIT",
  SHIPPED: "IN_TRANSIT",
  EN_ROUTE: "IN_TRANSIT",
  ON_THE_WAY: "IN_TRANSIT",
  OUT_FOR_DELIVERY: "IN_TRANSIT",
  DISTRIBUTION: "IN_TRANSIT",
  DISPATCHED: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  LIVRE: "DELIVERED",
  LIVREE: "DELIVERED",
  SUCCESS: "DELIVERED",
  COMPLETED: "DELIVERED",
  DONE: "DELIVERED",
  RECOUVERT: "DELIVERED",
  RETURNED: "RETURNED",
  RETOUR: "RETURNED",
  RETOURNE: "RETURNED",
  RETURNED_TO_SENDER: "RETURNED",
  ECHEC_LIVRAISON: "RETURNED",
  FAILED_DELIVERY: "RETURNED",
  REFUSED: "RETURNED",
  REFUS: "RETURNED",
  REJECTED: "RETURNED",
  REJECT: "RETURNED",
  RECUPERE_PAR_FOURNISSEUR: "RETURNED",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  ANNULE: "CANCELLED",
  ANNULER: "CANCELLED",
  VOID: "CANCELLED"
};

export const KNOWN_ZR_STATUSES = Object.freeze(Object.keys(ZR_STATUS_TO_INTERNAL_STATUS));

function resolveWriteEndpoint(config: ProviderAuthConfig, keys: string[], fallbackPath: string): URL {
  const optional = config.endpoints.optional ?? {};
  const candidate = keys
    .map((key) => optional[key])
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?? fallbackPath;
  return new URL(candidate, config.baseUrl);
}

function firstStringFromRecord(record: JsonRecord, paths: string[]): string | null {
  return firstString(record, paths);
}

type ZrCreateParcelPayload = {
  amount: number;
  customer: {
    customerId: string;
    name: string;
    phone: {
      number1: string;
    };
  };
  deliveryAddress: {
    cityTerritoryId: string;
    districtTerritoryId: string;
    street: string;
  };
  deliveryType: "home" | "pickup-point";
  description: string;
  orderedProducts: Array<{
    productName: string;
    unitPrice: number;
    quantity: number;
    stockType: "none" | "local" | "warehouse";
  }>;
  weight: {
    weight: number;
  };
  hubId?: string;
  externalId: string;
};

export class ZRCreateParcelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZRCreateParcelValidationError";
  }
}

function resolveApiEndpoint(config: ProviderAuthConfig, keys: string[], fallbackPath: string): URL {
  const optional = config.endpoints.optional ?? {};
  const candidate = keys
    .map((key) => optional[key])
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?? fallbackPath;
  return new URL(candidate, config.baseUrl);
}

function extractCollection(payload: JsonRecord): JsonRecord[] {
  const candidates = [
    payload.items,
    payload.data,
    readPath(payload, "data.items"),
    readPath(payload, "data.results"),
    payload.results,
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object");
    }
  }

  return [];
}

function extractCustomerIdFromResponse(payload: JsonRecord): string | null {
  return firstString(payload, ["id", "data.id", "customer.id", "customerId"]);
}

function ensureNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function preflightValidateCreateParcelPayload(payload: ZrCreateParcelPayload) {
  const checks: Array<{ ok: boolean; path: string }> = [
    { ok: Boolean(payload.customer?.customerId), path: "customer.customerId" },
    { ok: Boolean(payload.deliveryAddress?.cityTerritoryId), path: "deliveryAddress.cityTerritoryId" },
    { ok: Boolean(payload.deliveryAddress?.districtTerritoryId), path: "deliveryAddress.districtTerritoryId" },
    { ok: Boolean(payload.deliveryType), path: "deliveryType" },
    { ok: Boolean(payload.description), path: "description" },
    { ok: Array.isArray(payload.orderedProducts) && payload.orderedProducts.length > 0, path: "orderedProducts" },
    { ok: Number.isFinite(payload.amount), path: "amount" },
    { ok: Number.isFinite(payload.weight?.weight), path: "weight.weight" },
  ];

  const failed = checks.find((check) => !check.ok);
  if (failed) {
    throw new ZRCreateParcelValidationError(`ZRCreateParcelValidationError: Missing ${failed.path}`);
  }
}

function extractValidationDescriptions(payload: JsonRecord): string[] {
  const errors = payload.errors;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const description = (item as JsonRecord).description;
      return typeof description === "string" ? description.trim() : null;
    })
    .filter((value): value is string => Boolean(value));
}

function formatProviderError(payload: JsonRecord): string | null {
  const descriptions = extractValidationDescriptions(payload);
  if (descriptions.length > 0) {
    return descriptions.join(" | ");
  }

  const detail = firstString(payload, ["detail", "title", "message", "error"]);
  return detail;
}

function isHubIdRequiredValidation(payload: JsonRecord): boolean {
  const detail = formatProviderError(payload) ?? "";
  return /hubid\s+is\s+required/i.test(detail);
}

function extractHubId(payload: JsonRecord, target?: { cityTerritoryId?: string; districtTerritoryId?: string }): string | null {
  const collections = [
    payload.items,
    payload.data,
    readPath(payload, "data.items"),
    payload.results,
  ];

  const normalizedCity = String(target?.cityTerritoryId ?? "").trim();
  const normalizedDistrict = String(target?.districtTerritoryId ?? "").trim();

  const candidates: JsonRecord[] = [];
  for (const value of collections) {
    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }

      candidates.push(item as JsonRecord);
    }
  }

  if (normalizedCity || normalizedDistrict) {
    for (const item of candidates) {
      const cityTerritoryId = firstString(item, [
        "address.cityTerritoryId",
        "cityTerritoryId",
        "hubCityTerritoryId",
      ]);
      const districtTerritoryId = firstString(item, [
        "address.districtTerritoryId",
        "districtTerritoryId",
        "hubDistrictTerritoryId",
      ]);

      const cityMatches = normalizedCity && cityTerritoryId && normalizedCity === cityTerritoryId;
      const districtMatches = normalizedDistrict && districtTerritoryId && normalizedDistrict === districtTerritoryId;
      if (cityMatches || districtMatches) {
        const matchedHubId = firstString(item, ["id", "hubId"]);
        if (matchedHubId) {
          return matchedHubId;
        }
      }
    }
  }

  for (const item of candidates) {
      const hubId = firstString(item as JsonRecord, ["id", "hubId"]);
      if (hubId) {
        return hubId;
      }
  }

  return firstString(payload, ["id", "hubId", "data.id"]);
}

async function resolveDefaultHubId(params: {
  config: ProviderAuthConfig;
  headers: Record<string, string>;
  cityTerritoryId?: string;
  districtTerritoryId?: string;
}): Promise<string | null> {
  const endpoint = resolveApiEndpoint(
    params.config,
    ["searchHubs", "hubsSearch", "hubs"],
    "/api/v1/hubs/search"
  );

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({ pageNumber: 1, pageSize: 25 }),
    cache: "no-store",
  });

  const json = (await response.json().catch(() => ({}))) as JsonRecord;
  if (!response.ok) {
    return null;
  }

  return extractHubId(json, {
    cityTerritoryId: params.cityTerritoryId,
    districtTerritoryId: params.districtTerritoryId,
  });
}

async function resolveOrCreateCustomerId(params: {
  config: ProviderAuthConfig;
  headers: Record<string, string>;
  shipment: ShipmentCreateInput;
}): Promise<string> {
  const normalizedPhone = normalizeAlgerianPhone(params.shipment.customerPhone) ?? params.shipment.customerPhone;
  const searchEndpoint = resolveApiEndpoint(
    params.config,
    ["searchCustomers", "customersSearch", "customerSearch"],
    "/api/v1/customers/search"
  );

  const searchResponse = await fetch(searchEndpoint.toString(), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({ pageNumber: 1, pageSize: 50, keyword: normalizedPhone }),
    cache: "no-store",
  });

  const searchJson = (await searchResponse.json().catch(() => ({}))) as JsonRecord;
  if (searchResponse.ok) {
    const customers = extractCollection(searchJson);
    const matched = customers.find((customer) => {
      const id = firstString(customer, ["id", "customerId"]);
      const p1 = firstString(customer, ["phone.number1", "phone", "customer.phone.number1", "phoneNumber", "mobile"]);
      if (!id || !p1) return false;
      return (normalizeAlgerianPhone(p1) ?? p1) === normalizedPhone;
    });
    const matchedId = matched ? firstString(matched, ["id", "customerId"]) : null;
    if (matchedId) {
      return matchedId;
    }
  }

  const createEndpoint = resolveApiEndpoint(
    params.config,
    ["createCustomer", "createIndividualCustomer", "customerCreate"],
    "/api/v1/customers/individual"
  );
  const createResponse = await fetch(createEndpoint.toString(), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      name: params.shipment.customerName,
      phone: {
        number1: normalizedPhone,
      },
      // ZR API currently rejects pickup-point in this customer endpoint for our account setup.
      // Keep customer creation on home; stopdesk intent is still preserved in DZFS metadata.
      deliveryPreference: "home",
    }),
    cache: "no-store",
  });

  const createJson = (await createResponse.json().catch(() => ({}))) as JsonRecord;
  if (!createResponse.ok) {
    throw new Error(`ZR Express customer create failed (${createResponse.status})`);
  }

  const createdId = extractCustomerIdFromResponse(createJson);
  if (!createdId) {
    throw new Error("ZR Express customer create succeeded but did not return customer id");
  }

  return createdId;
}

function mapZrCreateParcelPayload(params: {
  shipment: ShipmentCreateInput;
  customerId: string;
  territory: {
    cityTerritoryId: string;
    districtTerritoryId: string;
  };
}): ZrCreateParcelPayload {
  const amount = ensureNumber(params.shipment.codAmount, 0);
  const productName = params.shipment.productSummary?.trim() || "Product";
  const weightCandidate = ensureNumber(params.shipment.shippingProfile?.default_weight, 1);
  const safeWeight = Math.max(1, weightCandidate);
  const normalizedDeliveryType = params.shipment.deliveryType === "pickup-point" ? "pickup-point" : "home";
  const orderedProducts = Array.isArray(params.shipment.orderedProducts) && params.shipment.orderedProducts.length > 0
    ? params.shipment.orderedProducts
      .map((item) => {
        const normalizedName = String(item.productName ?? "").trim();
        if (!normalizedName) {
          return null;
        }

        return {
          productName: normalizedName,
          unitPrice: ensureNumber(item.price, amount),
          quantity: Math.max(1, ensureNumber(item.quantity, 1)),
          stockType: item.stockType === "local" || item.stockType === "warehouse" ? item.stockType : "none",
        };
      })
      .filter((item): item is ZrCreateParcelPayload["orderedProducts"][number] => item !== null)
    : [];

  return {
    amount,
    customer: {
      customerId: params.customerId,
      name: params.shipment.customerName,
      phone: {
        number1: params.shipment.customerPhone,
      },
    },
    deliveryAddress: {
      cityTerritoryId: params.territory.cityTerritoryId,
      districtTerritoryId: params.territory.districtTerritoryId,
      street: params.shipment.customerAddress,
    },
    deliveryType: normalizedDeliveryType,
    description: params.shipment.description?.trim() || params.shipment.productSummary?.trim() || "Order",
    orderedProducts: orderedProducts.length > 0 ? orderedProducts : [{
      productName,
      unitPrice: amount,
      quantity: 1,
      stockType: "none",
    }],
    weight: {
      weight: safeWeight,
    },
    externalId: params.shipment.orderReference,
  };
}

function parseShipmentWriteResult(provider: string, payload: JsonRecord, fallbackId: string): ShipmentCreateResult {
  const record = (Array.isArray(payload.data) ? payload.data[0] : payload.data) as JsonRecord | undefined;
  const source = record ?? payload;
  const shipmentId = firstStringFromRecord(source, ["shipmentId", "shipment_id", "parcelId", "id", "reference"]) ?? fallbackId;
  const tracking = firstStringFromRecord(source, ["trackingNumber", "tracking_number", "tracking", "parcelTracking", "trackingNo"]);
  const labelUrl = firstStringFromRecord(source, ["label_url", "labelUrl", "label", "bordereauUrl", "bordereau_url"]);
  const labelsUrl = firstStringFromRecord(source, ["labels_url", "labelsUrl", "bordereaux_url", "bordereauxUrl"]) ?? labelUrl;
  const labelPdfUrl = firstStringFromRecord(source, ["label_pdf_url", "labelPdfUrl", "labelPdf", "bordereau_pdf_url", "bordereauPdfUrl"]) ?? labelUrl;

  return {
    shipmentId,
    trackingNumber: tracking,
    provider,
    labelUrl,
    labelsUrl,
    labelPdfUrl,
    importId: firstStringFromRecord(source, ["importId", "import_id"]),
    shipmentStatus: labelUrl || labelsUrl ? "LABEL_READY" : "CREATED",
    rawResponse: payload,
  };
}

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

function uniquePaths(paths: Array<string | undefined>): string[] {
  const normalized = paths
    .map((path) => (typeof path === "string" ? path.trim() : ""))
    .filter((path) => path.length > 0);

  return Array.from(new Set(normalized));
}

function firstString(record: JsonRecord, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
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

function parseIsoDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) {
    return null;
  }

  return asDate.toISOString();
}

export function normalizeZrExpressStatus(rawStatus: unknown): NormalizedDeliveryStatus {
  const value = String(rawStatus ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (!value) {
    return "PENDING";
  }

  return ZR_STATUS_TO_INTERNAL_STATUS[value] ?? "PENDING";
}

export function findUnmappedZrStatuses(statuses: readonly string[]): string[] {
  return Array.from(new Set(statuses
    .map((status) => status.trim().toUpperCase().replace(/\s+/g, "_"))
    .filter((status) => status.length > 0 && !(status in ZR_STATUS_TO_INTERNAL_STATUS))));
}

function extractPhoneCandidates(parcel: JsonRecord, phonePaths: string[] = []): string[] {
  const directPaths = uniquePaths([
    ...phonePaths,
    "customerPhone",
    "receiverPhone",
    "receiver.phone",
    "recipientPhone",
    "phone",
    "phoneNumber",
    "mobile"
  ]);

  const candidates: string[] = [];
  for (const path of directPaths) {
    const value = readPath(parcel, path);
    if (typeof value === "string" && value.trim()) {
      candidates.push(value.trim());
    }
  }

  const phoneList = readPath(parcel, "phones") ?? readPath(parcel, "customerPhones") ?? readPath(parcel, "receiver.phones");
  if (Array.isArray(phoneList)) {
    for (const entry of phoneList) {
      if (typeof entry === "string" && entry.trim()) {
        candidates.push(entry.trim());
      }
    }
  }

  return Array.from(new Set(candidates));
}

function normalizePrimaryPhone(parcel: JsonRecord, phonePaths: string[] = []): { primaryPhone: string | null; normalizedPhones: string[] } {
  const rawCandidates = extractPhoneCandidates(parcel, phonePaths);
  const normalized = Array.from(new Set(rawCandidates
    .map((value) => normalizeAlgerianPhone(value))
    .filter((value): value is string => Boolean(value))));

  return {
    primaryPhone: normalized[0] ?? null,
    normalizedPhones: normalized
  };
}

function extractParcels(payload: JsonRecord, ordersPath?: string): JsonRecord[] {
  const candidates = [
    ordersPath ? readPath(payload, ordersPath) : undefined,
    payload.parcels,
    payload.items,
    payload.results,
    readPath(payload, "data.parcels"),
    readPath(payload, "data.items"),
    readPath(payload, "data.results"),
    readPath(payload, "data")
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object");
    }
  }

  return [];
}

function extractHasNext(payload: JsonRecord): boolean {
  const candidates = [
    payload.hasNext,
    payload.has_next,
    readPath(payload, "meta.hasNext"),
    readPath(payload, "meta.has_next"),
    readPath(payload, "data.hasNext"),
    readPath(payload, "data.has_next")
  ];

  for (const value of candidates) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }

  return false;
}

function maxIso(current: string | null, value: string | null): string | null {
  if (!value) return current;
  if (!current) return value;
  return value > current ? value : current;
}

function buildDeliveryAddress(parcel: JsonRecord): string | null {
  const street = firstString(parcel, ["deliveryAddress.street"]);
  const district = firstString(parcel, ["deliveryAddress.district"]);
  const city = firstString(parcel, ["deliveryAddress.city"]);

  const parts = [street, district, city]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);

  if (parts.length > 0) {
    return parts.join(", ");
  }

  return firstString(parcel, ["deliveryAddress", "address", "receiverAddress", "receiver.address", "customerAddress"]);
}

function shouldKeepParcel(params: {
  createdAt: string | null;
  lastStateUpdateAt: string | null;
  sinceCreatedAt?: string;
  sinceStateUpdatedAt?: string;
}): boolean {
  if (!params.sinceCreatedAt && !params.sinceStateUpdatedAt) {
    return true;
  }

  const createdMatch = params.createdAt && params.sinceCreatedAt
    ? params.createdAt >= params.sinceCreatedAt
    : false;
  const stateMatch = params.lastStateUpdateAt && params.sinceStateUpdatedAt
    ? params.lastStateUpdateAt >= params.sinceStateUpdatedAt
    : false;

  if (params.sinceCreatedAt && !params.sinceStateUpdatedAt) {
    return createdMatch;
  }

  if (!params.sinceCreatedAt && params.sinceStateUpdatedAt) {
    return stateMatch;
  }

  return createdMatch || stateMatch;
}

async function buildHeaders(config: ProviderAuthConfig): Promise<Record<string, string>> {
  const apiKey = config.credentials.apiKey
    ?? config.credentials.secretKey
    ?? config.credentials.key
    ?? config.credentials.token;
  const tenantId = config.credentials.tenantId
    ?? config.credentials.tenant
    ?? config.credentials["X-Tenant"];
  const apiHeaderName = config.credentials.headerName
    ?? config.credentials.secretHeaderName
    ?? "X-Api-Key";
  const tenantHeaderName = config.credentials.tenantHeaderName
    ?? "X-Tenant";

  console.info("[ZRAdapter] credential resolution", {
    authType: config.authType,
    credentialsKeys: Object.keys(config.credentials),
    hasApiKey: Boolean(apiKey),
    hasTenantId: Boolean(tenantId),
    apiHeaderName,
    tenantHeaderName
  });

  if (!apiKey) {
    throw new Error("ZR Express API key is required");
  }
  if (!tenantId) {
    throw new Error("ZR Express tenant ID is required");
  }

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    [apiHeaderName]: apiKey,
    [tenantHeaderName]: tenantId,
    ...(config.customHeaders ?? {})
  };
}

function redactHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const lower = key.toLowerCase();
      if (lower.includes("key") || lower.includes("token") || lower.includes("secret") || lower === "authorization") {
        return [key, value ? "***redacted***" : value];
      }
      return [key, value];
    })
  );
}

class ZrExpressAdapter implements DeliveryProviderAdapter {
  public readonly provider = "zr_express";

  public async testConnection(params: {
    config: ProviderAuthConfig;
    since?: string;
  }): Promise<TestResult> {
    const result = await this.syncOrders({
      since: params.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      config: params.config,
    });

    return {
      ok: result.orders.length > 0,
      fetchedOrders: result.orders.length,
      nextCursor: result.nextCursor ?? null,
      latestCreatedAt: result.latestCreatedAt ?? null,
      latestStateUpdateAt: result.latestStateUpdateAt ?? null,
      error: result.orders.length > 0 ? undefined : "no_orders_returned",
    };
  }

  public mapOrder(raw: unknown): DeliveryOrder | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const parcel = raw as JsonRecord;
    const externalOrderId = firstString(parcel, ["parcelId", "id", "orderId", "externalOrderId", "reference"]);
    if (!externalOrderId) {
      return null;
    }

    const phoneInfo = normalizePrimaryPhone(parcel);
    const rawState = firstString(parcel, [
      "parcelState",
      "parcelState.name",
      "state",
      "state.name",
      "status",
      "status.name"
    ]);
    const normalizedStatus = this.normalizeStatus(rawState ?? "PENDING");
    const outcome = extractOutcomeContext({
      payload: parcel,
      normalizedStatus
    });
    const createdAt = parseIsoDate(firstString(parcel, ["createdAt", "creationDate", "created_at"]));
    const lastStateUpdateAt = parseIsoDate(firstString(parcel, ["lastStateUpdateAt", "updatedAt", "statusUpdatedAt", "updated_at"]));

    return {
      external_order_id: externalOrderId,
      customer_external_id: firstString(parcel, ["customerId", "customer.id", "receiver.id"]),
      tracking_number: firstString(parcel, ["trackingNumber", "tracking", "trackingNo"]),
      customer_name: firstString(parcel, ["customerName", "receiverName", "receiver.name", "recipientName", "customer.name"]),
      customer_phone: phoneInfo.primaryPhone,
      customer_address: buildDeliveryAddress(parcel),
      wilaya: firstString(parcel, ["wilaya", "province", "state", "deliveryAddress.city"]),
      commune: firstString(parcel, ["commune", "city", "district", "deliveryAddress.district"]),
      order_amount: firstNumber(parcel, ["amount", "codAmount", "totalAmount", "price"]),
      status: normalizedStatus,
      created_at: createdAt,
      delivered_at: parseIsoDate(firstString(parcel, ["deliveredAt", "deliveryDate", "delivered_at"])),
      returned_at: parseIsoDate(firstString(parcel, ["returnedAt", "returnDate", "returned_at"])),
      last_state_update_at: lastStateUpdateAt,
      provider_status_raw: outcome.providerStatusRaw,
      provider_situation_raw: outcome.providerSituationRaw,
      provider_reason_raw: outcome.providerReasonRaw,
      normalized_outcome_reason: outcome.normalizedOutcomeReason,
      synced_at: new Date().toISOString(),
      items: [],
      raw_payload: {
        ...parcel,
        phone_numbers: phoneInfo.normalizedPhones,
      },
    };
  }

  public normalizeStatus(rawStatus: string): DeliveryStatus {
    return normalizeZrExpressStatus(rawStatus);
  }

  public async syncOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<DeliverySyncResult> {
    const endpoint = new URL(params.config.endpoints.orders || "/api/v1/parcels/search", params.config.baseUrl);
    const headers = await buildHeaders(params.config);
    const fieldMapping = params.config.fieldMapping;

    const ordersPath = fieldMapping.ordersPath;
    const orderIdPaths = uniquePaths([fieldMapping.orderId, "parcelId", "id", "orderId", "externalOrderId", "reference"]);
    const customerIdPaths = uniquePaths([fieldMapping.customerId, "customerId", "customer.id", "receiver.id"]);
    const trackingPaths = uniquePaths([fieldMapping.trackingNumber, "trackingNumber", "tracking", "trackingNo"]);
    const customerNamePaths = uniquePaths([fieldMapping.customerName, "customerName", "receiverName", "receiver.name", "recipientName", "customer.name"]);
    const customerPhonePaths = uniquePaths([fieldMapping.customerPhone, "customerPhone", "receiverPhone", "receiver.phone", "recipientPhone", "phone", "phoneNumber", "mobile", "customer.phone.number1", "customer.phone.number2"]);
    const customerAddressPaths = uniquePaths([fieldMapping.customerAddress, "customerAddress", "receiverAddress", "receiver.address", "address", "deliveryAddress.street", "deliveryAddress.district", "deliveryAddress.city"]);
    const wilayaPaths = uniquePaths([fieldMapping.wilaya, "wilaya", "province", "state", "deliveryAddress.city"]);
    const communePaths = uniquePaths([fieldMapping.commune, "commune", "city", "district", "deliveryAddress.district"]);
    const amountPaths = uniquePaths([fieldMapping.amount, "amount", "codAmount", "totalAmount", "price"]);
    const statusPaths = uniquePaths([
      fieldMapping.status,
      "parcelState",
      "parcelState.name",
      "state",
      "state.name",
      "status",
      "status.name"
    ]);
    const createdAtPaths = uniquePaths([fieldMapping.createdAt, "createdAt", "creationDate", "created_at"]);
    const lastStateUpdateAtPaths = uniquePaths([fieldMapping.lastStateUpdateAt, "lastStateUpdateAt", "updatedAt", "statusUpdatedAt", "updated_at"]);
    const deliveredAtPaths = uniquePaths([fieldMapping.deliveredAt, "deliveredAt", "deliveryDate", "delivered_at"]);
    const returnedAtPaths = uniquePaths([fieldMapping.returnedAt, "returnedAt", "returnDate", "returned_at"]);

    let pageNumber = Number(params.cursor ?? "1");
    if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
      throw new Error("Invalid ZR Express cursor");
    }

    let hasNext = true;
    let totalFetched = 0;
    let totalFetchedBeforeFilter = 0;
    let pagesFetched = 0;
    let latestCreatedAt: string | null = null;
    let latestStateUpdateAt: string | null = null;
    const observedStatuses: string[] = [];
    const orders: DeliverySyncResult["orders"] = [];

    while (hasNext) {
      pagesFetched += 1;
      const requestBody = {
        pageNumber,
        pageSize: PAGE_SIZE
      };

      console.info("[DeliveryAudit][ZRAdapter] request", {
        endpoint: endpoint.toString(),
        method: "POST",
        headers: redactHeaders(headers),
        body: requestBody,
        pageNumber,
        pageSize: PAGE_SIZE,
        filters: {
          since: params.since,
          sinceCreatedAt: params.sinceCreatedAt ?? null,
          sinceStateUpdatedAt: params.sinceStateUpdatedAt ?? null,
        },
      });

      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        cache: "no-store"
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`ZR Express responded ${response.status}: ${body}`);
      }

      const payload = (await response.json()) as JsonRecord;
      const parcels = extractParcels(payload, ordersPath);
      totalFetchedBeforeFilter += parcels.length;

      console.info("[DeliveryAudit][ZRAdapter] response", {
        endpoint: endpoint.toString(),
        status: response.status,
        pageNumber,
        pageSize: PAGE_SIZE,
        parcelsReturnedByApi: parcels.length,
        hasNext: extractHasNext(payload),
      });

      const pageOrders = parcels
        .map((parcel) => {
          const externalOrderId = firstString(parcel, orderIdPaths);
          if (!externalOrderId) {
            return null;
          }

          const createdAt = parseIsoDate(firstString(parcel, createdAtPaths));
          const lastStateUpdateAt = parseIsoDate(firstString(parcel, lastStateUpdateAtPaths));
          const deliveredAt = parseIsoDate(firstString(parcel, deliveredAtPaths));
          const returnedAt = parseIsoDate(firstString(parcel, returnedAtPaths));
          const customerExternalId = firstString(parcel, customerIdPaths);

          latestCreatedAt = maxIso(latestCreatedAt, createdAt);
          latestStateUpdateAt = maxIso(latestStateUpdateAt, lastStateUpdateAt);

          if (!shouldKeepParcel({
            createdAt,
            lastStateUpdateAt,
            sinceCreatedAt: params.sinceCreatedAt,
            sinceStateUpdatedAt: params.sinceStateUpdatedAt
          })) {
            return null;
          }

          const phoneInfo = normalizePrimaryPhone(parcel, customerPhonePaths);
          const rawState = firstString(parcel, statusPaths);
          if (rawState) {
            observedStatuses.push(rawState);
          }

          const normalizedStatus = normalizeZrExpressStatus(rawState);
          const outcome = extractOutcomeContext({
            payload: parcel,
            normalizedStatus
          });

          return {
            external_order_id: externalOrderId,
            customer_external_id: customerExternalId,
            tracking_number: firstString(parcel, trackingPaths),
            customer_name: firstString(parcel, customerNamePaths),
            customer_phone: phoneInfo.primaryPhone,
            customer_address: buildDeliveryAddress(parcel) ?? firstString(parcel, customerAddressPaths),
            wilaya: firstString(parcel, wilayaPaths),
            commune: firstString(parcel, communePaths),
            order_amount: firstNumber(parcel, amountPaths),
            status: normalizedStatus,
            created_at: createdAt,
            delivered_at: deliveredAt,
            returned_at: returnedAt,
            last_state_update_at: lastStateUpdateAt,
            provider_status_raw: outcome.providerStatusRaw,
            provider_situation_raw: outcome.providerSituationRaw,
            provider_reason_raw: outcome.providerReasonRaw,
            normalized_outcome_reason: outcome.normalizedOutcomeReason,
            synced_at: new Date().toISOString(),
            items: [],
            raw_payload: {
              ...parcel,
              phone_numbers: phoneInfo.normalizedPhones
            }
          };
        })
        .filter((order): order is NonNullable<typeof order> => Boolean(order));

      totalFetched += pageOrders.length;
      console.info("[DeliveryAudit][ZRAdapter] post-filter", {
        pageNumber,
        keptAfterFilters: pageOrders.length,
        droppedByIncrementalFilters: Math.max(0, parcels.length - pageOrders.length),
        filters: {
          since: params.since,
          sinceCreatedAt: params.sinceCreatedAt ?? null,
          sinceStateUpdatedAt: params.sinceStateUpdatedAt ?? null,
        },
      });
      console.info(`Fetched page ${pageNumber} (${pageOrders.length} items)`);
      console.info(`Page ${pageNumber} cumulative total: ${totalFetched} items`);

      orders.push(...pageOrders);
      hasNext = extractHasNext(payload);
      if (hasNext) {
        pageNumber += 1;
      }
    }

    const unmappedStatuses = findUnmappedZrStatuses(observedStatuses);
    if (unmappedStatuses.length > 0) {
      console.warn(`ZR unmapped statuses detected: ${unmappedStatuses.join(", ")}`);
    }

    console.info(`Total fetched: ${totalFetched} items`);

    return {
      orders,
      nextCursor: null,
      latestCreatedAt,
      latestStateUpdateAt,
      metrics: {
        pagesFetched,
        totalFetched: totalFetchedBeforeFilter,
        totalKept: totalFetched,
        totalDropped: Math.max(0, totalFetchedBeforeFilter - totalFetched),
      }
    };
  }

  public async fetchLatestOrders(params: {
    since: string;
    sinceCreatedAt?: string;
    sinceStateUpdatedAt?: string;
    cursor?: string | null;
    config: ProviderAuthConfig;
  }): Promise<DeliverySyncResult> {
    return this.syncOrders(params);
  }

  public async createShipment(params: { config: ProviderAuthConfig; shipment: ShipmentCreateInput }): Promise<ShipmentCreateResult> {
    const endpoint = resolveWriteEndpoint(
      params.config,
      ["createShipment", "create_shipment", "parcelCreate", "create"],
      "/api/v1/parcels"
    );
    const headers = await buildHeaders(params.config);
    const territory = await resolveZrTerritories({
      provider: this.provider,
      config: params.config,
      wilaya: params.shipment.deliveryAddress?.city ?? params.shipment.customerWilaya,
      commune: params.shipment.deliveryAddress?.district ?? params.shipment.customerCommune,
      address: params.shipment.deliveryAddress?.street ?? params.shipment.customerAddress,
    });

    const customerId = await resolveOrCreateCustomerId({
      config: params.config,
      headers,
      shipment: params.shipment,
    });

    const body = mapZrCreateParcelPayload({
      shipment: params.shipment,
      customerId,
      territory: {
        cityTerritoryId: territory.cityTerritoryId,
        districtTerritoryId: territory.districtTerritoryId,
      },
    });

    preflightValidateCreateParcelPayload(body);

    let response = await fetch(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });

    let json = (await response.json().catch(() => ({}))) as JsonRecord;
    if (!response.ok && response.status === 400 && isHubIdRequiredValidation(json) && !body.hubId) {
      const fallbackHubId = await resolveDefaultHubId({
        config: params.config,
        headers,
        cityTerritoryId: body.deliveryAddress.cityTerritoryId,
        districtTerritoryId: body.deliveryAddress.districtTerritoryId,
      });

      if (fallbackHubId) {
        const retryBody: ZrCreateParcelPayload = {
          ...body,
          hubId: fallbackHubId,
        };

        response = await fetch(endpoint.toString(), {
          method: "POST",
          headers,
          body: JSON.stringify(retryBody),
          cache: "no-store",
        });
        json = (await response.json().catch(() => ({}))) as JsonRecord;
      }
    }

    if (!response.ok) {
      const providerError = formatProviderError(json);
      throw new Error(providerError
        ? `ZR Express createShipment failed (${response.status}): ${providerError}`
        : `ZR Express createShipment failed (${response.status})`);
    }

    return parseShipmentWriteResult(this.provider, json, params.shipment.orderReference);
  }

  public async getLabel(params: { config: ProviderAuthConfig; shipmentId?: string | null; trackingNumber?: string | null }): Promise<ShipmentLabelResult> {
    const tracked = await this.trackShipment(params);
    const trackingNumber = tracked.trackingNumber ?? params.trackingNumber ?? null;

    if (trackingNumber) {
      const endpoint = resolveWriteEndpoint(
        params.config,
        ["getLabel", "get_label", "label", "labels", "labelIndividual", "labelsIndividual"],
        "/api/v1/parcels/labels/individual"
      );
      const headers = await buildHeaders(params.config);
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ trackingNumbers: [trackingNumber] }),
        cache: "no-store",
      });

      const json = (await response.json().catch(() => ({}))) as JsonRecord;
      if (response.ok) {
        const labelUrl = firstStringFromRecord(json, [
          "parcelLabelFiles[0].fileUrl",
          "data.parcelLabelFiles[0].fileUrl",
          "label_url",
          "labelUrl",
          "label",
          "bordereauUrl",
          "bordereau_url",
        ]) ?? tracked.labelUrl ?? tracked.labelsUrl ?? null;

        const labelPdfUrl = firstStringFromRecord(json, [
          "parcelLabelFiles[0].fileUrl",
          "data.parcelLabelFiles[0].fileUrl",
          "label_pdf_url",
          "labelPdfUrl",
          "labelPdf",
          "bordereau_pdf_url",
          "bordereauPdfUrl",
        ]) ?? tracked.labelPdfUrl ?? labelUrl;

        return {
          labelUrl,
          labelPdfUrl,
          rawResponse: {
            trackingLookup: tracked.rawResponse,
            labelLookup: json,
          },
        };
      }
    }

    return {
      labelUrl: tracked.labelUrl ?? tracked.labelsUrl ?? null,
      labelPdfUrl: tracked.labelPdfUrl ?? tracked.labelUrl ?? tracked.labelsUrl ?? null,
      rawResponse: tracked.rawResponse,
    };
  }

  public async cancelShipment(params: { config: ProviderAuthConfig; shipmentId?: string | null; trackingNumber?: string | null }): Promise<ShipmentCancelResult> {
    const endpoint = resolveWriteEndpoint(
      params.config,
      ["cancelShipment", "cancel_shipment", "cancel"],
      "/api/v1/parcels/cancel"
    );
    const headers = await buildHeaders(params.config);
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        shipmentId: params.shipmentId ?? null,
        trackingNumber: params.trackingNumber ?? null,
      }),
      cache: "no-store",
    });

    const json = (await response.json().catch(() => ({}))) as JsonRecord;
    if (!response.ok) {
      throw new Error(`ZR Express cancelShipment failed (${response.status})`);
    }

    const cancelled = Boolean(json.cancelled ?? json.success ?? json.ok);
    return {
      cancelled,
      rawResponse: json,
    };
  }

  public async trackShipment(params: { config: ProviderAuthConfig; shipmentId?: string | null; trackingNumber?: string | null }): Promise<ShipmentTrackingResult> {
    const identifier = params.trackingNumber ?? params.shipmentId;
    if (!identifier) {
      throw new Error("ZR Express trackShipment requires tracking number or shipment id");
    }

    const byShipmentIdEndpoint = params.shipmentId
      ? resolveApiEndpoint(
          params.config,
          ["trackShipmentById", "track_shipment_by_id", "parcelById", "getParcel", "parcel"],
          `/api/v1/parcels/${encodeURIComponent(params.shipmentId)}`
        )
      : null;
    const fallbackEndpoint = resolveWriteEndpoint(
      params.config,
      ["trackShipment", "track_shipment", "shipmentTracking", "tracking"],
      params.config.endpoints.tracking || "/api/v1/parcels/tracking"
    );
    const headers = await buildHeaders(params.config);

    const response = byShipmentIdEndpoint
      ? await fetch(byShipmentIdEndpoint.toString(), {
          method: "GET",
          headers,
          cache: "no-store",
        })
      : await fetch(fallbackEndpoint.toString(), {
          method: "POST",
          headers,
          body: JSON.stringify({
            trackingNumber: params.trackingNumber ?? null,
            shipmentId: params.shipmentId ?? null,
          }),
          cache: "no-store",
        });

    const json = (await response.json().catch(() => ({}))) as JsonRecord;
    if (!response.ok) {
      throw new Error(`ZR Express trackShipment failed (${response.status})`);
    }

    const data = (Array.isArray(json.data) ? json.data[0] : json.data) as JsonRecord | undefined;
    const source = data ?? json;
    const rawStatus = firstStringFromRecord(source, ["parcelState.name", "state.name", "parcelState", "state", "status", "shipmentStatus"]) ?? "PENDING";
    const normalized = this.normalizeStatus(rawStatus);
    const labelUrl = firstStringFromRecord(source, ["label_url", "labelUrl", "label", "bordereauUrl", "bordereau_url", "parcelLabelFiles[0].fileUrl"]);
    const labelsUrl = firstStringFromRecord(source, ["labels_url", "labelsUrl", "bordereaux_url", "bordereauxUrl", "parcelLabelFiles[0].fileUrl"]) ?? labelUrl;
    const labelPdfUrl = firstStringFromRecord(source, ["label_pdf_url", "labelPdfUrl", "labelPdf", "bordereau_pdf_url", "bordereauPdfUrl", "parcelLabelFiles[0].fileUrl"]) ?? labelUrl;

    return {
      trackingNumber: firstStringFromRecord(source, ["trackingNumber", "tracking_number", "tracking", "trackingNo"]) ?? params.trackingNumber ?? null,
      shipmentStatus:
        normalized === "DELIVERED"
          ? "DELIVERED"
          : normalized === "IN_TRANSIT"
            ? "IN_TRANSIT"
            : normalized === "CANCELLED"
              ? "CANCELLED"
              : labelUrl || labelsUrl
                ? "LABEL_READY"
                : "PENDING",
      labelUrl,
      labelsUrl,
      labelPdfUrl,
      rawResponse: json,
    };
  }
}

export const zrExpressAdapter = new ZrExpressAdapter();
