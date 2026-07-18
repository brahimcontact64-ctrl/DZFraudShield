import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { ProviderRegistry } from "@/lib/delivery-intelligence/adapters";
import { getMerchantDecisionByOrderCheck } from "@/lib/merchant-decisions";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import { hashWithSecret } from "@/lib/security/hash";
import { getMerchantShippingProfile, type MerchantShippingProfile } from "@/lib/delivery-intelligence/shipping-profile";
import {
  getShippingOriginById,
  listShippingOrigins,
  type ShippingOriginRecord,
} from "@/lib/delivery-intelligence/shipping-origins";
import { normalizeAddress } from "@/lib/delivery-intelligence/normalize";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import {
  ShipmentWriteUnsupportedError,
  supportsShipmentWrites,
  type ShipmentCreateInput,
  type ShipmentCreateResult,
} from "@/lib/delivery-intelligence/adapters/provider-adapter";

export type MerchantShipmentStatus = "PENDING" | "CREATED" | "LABEL_READY" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED" | "FAILED" | "UNSUPPORTED";

export type MerchantShipmentRecord = {
  id: string;
  merchant_id: string;
  order_check_id: string;
  account_id: string | null;
  provider: string;
  shipment_id: string | null;
  tracking_number: string | null;
  label_url: string | null;
  labels_url: string | null;
  label_pdf_url: string | null;
  import_id: string | null;
  shipment_status: MerchantShipmentStatus;
  shipment_created_at: string | null;
  shipment_error: string | null;
  raw_response: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ShipmentOrderCheck = {
  id: string;
  merchant_id: string;
  store_id: string | null;
  order_id: string | null;
  external_order_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  phone_raw: string | null;
  city: string | null;
  wilaya: string | null;
  address: string | null;
  customer_address: string | null;
  total_amount: number | null;
  cart_total: number | null;
  product_count: number | null;
  shipping_provider: string | null;
  shipping_type: string | null;
  shipping_price: number | null;
  shipping_wilaya: string | null;
  shipping_commune: string | null;
  shipping_stopdesk: string | null;
  shipping_office_id: string | null;
  product_names?: string[] | null;
  product_items?: Array<{
    productName?: string | null;
    product_name?: string | null;
    quantity?: number | null;
    itemTotal?: number | null;
    item_total?: number | null;
    color?: string | null;
    colour?: string | null;
    size?: string | null;
    attributes?: unknown;
    variation?: unknown;
    variations?: unknown;
    variant?: unknown;
    [key: string]: unknown;
  }> | null;
};

type ShipmentProductDetail = {
  productName: string;
  quantity: number;
  unitPrice: number;
  itemTotal: number;
  attributes: Record<string, string>;
};

const SHIPMENT_DESCRIPTION_MAX_LENGTH = Math.max(80, Number(process.env.YALIDINE_PRODUCT_DESCRIPTION_MAX_LENGTH ?? 240) || 240);

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
  deliveryWilayaId: string | null;
  deliveryWilayaName: string | null;
  deliveryCommuneName: string | null;
} {
  if (!raw) {
    return {
      deliveryWilayaId: null,
      deliveryWilayaName: null,
      deliveryCommuneName: null,
    };
  }

  return {
    deliveryWilayaId: firstString(raw, [
      "delivery_wilaya_id",
      "deliveryWilayaId",
      "receiver.delivery_wilaya_id",
      "receiver.deliveryWilayaId",
      "data.delivery_wilaya_id",
      "data.deliveryWilayaId",
      "payload.delivery_wilaya_id",
      "payload.deliveryWilayaId",
      "parcel.delivery_wilaya_id",
      "parcel.deliveryWilayaId",
      "parcel.receiver.wilayaId",
      "parcel.receiver.cityTerritoryId",
      "data.receiver.wilayaId",
      "data.receiver.cityTerritoryId",
      "deliveryAddress.cityTerritoryId",
      "data.deliveryAddress.cityTerritoryId",
    ]),
    deliveryWilayaName: firstString(raw, [
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
    deliveryCommuneName: firstString(raw, [
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

type StoreRow = {
  id: string;
  name: string;
  phone: string | null;
};

function buildFallbackShippingProfile(params: {
  orderCheck: ShipmentOrderCheck;
  store: StoreRow | null;
  fromWilayaName?: string;
}): MerchantShippingProfile {
  const senderName = params.store?.name?.trim() || params.orderCheck.customer_name?.trim() || "Merchant";
  const senderPhone = params.store?.phone?.trim() || params.orderCheck.customer_phone?.trim() || params.orderCheck.phone_raw?.trim() || "0000000000";
  const originWilaya = params.fromWilayaName || params.orderCheck.wilaya?.trim() || params.orderCheck.city?.trim() || "Alger";
  const originCommune = params.orderCheck.city?.trim() || deriveCityFromAddress(params.orderCheck.customer_address ?? params.orderCheck.address) || originWilaya;
  const declaredValue = Number(params.orderCheck.total_amount ?? params.orderCheck.cart_total ?? 0) || 1;

  return {
    sender_name: senderName,
    sender_phone: senderPhone,
    from_wilaya_name: originWilaya,
    from_commune_name: originCommune,
    default_product_list: buildShipmentProductSummary(params.orderCheck),
    default_declared_value: declaredValue,
    default_weight: 1,
    default_length: 1,
    default_width: 1,
    default_height: 1,
    default_do_insurance: false,
    default_freeshipping: false,
    default_is_stopdesk: false,
    default_stopdesk_id: null,
    return_center_code: null,
  };
}

function shipmentStatusFromCreate(result: ShipmentCreateResult): MerchantShipmentStatus {
  if (result.shipmentStatus === "LABEL_READY") return "LABEL_READY";
  if (result.shipmentStatus === "UNSUPPORTED") return "UNSUPPORTED";
  if (result.shipmentStatus === "FAILED") return "FAILED";
  return "CREATED";
}

function cleanAttributeLabel(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/^attribute_/i, "")
    .replace(/^pa_/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "colour") {
    return "color";
  }

  return normalized;
}

function cleanAttributeValue(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^attribute_/i, "")
    .replace(/^pa_/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function collectVariationAttributes(item: Record<string, unknown>): Record<string, string> {
  const attributes = new Map<string, string>();
  const put = (label: unknown, value: unknown) => {
    const cleanLabel = cleanAttributeLabel(String(label ?? ""));
    const cleanValue = cleanAttributeValue(value);
    if (!cleanLabel || !cleanValue) {
      return;
    }
    if (!attributes.has(cleanLabel)) {
      attributes.set(cleanLabel, cleanValue);
    }
  };

  put("color", item.color ?? item.colour);
  put("size", item.size);

  const maybeSources = [item.attributes, item.variation, item.variations, item.variant];
  for (const source of maybeSources) {
    if (!source) {
      continue;
    }

    if (Array.isArray(source)) {
      for (const entry of source) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const row = entry as Record<string, unknown>;
        put(row.name ?? row.key ?? row.label ?? row.slug, row.value ?? row.option ?? row.term ?? row.term_name);
      }
      continue;
    }

    if (typeof source === "object") {
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        put(key, value);
      }
    }
  }

  for (const [key, value] of Object.entries(item)) {
    if (/^(attribute_|pa_|color$|colour$|size$)/i.test(key)) {
      put(key, value);
    }
  }

  const orderedKeys = Array.from(attributes.keys()).sort((a, b) => {
    if (a === "color") return -1;
    if (b === "color") return 1;
    if (a === "size") return -1;
    if (b === "size") return 1;
    return a.localeCompare(b);
  });

  const normalized: Record<string, string> = {};
  for (const key of orderedKeys) {
    normalized[key] = attributes.get(key) as string;
  }

  return normalized;
}

function formatAttributeLabel(label: string): string {
  if (label === "color") return "Color";
  if (label === "size") return "Size";
  return label
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildProductDisplayName(productName: string, attributes: Record<string, string>): string {
  const parts: string[] = [];

  if (attributes.color) {
    parts.push(attributes.color);
  }
  if (attributes.size) {
    parts.push(`Size ${attributes.size}`);
  }

  for (const [label, value] of Object.entries(attributes)) {
    if (label === "color" || label === "size") {
      continue;
    }
    parts.push(`${formatAttributeLabel(label)} ${value}`);
  }

  return [productName, ...parts].join(" ").trim();
}

function applyDescriptionLengthLimit(lines: string[], maxLength: number): string {
  if (lines.length === 0) {
    return "";
  }

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const nextKept = [...kept, lines[i]];
    const remaining = lines.length - nextKept.length;
    const suffix = remaining > 0 ? `\n+${remaining} more items` : "";
    const candidate = `${nextKept.join("\n")}${suffix}`;
    if (candidate.length > maxLength) {
      break;
    }
    kept.push(lines[i]);
  }

  if (kept.length === 0) {
    return lines[0].slice(0, maxLength).trim();
  }

  const remaining = lines.length - kept.length;
  return remaining > 0 ? `${kept.join("\n")}\n+${remaining} more items` : kept.join("\n");
}

function normalizeShipmentProductDetails(row: ShipmentOrderCheck): ShipmentProductDetail[] {
  const rawItems = Array.isArray(row.product_items) ? row.product_items : [];
  const fallbackNamesByIndex = Array.isArray(row.product_names)
    ? row.product_names.map((name) => String(name ?? "").trim())
    : [];
  const normalizedItems = rawItems
    .map((item, index) => {
      const raw = item as Record<string, unknown>;
      const productNameFromItems = String(raw.productName ?? raw.product_name ?? "").trim();
      const productNameFromNames = fallbackNamesByIndex[index] ?? "";
      const productName = productNameFromNames || productNameFromItems;
      if (!productName) {
        return null;
      }

      const quantity = Math.max(1, Number(raw.quantity ?? 1) || 1);
      const itemTotal = Math.max(0, Number(raw.itemTotal ?? raw.item_total ?? 0) || 0);
      const unitPrice = quantity > 0 ? itemTotal / quantity : itemTotal;
      const attributes = collectVariationAttributes(raw);

      return {
        productName,
        quantity,
        unitPrice,
        itemTotal,
        attributes,
      };
    })
    .filter((item): item is ShipmentProductDetail => item !== null);

  if (normalizedItems.length > 0) {
    return normalizedItems;
  }

  const fallbackNames = Array.isArray(row.product_names)
    ? row.product_names.map((name) => String(name ?? "").trim()).filter(Boolean)
    : [];

  if (fallbackNames.length === 0) {
    return [];
  }

  const totalAmount = Math.max(0, Number(row.total_amount ?? row.cart_total ?? 0) || 0);
  const distributedUnitPrice = fallbackNames.length > 0 ? totalAmount / fallbackNames.length : totalAmount;

  return fallbackNames.map((productName) => ({
    productName,
    quantity: 1,
    unitPrice: distributedUnitPrice,
    itemTotal: distributedUnitPrice,
    attributes: {},
  }));
}

function buildShipmentProductSummary(row: ShipmentOrderCheck): string {
  const productDetails = normalizeShipmentProductDetails(row);

  const grouped = new Map<string, { displayName: string; quantity: number }>();
  for (const item of productDetails) {
    const displayName = buildProductDisplayName(item.productName, item.attributes);
    const key = `${displayName}::${JSON.stringify(item.attributes)}`;
    const current = grouped.get(key);
    if (current) {
      current.quantity += item.quantity;
      continue;
    }
    grouped.set(key, {
      displayName,
      quantity: item.quantity,
    });
  }

  const lines = Array.from(grouped.values()).map((entry) => `${entry.displayName} ×${entry.quantity}`);
  if (lines.length > 0) {
    return applyDescriptionLengthLimit(lines, SHIPMENT_DESCRIPTION_MAX_LENGTH);
  }

  return String(row.external_order_id ?? row.order_id ?? row.id).trim();
}

function buildShipmentOrderedProducts(row: ShipmentOrderCheck): NonNullable<ShipmentCreateInput["orderedProducts"]> {
  const productDetails = normalizeShipmentProductDetails(row);
  if (productDetails.length > 0) {
    return productDetails.map((item) => ({
      productName: buildProductDisplayName(item.productName, item.attributes),
      quantity: item.quantity,
      price: item.unitPrice,
      stockType: "none",
    }));
  }

  const summary = buildShipmentProductSummary(row);
  return [{
    productName: summary,
    quantity: 1,
    price: Number(row.total_amount ?? row.cart_total ?? 0),
    stockType: "none",
  }];
}

function normalizeStopdeskTerritoryId(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith("zr_virtual_")) {
    const candidate = raw.slice("zr_virtual_".length).trim();
    return candidate || null;
  }

  return raw;
}

function stripStopdeskOfficeSuffix(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const stripped = raw
    .replace(/\s*[-,|/]*\s*(stop\s*desk|point\s*relais|bureau)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return stripped || null;
}

function looksLikeStopdeskOfficeLabel(value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return false;
  }

  return /(stop\s*desk|point\s*relais|bureau)/i.test(raw);
}

async function resolveStopdeskCommune(params: {
  supabase: ReturnType<typeof createClient>;
  merchantId: string;
  provider: string;
  shippingWilaya: string | null | undefined;
  shippingCommune: string | null | undefined;
  shippingStopdesk: string | null | undefined;
  shippingOfficeId: string | null | undefined;
  normalizedOfficeTerritoryId: string | null;
}): Promise<string> {
  const shippingCommune = String(params.shippingCommune ?? "").trim();
  const shippingStopdesk = String(params.shippingStopdesk ?? "").trim();
  const shippingWilaya = String(params.shippingWilaya ?? "").trim();
  const officeIds = Array.from(new Set([
    String(params.shippingOfficeId ?? "").trim(),
    String(params.normalizedOfficeTerritoryId ?? "").trim(),
  ].filter(Boolean)));

  for (const officeId of officeIds) {
    const query = params.supabase
      .from("merchant_delivery_cache")
      .select("commune_name,office_name,office_id,wilaya_name")
      .eq("merchant_id", params.merchantId)
      .eq("provider", params.provider)
      .eq("office_id", officeId);

    const scopedQuery = shippingWilaya ? query.eq("wilaya_name", shippingWilaya) : query;
    const { data } = await scopedQuery.limit(1);
    const row = Array.isArray(data) ? data[0] : null;
    const communeName = String((row as { commune_name?: unknown } | null)?.commune_name ?? "").trim();
    if (communeName) {
      return communeName;
    }
  }

  if (shippingCommune && !looksLikeStopdeskOfficeLabel(shippingCommune) && shippingCommune.toLowerCase() !== shippingStopdesk.toLowerCase()) {
    return shippingCommune;
  }

  const sanitizedCommune = stripStopdeskOfficeSuffix(shippingCommune) ?? stripStopdeskOfficeSuffix(shippingStopdesk);
  if (sanitizedCommune) {
    return sanitizedCommune;
  }

  return shippingCommune || shippingStopdesk;
}

function mapShipmentStatusToDeliveryStatus(status: MerchantShipmentStatus): "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED" {
  if (status === "IN_TRANSIT") return "IN_TRANSIT";
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "CANCELLED") return "CANCELLED";
  return "PENDING";
}

async function upsertDeliveryOrderFromShipment(params: {
  merchantId: string;
  accountId: string;
  provider: string;
  orderCheck: ShipmentOrderCheck;
  created: ShipmentCreateResult;
  shipmentStatus: MerchantShipmentStatus;
}) {
  const supabase = createClient();
  const phoneSecret = process.env.DELIVERY_PHONE_HASH_SECRET ?? process.env.NEXT_PUBLIC_APP_URL ?? "delivery_phone_fallback_secret";
  const canonicalPhone = normalizeAlgerianPhone(params.orderCheck.customer_phone ?? params.orderCheck.phone_raw ?? "")
    ?? (params.orderCheck.customer_phone ?? params.orderCheck.phone_raw ?? null);
  const phoneHash = canonicalPhone ? hashWithSecret(canonicalPhone, phoneSecret) : null;
  const externalOrderId = params.orderCheck.external_order_id ?? params.orderCheck.order_id ?? params.orderCheck.id;
  const now = new Date().toISOString();
  const derivedCity = deriveCityFromAddress(params.orderCheck.customer_address ?? params.orderCheck.address);
  const deliveryTerritory = extractDeliveryTerritory(params.created.rawResponse);

  const baseRow = {
    merchant_id: params.merchantId,
    account_id: params.accountId,
    provider: params.provider,
    external_order_id: externalOrderId,
    tracking_number: params.created.trackingNumber ?? null,
    customer_name: params.orderCheck.customer_name ?? null,
    customer_phone: canonicalPhone,
    customer_phone_hash: phoneHash,
    customer_address: params.orderCheck.customer_address ?? params.orderCheck.address ?? null,
    normalized_address: normalizeAddress(params.orderCheck.customer_address ?? params.orderCheck.address),
    wilaya: deliveryTerritory.deliveryWilayaName ?? params.orderCheck.shipping_wilaya ?? params.orderCheck.wilaya ?? null,
    commune: deliveryTerritory.deliveryCommuneName ?? params.orderCheck.shipping_commune ?? params.orderCheck.city ?? derivedCity,
    order_amount: Number(params.orderCheck.total_amount ?? params.orderCheck.cart_total ?? 0),
    status: mapShipmentStatusToDeliveryStatus(params.shipmentStatus),
    synced_at: now,
    source_payload: {
      orderCheckId: params.orderCheck.id,
      shipmentId: params.created.shipmentId,
      importId: params.created.importId ?? null,
      shipmentStatus: params.created.shipmentStatus,
      delivery_wilaya_id: deliveryTerritory.deliveryWilayaId,
      delivery_wilaya_name: deliveryTerritory.deliveryWilayaName,
      delivery_commune_name: deliveryTerritory.deliveryCommuneName,
      rawResponse: params.created.rawResponse,
    },
    updated_at: now,
  };

  let { error } = await supabase.from("delivery_orders").upsert(baseRow, {
    onConflict: "merchant_id,provider,external_order_id",
  });

  if (error && /(source_customer_id|source_created_at|source_last_state_update_at)/i.test(error.message ?? "")) {
    const fallback = await supabase.from("delivery_orders").upsert({
      ...baseRow,
      source_customer_id: null,
      source_created_at: null,
      source_last_state_update_at: null,
    }, {
      onConflict: "merchant_id,provider,external_order_id",
    });
    error = fallback.error;
  }

  if (error) {
    throw error;
  }
}

export class ShippingProfileRequiredError extends Error {
  constructor(message = "Complete shipping profile before creating shipments.") {
    super(message);
    this.name = "ShippingProfileRequiredError";
  }
}

export class ShippingOriginRequiredError extends Error {
  readonly origins: Array<{ id: string; name: string; is_default: boolean }>;

  constructor(origins: Array<{ id: string; name: string; is_default: boolean }>) {
    super("Select a shipping origin for Yalidine before creating this shipment.");
    this.name = "ShippingOriginRequiredError";
    this.origins = origins;
  }
}

export class ShipmentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipmentPersistenceError";
  }
}

function pickPreferredAccount(accounts: Awaited<ReturnType<typeof getSyncableDeliveryAccounts>>) {
  const eligible = accounts.filter((account) => {
    const status = String(account.connection_status ?? "").toLowerCase();
    return status === "connected" || status === "attention_required";
  });
  if (eligible.length === 0) {
    return null;
  }

  eligible.sort((left, right) => {
    const weight = (provider: string) => provider === "yalidine" ? 0 : provider === "zr_express" ? 1 : 2;
    const byProvider = weight(left.provider) - weight(right.provider);
    if (byProvider !== 0) return byProvider;
    return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
  });

  return eligible[0] ?? null;
}

export async function getShipmentByOrderCheck(merchantId: string, orderCheckId: string): Promise<MerchantShipmentRecord | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_shipments")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("order_check_id", orderCheckId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as MerchantShipmentRecord | null;
}

export async function persistShipmentRecord(params: {
  merchantId: string;
  orderCheckId: string;
  accountId?: string | null;
  provider: string;
  shipmentId?: string | null;
  trackingNumber?: string | null;
  labelUrl?: string | null;
  labelsUrl?: string | null;
  labelPdfUrl?: string | null;
  importId?: string | null;
  shipmentStatus: MerchantShipmentStatus;
  shipmentCreatedAt?: string | null;
  shipmentError?: string | null;
  rawResponse?: Record<string, unknown>;
}): Promise<MerchantShipmentRecord> {
  const supabase = createClient();
  const territory = extractDeliveryTerritory(params.rawResponse);
  const rawResponse = {
    ...(params.rawResponse ?? {}),
    ...(territory.deliveryWilayaId ? { delivery_wilaya_id: territory.deliveryWilayaId } : {}),
    ...(territory.deliveryWilayaName ? { delivery_wilaya_name: territory.deliveryWilayaName } : {}),
    ...(territory.deliveryCommuneName ? { delivery_commune_name: territory.deliveryCommuneName } : {}),
  };
  const { data, error } = await supabase
    .from("merchant_shipments")
    .upsert({
      merchant_id: params.merchantId,
      order_check_id: params.orderCheckId,
      account_id: params.accountId ?? null,
      provider: params.provider,
      shipment_id: params.shipmentId ?? null,
      tracking_number: params.trackingNumber ?? null,
      label_url: params.labelUrl ?? null,
      labels_url: params.labelsUrl ?? params.labelUrl ?? null,
      label_pdf_url: params.labelPdfUrl ?? null,
      import_id: params.importId ?? null,
      shipment_status: params.shipmentStatus,
      shipment_created_at: params.shipmentCreatedAt ?? null,
      shipment_error: params.shipmentError ?? null,
      raw_response: rawResponse,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "merchant_id,order_check_id"
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as MerchantShipmentRecord;
}

async function queueWooDecisionResyncWithShipment(params: {
  merchantId: string;
  orderCheckId: string;
}) {
  const supabase = createClient();
  const { error } = await supabase
    .from("merchant_decisions")
    .update({
      wc_sync_status: "PENDING",
      wc_synced_at: null,
      wc_sync_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", params.merchantId)
    .eq("order_check_id", params.orderCheckId)
    .eq("decision", "ACCEPTED")
    .eq("wc_sync_status", "SYNCED");

  if (error) {
    console.warn("Failed to queue Woo decision re-sync after shipment update", {
      merchantId: params.merchantId,
      orderCheckId: params.orderCheckId,
      error: error.message,
    });
  }
}

export async function createShipmentForOrderCheck(merchantId: string, orderCheckId: string, shippingOriginId?: string | null): Promise<MerchantShipmentRecord> {
  const existing = await getShipmentByOrderCheck(merchantId, orderCheckId);
  if (existing && ["CREATED", "LABEL_READY", "IN_TRANSIT", "DELIVERED"].includes(existing.shipment_status)) {
    return existing;
  }

  const decision = await getMerchantDecisionByOrderCheck(merchantId, orderCheckId);
  if (!decision || decision.decision !== "ACCEPTED") {
    throw new Error("shipment_requires_confirmed_order");
  }

  const supabase = createClient();
  const { data: orderCheck, error: orderCheckError } = await supabase
    .from("order_checks")
    .select("id, merchant_id, store_id, order_id, external_order_id, customer_name, customer_phone, phone_raw, city, wilaya, address, customer_address, total_amount, cart_total, product_count, product_names, product_items, shipping_provider, shipping_type, shipping_price, shipping_wilaya, shipping_commune, shipping_stopdesk, shipping_office_id")
    .eq("merchant_id", merchantId)
    .eq("id", orderCheckId)
    .maybeSingle();

  if (orderCheckError) throw orderCheckError;
  if (!orderCheck) throw new Error("order_check_not_found");

  const accounts = await getSyncableDeliveryAccounts(merchantId);
  const preferredAccount = pickPreferredAccount(accounts);
  if (!preferredAccount) {
    return persistShipmentRecord({
      merchantId,
      orderCheckId,
      provider: existing?.provider ?? "yalidine",
      shipmentStatus: "FAILED",
      shipmentError: "No connected delivery account is available.",
      rawResponse: { code: "NO_CONNECTED_ACCOUNT" },
    });
  }

  const store = (orderCheck as ShipmentOrderCheck).store_id
    ? (await supabase.from("stores").select("id, name, phone").eq("merchant_id", merchantId).eq("id", (orderCheck as ShipmentOrderCheck).store_id).maybeSingle()).data as StoreRow | null
    : null;

  const merchantShippingProfile = await getMerchantShippingProfile(merchantId);
  let shippingProfile: MerchantShippingProfile;
  if (!merchantShippingProfile) {
    // No configured shipping profile. Try to build a minimal fallback from the Yalidine
    // shipping origin so the shipment can proceed with the correct from_wilaya_name.
    let fallbackWilayaName: string | null = null;
    if (preferredAccount.provider === "yalidine") {
      const earlyOrigins = await listShippingOrigins(merchantId, "yalidine");
      const defaultOrigin = earlyOrigins.find((o) => o.is_default) ?? earlyOrigins[0] ?? null;
      fallbackWilayaName = defaultOrigin?.wilaya_name ?? null;
    }

    if (!fallbackWilayaName) {
      return persistShipmentRecord({
        merchantId,
        orderCheckId,
        accountId: preferredAccount.id,
        provider: preferredAccount.provider,
        shipmentStatus: "FAILED",
        shipmentError: "Merchant shipping profile is missing. Please configure sender/origin settings.",
        rawResponse: { code: "MISSING_SHIPPING_PROFILE" },
      });
    }

    console.warn("[shipment-service] No shipping profile configured; building fallback from shipping origin", {
      merchantId,
      fallbackWilayaName,
    });
    shippingProfile = buildFallbackShippingProfile({
      orderCheck: orderCheck as ShipmentOrderCheck,
      store,
      fromWilayaName: fallbackWilayaName,
    });
  } else {
    shippingProfile = merchantShippingProfile;
  }

  let selectedShippingOrigin: ShippingOriginRecord | null = null;
  let yalidineOriginRequired = false;
  if (preferredAccount.provider === "yalidine") {
    const yalidineOrigins = await listShippingOrigins(merchantId, "yalidine");
    yalidineOriginRequired = yalidineOrigins.length > 0;

    if (shippingOriginId) {
      const resolved = await getShippingOriginById(merchantId, shippingOriginId);
      if (!resolved || resolved.provider !== "yalidine") {
        throw new Error("shipping_origin_not_found");
      }
      selectedShippingOrigin = resolved;
    } else {
      if (yalidineOrigins.length === 1) {
        selectedShippingOrigin = yalidineOrigins[0];
      } else if (yalidineOrigins.length > 1) {
        const defaultOrigin = yalidineOrigins.find((item) => item.is_default) ?? null;
        if (defaultOrigin) {
          selectedShippingOrigin = defaultOrigin;
        } else {
          throw new ShippingOriginRequiredError(
            yalidineOrigins.map((item) => ({
              id: item.id,
              name: item.name,
              is_default: item.is_default,
            }))
          );
        }
      }
    }

    if (yalidineOriginRequired && !selectedShippingOrigin) {
      throw new ShippingOriginRequiredError(
        yalidineOrigins.map((item) => ({
          id: item.id,
          name: item.name,
          is_default: item.is_default,
        }))
      );
    }
  }

  const adapter = ProviderRegistry.get(preferredAccount.provider);
  if (!supportsShipmentWrites(adapter)) {
    return persistShipmentRecord({
      merchantId,
      orderCheckId,
      accountId: preferredAccount.id,
      provider: preferredAccount.provider,
      shipmentStatus: "UNSUPPORTED",
      shipmentError: `Shipment writes are not implemented for provider ${preferredAccount.provider}.`,
      rawResponse: { code: "SHIPMENT_WRITE_UNSUPPORTED" },
    });
  }

  const row = orderCheck as ShipmentOrderCheck;
  const derivedCity = deriveCityFromAddress(row.customer_address ?? row.address);
  const resolvedCommune = row.city ?? derivedCity ?? "";
  const isStopdesk = String(row.shipping_type ?? "home").toLowerCase() === "stopdesk";
  const shippingType = isStopdesk ? "pickup-point" : "home";
  const phone = normalizeAlgerianPhone(row.customer_phone ?? row.phone_raw ?? "") ?? (row.customer_phone ?? row.phone_raw ?? "");
  const normalizedOfficeTerritoryId = isStopdesk ? normalizeStopdeskTerritoryId(row.shipping_office_id) : null;
  const resolvedStopdeskCommune = isStopdesk
    ? await resolveStopdeskCommune({
      supabase,
      merchantId,
      provider: preferredAccount.provider,
      shippingWilaya: row.shipping_wilaya ?? row.wilaya,
      shippingCommune: row.shipping_commune,
      shippingStopdesk: row.shipping_stopdesk,
      shippingOfficeId: row.shipping_office_id,
      normalizedOfficeTerritoryId,
    })
    : null;
  const normalizedStopdeskAddress = isStopdesk
    ? (row.shipping_stopdesk ?? row.customer_address ?? row.address ?? "Stop Desk Pickup")
    : (row.customer_address ?? row.address ?? "");
  const productSummary = buildShipmentProductSummary(row);
  const orderedProducts = buildShipmentOrderedProducts(row);

  // For Yalidine: resolve the ISO wilaya code ("DZ-23") to the Yalidine wilaya name ("Annaba"),
  // and resolve the stop desk display name to the actual commune name via delivery_stopdesks.
  let resolvedCustomerWilaya = row.shipping_wilaya ?? row.wilaya ?? "";
  let resolvedCustomerCommune = isStopdesk
    ? (resolvedStopdeskCommune ?? resolvedCommune)
    : (row.shipping_commune ?? resolvedCommune);

  if (preferredAccount.provider === "yalidine") {
    const isoCode = resolvedCustomerWilaya;
    if (/^DZ-/i.test(isoCode)) {
      const numericId = isoCode.replace(/^DZ-0*/i, "") || isoCode;
      const { data: wilayaRow } = await supabase
        .from("global_delivery_wilayas")
        .select("wilaya_name")
        .eq("provider", "yalidine")
        .eq("wilaya_id", numericId)
        .maybeSingle();
      if (wilayaRow?.wilaya_name) {
        console.info("[shipment-service][YALIDINE] Resolved wilaya", {
          input: isoCode, numericId, resolved: wilayaRow.wilaya_name,
        });
        resolvedCustomerWilaya = wilayaRow.wilaya_name;
      }
    }

    // Resolve commune: try office_id first, then fall back to matching by office_name.
    // delivery_stopdesks is queried without merchant_id — Yalidine office IDs are global.
    const officeId = row.shipping_office_id;
    const officeName = row.shipping_commune ?? null;
    let stopdeskRow: { commune_name: string; wilaya_name: string | null } | null = null;

    if (officeId) {
      const { data } = await supabase
        .from("delivery_stopdesks")
        .select("commune_name, wilaya_name")
        .eq("provider", "yalidine")
        .eq("office_id", officeId)
        .limit(1)
        .maybeSingle();
      stopdeskRow = data ?? null;
    }

    if (!stopdeskRow && officeName) {
      const { data } = await supabase
        .from("delivery_stopdesks")
        .select("commune_name, wilaya_name")
        .eq("provider", "yalidine")
        .eq("office_name", officeName)
        .limit(1)
        .maybeSingle();
      stopdeskRow = data ?? null;
    }

    if (stopdeskRow?.commune_name) {
      console.info("[shipment-service][YALIDINE] Resolved commune from stopdesk", {
        officeId, officeName, communeName: stopdeskRow.commune_name, wilayaName: stopdeskRow.wilaya_name,
      });
      resolvedCustomerCommune = stopdeskRow.commune_name;
      if (stopdeskRow.wilaya_name && resolvedCustomerWilaya !== stopdeskRow.wilaya_name) {
        resolvedCustomerWilaya = stopdeskRow.wilaya_name;
      }
    }
  }

  const shipmentInput: ShipmentCreateInput = {
    orderReference: row.external_order_id ?? row.order_id ?? row.id,
    customerName: row.customer_name ?? "Customer",
    customerPhone: phone,
    customerAddress: normalizedStopdeskAddress,
    customerWilaya: resolvedCustomerWilaya,
    customerCommune: resolvedCustomerCommune,
    codAmount: Number(row.total_amount ?? row.cart_total ?? 0),
    productSummary,
    storeName: store?.name ?? null,
    storePhone: store?.phone ?? null,
    storeOriginWilaya: shippingProfile.from_wilaya_name,
    trackingNumber: existing?.tracking_number ?? null,
    shippingProfile,
    shippingOrigin: selectedShippingOrigin
      ? {
          id: selectedShippingOrigin.id,
          provider: selectedShippingOrigin.provider,
          name: selectedShippingOrigin.name,
          wilayaId: selectedShippingOrigin.wilaya_id,
          wilayaName: selectedShippingOrigin.wilaya_name,
          officeId: selectedShippingOrigin.office_id,
          officeName: selectedShippingOrigin.office_name,
          senderName: selectedShippingOrigin.sender_name,
          senderPhone: selectedShippingOrigin.sender_phone,
          senderAddress: selectedShippingOrigin.sender_address,
          isDefault: selectedShippingOrigin.is_default,
        }
      : null,
    requireShippingOriginFields: yalidineOriginRequired,
    deliveryType: shippingType,
    description: productSummary,
    paymentMethod: "cash",
    externalId: row.external_order_id ?? row.order_id ?? row.id,
    orderedProducts,
    deliveryAddress: {
      street: normalizedStopdeskAddress,
      city: row.shipping_wilaya ?? row.wilaya ?? "",
      district: isStopdesk ? (resolvedStopdeskCommune ?? resolvedCommune) : (row.shipping_commune ?? resolvedCommune),
      districtTerritoryId: normalizedOfficeTerritoryId,
    },
  };

  await supabase.from("risk_events").insert({
    merchant_id: merchantId,
    order_check_id: orderCheckId,
    event_type: "shipment_create_attempt",
    payload: {
      provider: preferredAccount.provider,
      accountId: preferredAccount.id,
      requestPayload: {
        deliveryType: shipmentInput.deliveryType,
        is_stopdesk: isStopdesk,
        office_id: normalizedOfficeTerritoryId,
        stopdesk_name: row.shipping_stopdesk ?? null,
        wilaya: shipmentInput.customerWilaya,
        commune: shipmentInput.customerCommune,
        customer_first_last: shipmentInput.customerName,
        customer_phone: shipmentInput.customerPhone,
        orderReference: shipmentInput.orderReference,
      },
    },
    created_at: new Date().toISOString(),
  });

  console.info("[shipment-service] createShipment pre-flight", {
    merchantId,
    provider:           preferredAccount.provider,
    accountId:          preferredAccount.id,
    sender_name:        shippingProfile.sender_name,
    from_wilaya_name:   shippingProfile.from_wilaya_name,
    from_commune_name:  shippingProfile.from_commune_name,
    return_center_code: shippingProfile.return_center_code ?? null,
    to_wilaya_name:     row.shipping_wilaya ?? row.wilaya ?? "",
    to_commune_name:    isStopdesk ? (resolvedStopdeskCommune ?? resolvedCommune) : (row.shipping_commune ?? resolvedCommune),
    order_id:           row.external_order_id ?? row.order_id ?? row.id,
  });

  let created: ShipmentCreateResult;
  const providerConfig = {
    baseUrl: preferredAccount.base_url,
    authType: preferredAccount.auth_type,
    credentials: preferredAccount.credentials,
    endpoints: preferredAccount.endpoints,
    fieldMapping: preferredAccount.field_mapping,
    customHeaders: preferredAccount.credentials?.customHeaders
      ? (() => {
          try {
            return JSON.parse(preferredAccount.credentials.customHeaders) as Record<string, string>;
          } catch {
            return undefined;
          }
        })()
      : undefined,
    statusMapping: preferredAccount.status_mapping,
  };

  // ─── COMPREHENSIVE SHIPMENT TRACE ────────────────────────────────────────────
  // Logs: raw DB order → derived values → shipping profile → shipping origin →
  // shipmentInput → field-by-field Yalidine payload preview with gap analysis.
  const _isStopdesk_profile   = Boolean(shippingProfile.default_is_stopdesk);
  const _isStopdesk_order     = isStopdesk;
  const _stopdeskIdRaw        = shippingProfile.default_stopdesk_id ?? null;
  const _stopdeskIdParsed     = _stopdeskIdRaw != null ? parseInt(_stopdeskIdRaw, 10) : null;
  const _fromWilaya            = selectedShippingOrigin?.wilaya_name ?? shippingProfile.from_wilaya_name;
  console.info("[shipment-service][TRACE] createShipment full trace", {

    // 1 ─ Raw order loaded from DB (order_checks row)
    db_order: {
      id:                row.id,
      order_id:          (row as Record<string, unknown>).order_id          ?? null,
      external_order_id: (row as Record<string, unknown>).external_order_id ?? null,
      customer_name:     (row as Record<string, unknown>).customer_name     ?? null,
      customer_phone:    (row as Record<string, unknown>).customer_phone    ?? null,
      phone_raw:         (row as Record<string, unknown>).phone_raw         ?? null,
      customer_address:  (row as Record<string, unknown>).customer_address  ?? null,
      address:           (row as Record<string, unknown>).address           ?? null,
      city:              (row as Record<string, unknown>).city              ?? null,
      wilaya:            (row as Record<string, unknown>).wilaya            ?? null,
      shipping_wilaya:   (row as Record<string, unknown>).shipping_wilaya   ?? null,
      shipping_commune:  (row as Record<string, unknown>).shipping_commune  ?? null,
      shipping_type:     (row as Record<string, unknown>).shipping_type     ?? null,
      shipping_stopdesk: (row as Record<string, unknown>).shipping_stopdesk ?? null,
      shipping_office_id:(row as Record<string, unknown>).shipping_office_id ?? null,
      total_amount:      (row as Record<string, unknown>).total_amount      ?? null,
      cart_total:        (row as Record<string, unknown>).cart_total        ?? null,
    },

    // 2 ─ Derived / normalised intermediate values
    derived: {
      phone_after_normalize:       phone,
      is_stopdesk_from_order_type: _isStopdesk_order,
      resolved_commune:            resolvedCommune,
      resolved_stopdesk_commune:   resolvedStopdeskCommune ?? null,
      normalized_stopdesk_address: normalizedStopdeskAddress,
      normalized_office_id:        normalizedOfficeTerritoryId ?? null,
    },

    // 3 ─ Shipping profile (source of price, declared_value, is_stopdesk, stopdesk_id…)
    shipping_profile: {
      from_wilaya_name:       shippingProfile.from_wilaya_name,
      from_commune_name:      shippingProfile.from_commune_name,
      default_declared_value: shippingProfile.default_declared_value,
      default_is_stopdesk:    shippingProfile.default_is_stopdesk,
      default_stopdesk_id:    shippingProfile.default_stopdesk_id ?? null,
      default_freeshipping:   shippingProfile.default_freeshipping,
      default_do_insurance:   shippingProfile.default_do_insurance,
      default_weight:         shippingProfile.default_weight,
      default_length:         shippingProfile.default_length,
      default_width:          shippingProfile.default_width,
      default_height:         shippingProfile.default_height,
      default_product_list:   shippingProfile.default_product_list,
    },

    // 4 ─ Shipping origin (overrides from_wilaya_name if set)
    shipping_origin: selectedShippingOrigin ? {
      id:          selectedShippingOrigin.id,
      name:        selectedShippingOrigin.name,
      wilaya_id:   selectedShippingOrigin.wilaya_id,
      wilaya_name: selectedShippingOrigin.wilaya_name,
      office_id:   selectedShippingOrigin.office_id   ?? null,
      office_name: selectedShippingOrigin.office_name ?? null,
    } : null,
    yalidine_origin_required: yalidineOriginRequired,

    // 5 ─ shipmentInput (what is passed to the adapter)
    shipment_input: {
      orderReference:             shipmentInput.orderReference,
      customerName:               shipmentInput.customerName,
      customerPhone:              shipmentInput.customerPhone,
      customerAddress:            shipmentInput.customerAddress,
      customerWilaya:             shipmentInput.customerWilaya,
      customerCommune:            shipmentInput.customerCommune,
      deliveryType:               shipmentInput.deliveryType  ?? null,
      requireShippingOriginFields: shipmentInput.requireShippingOriginFields ?? false,
      productSummary:             shipmentInput.productSummary,
      codAmount:                  shipmentInput.codAmount,
    },

    // 6 ─ Field-by-field Yalidine payload preview with gap analysis.
    //     Each entry shows: value that WILL be sent, its source, and ok=false if empty/invalid.
    yalidine_field_trace: {
      order_id: {
        will_send: shipmentInput.orderReference,
        db_raw:    `ext=${(row as Record<string, unknown>).external_order_id ?? "null"} / order_id=${(row as Record<string, unknown>).order_id ?? "null"} / id=${row.id}`,
        ok:        !!shipmentInput.orderReference,
      },
      firstname: {
        will_send: shipmentInput.customerName,   // mapShipmentPayload uses full name for both first+last when no separate billing fields exist
        db_raw:    (row as Record<string, unknown>).customer_name ?? null,
        note:      "ShipmentCreateInput has no billing_first/last_name; both firstname and familyname receive the full customer_name",
        ok:        !!shipmentInput.customerName && shipmentInput.customerName !== "Customer",
      },
      familyname: {
        will_send: shipmentInput.customerName,
        db_raw:    (row as Record<string, unknown>).customer_name ?? null,
        ok:        !!shipmentInput.customerName && shipmentInput.customerName !== "Customer",
      },
      contact_phone: {
        will_send: phone,
        db_raw:    `customer_phone=${(row as Record<string, unknown>).customer_phone ?? "null"} / phone_raw=${(row as Record<string, unknown>).phone_raw ?? "null"}`,
        ok:        !!phone,
      },
      address: {
        will_send: normalizedStopdeskAddress,
        resolution: _isStopdesk_order ? "stopdesk path: shipping_stopdesk ?? customer_address ?? address" : "home path: customer_address ?? address",
        db_raw:    `customer_address=${(row as Record<string, unknown>).customer_address ?? "null"} / address=${(row as Record<string, unknown>).address ?? "null"} / shipping_stopdesk=${(row as Record<string, unknown>).shipping_stopdesk ?? "null"}`,
        ok:        !!normalizedStopdeskAddress,
      },
      to_commune_name: {
        will_send:                shipmentInput.customerCommune,
        resolution:               _isStopdesk_order ? "stopdesk: resolvedStopdeskCommune ?? resolvedCommune" : "home: shipping_commune ?? resolvedCommune",
        db_shipping_commune:      (row as Record<string, unknown>).shipping_commune ?? null,
        resolved_commune:         resolvedCommune,
        resolved_stopdesk_commune: resolvedStopdeskCommune ?? null,
        ok:                       !!shipmentInput.customerCommune,
      },
      to_wilaya_name: {
        will_send: shipmentInput.customerWilaya,
        db_raw:    `shipping_wilaya=${(row as Record<string, unknown>).shipping_wilaya ?? "null"} / wilaya=${(row as Record<string, unknown>).wilaya ?? "null"}`,
        ok:        !!shipmentInput.customerWilaya,
      },
      from_wilaya_name: {
        will_send:            _fromWilaya,
        source:               selectedShippingOrigin ? "selectedShippingOrigin.wilaya_name" : "shippingProfile.from_wilaya_name",
        origin_wilaya_name:   selectedShippingOrigin?.wilaya_name   ?? null,
        profile_wilaya_name:  shippingProfile.from_wilaya_name,
        ok:                   !!_fromWilaya,
      },
      price: {
        will_send: Math.round(Number(shippingProfile.default_declared_value)),
        source:    "shippingProfile.default_declared_value → Math.round()",
        raw_value: shippingProfile.default_declared_value,
        ok:        Number.isFinite(shippingProfile.default_declared_value) && shippingProfile.default_declared_value > 0,
      },
      declared_value: {
        will_send: Math.round(Number(shippingProfile.default_declared_value)),
        source:    "shippingProfile.default_declared_value → Math.round()",
        raw_value: shippingProfile.default_declared_value,
        ok:        Number.isFinite(shippingProfile.default_declared_value) && shippingProfile.default_declared_value > 0,
      },
      is_stopdesk: {
        will_send:            _isStopdesk_profile,
        source:               "shippingProfile.default_is_stopdesk",
        order_shipping_type:  (row as Record<string, unknown>).shipping_type ?? null,
        is_stopdesk_by_order: _isStopdesk_order,
        MISMATCH_WARNING:     _isStopdesk_order !== _isStopdesk_profile
          ? "ORDER says stopdesk but PROFILE says home (or vice versa) — address resolved for one, payload sends the other"
          : null,
        ok: true,
      },
      stopdesk_id: {
        will_send:        _isStopdesk_profile ? _stopdeskIdParsed : "(not sent — is_stopdesk=false)",
        will_be_included: _isStopdesk_profile,
        raw_string:       _stopdeskIdRaw,
        parsed_int:       _stopdeskIdParsed,
        ok: !_isStopdesk_profile
          || (_stopdeskIdParsed != null && Number.isFinite(_stopdeskIdParsed) && _stopdeskIdParsed > 0),
      },
    },
  });
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    created = await adapter.createShipment({
      config: providerConfig,
      shipment: shipmentInput,
    });

    // Some providers return only shipment id on create; hydrate tracking/label immediately.
    if (!created.trackingNumber || !(created.labelPdfUrl || created.labelsUrl || created.labelUrl)) {
      try {
        const tracked = await adapter.trackShipment({
          config: providerConfig,
          shipmentId: created.shipmentId,
          trackingNumber: created.trackingNumber,
        });

        created = {
          ...created,
          trackingNumber: tracked.trackingNumber ?? created.trackingNumber,
          labelUrl: tracked.labelUrl ?? created.labelUrl,
          labelsUrl: tracked.labelsUrl ?? created.labelsUrl ?? created.labelUrl,
          labelPdfUrl: tracked.labelPdfUrl ?? created.labelPdfUrl ?? tracked.labelUrl ?? created.labelUrl,
          shipmentStatus: tracked.shipmentStatus === "LABEL_READY" || tracked.labelUrl || tracked.labelsUrl || tracked.labelPdfUrl
            ? "LABEL_READY"
            : created.shipmentStatus,
          rawResponse: {
            ...created.rawResponse,
            trackingLookup: tracked.rawResponse,
          },
        };

        if (created.trackingNumber && !(created.labelPdfUrl || created.labelsUrl || created.labelUrl)) {
          const label = await adapter.getLabel({
            config: providerConfig,
            shipmentId: created.shipmentId,
            trackingNumber: created.trackingNumber,
          });

          created = {
            ...created,
            labelUrl: label.labelUrl ?? created.labelUrl,
            labelsUrl: label.labelUrl ?? created.labelsUrl ?? created.labelUrl,
            labelPdfUrl: label.labelPdfUrl ?? created.labelPdfUrl ?? label.labelUrl ?? created.labelUrl,
            shipmentStatus: (label.labelUrl || label.labelPdfUrl) ? "LABEL_READY" : created.shipmentStatus,
            rawResponse: {
              ...created.rawResponse,
              labelLookup: label.rawResponse,
            },
          };
        }
      } catch (lookupError) {
        console.warn("shipment_post_create_lookup_failed", {
          merchantId,
          orderCheckId,
          provider: preferredAccount.provider,
          shipmentId: created.shipmentId ?? null,
          error: lookupError instanceof Error ? lookupError.message : String(lookupError),
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const yDiag = (error as Record<string, unknown>)._yalidine_diag as Record<string, unknown> | undefined;
    console.error("[shipment-service][DIAG] createShipment FAILED", {
      errorName:    error instanceof Error ? error.name    : typeof error,
      errorMessage: message,
      errorStack:   error instanceof Error ? (error.stack ?? null) : null,
      merchantId,
      orderCheckId,
    });
    const failedRecord = await persistShipmentRecord({
      merchantId,
      orderCheckId,
      accountId: preferredAccount.id,
      provider: preferredAccount.provider,
      shipmentStatus: error instanceof ShipmentWriteUnsupportedError || /requires|unsupported/i.test(message) ? "UNSUPPORTED" : "FAILED",
      shipmentError: message,
      rawResponse: {
        code: error instanceof ShipmentWriteUnsupportedError || /requires|unsupported/i.test(message) ? "SHIPMENT_UNSUPPORTED" : "SHIPMENT_CREATE_FAILED",
        message,
        requestPayload: {
          deliveryType: shipmentInput.deliveryType,
          is_stopdesk: isStopdesk,
          office_id: normalizedOfficeTerritoryId,
          stopdesk_name: row.shipping_stopdesk ?? null,
          wilaya: shipmentInput.customerWilaya,
          commune: shipmentInput.customerCommune,
          customer_first_last: shipmentInput.customerName,
          customer_phone: shipmentInput.customerPhone,
          orderReference: shipmentInput.orderReference,
        },
        diagnostics: {
          timestamp:          yDiag?.timestamp ?? new Date().toISOString(),
          provider:           preferredAccount.provider,
          httpStatus:         yDiag?.httpStatus ?? null,
          rawResponseText:    yDiag?.rawResponseText ?? null,
          parsedResponseJson: yDiag?.parsedResponseJson ?? null,
          requestPayloadJson: yDiag?.requestPayloadJson ?? null,
          errorName:          error instanceof Error ? error.name : typeof error,
          errorMessage:       message,
          errorStack:         error instanceof Error ? (error.stack ?? null) : null,
          merchantId,
          orderId:            shipmentInput.orderReference,
        },
      },
    });

    await enqueueBackgroundJob({
      type: "create_shipment_retry",
      merchantId,
      payload: {
        merchantId,
        orderCheckId,
      },
      runAfter: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });

    return failedRecord;
  }

  try {
    const record = await persistShipmentRecord({
      merchantId,
      orderCheckId,
      accountId: preferredAccount.id,
      provider: created.provider,
      shipmentId: created.shipmentId,
      trackingNumber: created.trackingNumber,
      labelUrl: created.labelUrl,
      labelsUrl: created.labelsUrl ?? created.labelUrl,
      labelPdfUrl: created.labelPdfUrl,
      importId: created.importId,
      shipmentStatus: shipmentStatusFromCreate(created),
      shipmentCreatedAt: new Date().toISOString(),
      rawResponse: created.rawResponse,
    });

    // Shipment data may arrive after an earlier decision sync; queue one more sync so Woo receives shipment/tracking meta.
    await queueWooDecisionResyncWithShipment({
      merchantId,
      orderCheckId,
    });

    await upsertDeliveryOrderFromShipment({
      merchantId,
      accountId: preferredAccount.id,
      provider: created.provider,
      orderCheck: row,
      created,
      shipmentStatus: record.shipment_status,
    });

    await supabase.from("risk_events").insert({
      merchant_id: merchantId,
      order_check_id: orderCheckId,
      event_type: "shipment_created",
      payload: {
        provider: created.provider,
        accountId: preferredAccount.id,
        shipmentId: created.shipmentId ?? null,
        trackingNumber: created.trackingNumber ?? null,
        requestPayload: {
          deliveryType: shipmentInput.deliveryType,
          is_stopdesk: isStopdesk,
          office_id: normalizedOfficeTerritoryId,
          stopdesk_name: row.shipping_stopdesk ?? null,
          wilaya: shipmentInput.customerWilaya,
          commune: shipmentInput.customerCommune,
          customer_first_last: shipmentInput.customerName,
          customer_phone: shipmentInput.customerPhone,
          orderReference: shipmentInput.orderReference,
        },
      },
      created_at: new Date().toISOString(),
    });

    await supabase.from("merchant_notifications").insert({
      merchant_id: merchantId,
      account_id: preferredAccount.id,
      provider: created.provider,
      level: "info",
      event_type: "shipment_created",
      message: created.trackingNumber
        ? `Shipment created. Tracking ${created.trackingNumber}.`
        : "Shipment created successfully.",
      metadata: {
        orderCheckId,
        trackingNumber: created.trackingNumber ?? null,
      },
    });

    await enqueueBackgroundJob({
      type: "send_push_notification",
      merchantId,
      payload: {
        title: "Shipment created",
        body: created.trackingNumber
          ? `Tracking ${created.trackingNumber} is ready.`
          : "Shipment created and awaiting courier updates.",
        url: "/dashboard/shipments",
        data: {
          orderCheckId,
          trackingNumber: created.trackingNumber ?? null,
        },
      },
    });

    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Shipment persistence failed after provider success", {
      merchantId,
      orderCheckId,
      provider: created.provider,
      shipmentId: created.shipmentId ?? null,
      trackingNumber: created.trackingNumber ?? null,
      error: message,
    });

    throw new ShipmentPersistenceError(
      `shipment_persistence_failed_after_provider_success: ${message}`
    );
  }
}
