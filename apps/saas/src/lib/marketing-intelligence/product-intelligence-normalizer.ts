/**
 * product-intelligence-normalizer.ts
 *
 * Converts raw WooCommerce plugin payloads into normalized internal forms.
 * All normalization is lossy-tolerant: missing fields produce null, never throw.
 *
 * FINGERPRINT FALLBACK:
 *   When a WooCommerce product_id is absent or zero, we generate a deterministic
 *   external_product_id from merchant_id + commerce_source + lower(trim(name)):
 *     "fp:" + hex(sha256(...))
 *   This keeps the UNIQUE constraint stable across repeated submissions of the
 *   same product without a real product ID (e.g., backfill from order_checks).
 */

import { createHash } from "node:crypto";
import type {
  WooCommerceLineItemPayload,
  NormalizedProduct,
  NormalizedVariant,
  NormalizedOrderLine,
  CommerceSource,
} from "./product-intelligence-types";

// ── Sentinel for a missing product ID ────────────────────────────────────────

/**
 * Returns a deterministic product fingerprint when no real external_product_id
 * is available. Safe to use as a UNIQUE key — same inputs always produce same output.
 */
export function makeProductFingerprint(
  merchantId: string,
  commerceSource: string,
  productName: string,
): string {
  const input = `${merchantId}:${commerceSource}:${productName.toLowerCase().trim()}`;
  return "fp:" + createHash("sha256").update(input, "utf8").digest("hex");
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function safeStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

function safeNum(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (isFinite(n)) return n;
  }
  return null;
}

function safeStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

function safeObj(v: unknown): Record<string, string> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const result: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") result[k] = val;
    }
    return result;
  }
  return {};
}

// ── Extract known variation attributes ───────────────────────────────────────

function extractAttributeField(
  attributes: Record<string, string>,
  knownKeys: string[],
): string | null {
  for (const key of knownKeys) {
    const val = attributes[key] ?? attributes[`pa_${key}`] ?? attributes[`attribute_pa_${key}`];
    if (val) return val;
  }
  return null;
}

// ── Normalize product ─────────────────────────────────────────────────────────

export function normalizeProduct(
  merchantId: string,
  commerceSource: CommerceSource,
  item: WooCommerceLineItemPayload,
): NormalizedProduct {
  const rawId = safeStr(item.productId);
  const externalProductId =
    rawId && rawId !== "0"
      ? rawId
      : makeProductFingerprint(merchantId, commerceSource, item.productName);

  const attributes = safeObj(item.attributes);

  return {
    externalProductId,
    parentExternalProductId: safeStr(item.parentProductId),
    sku:                     safeStr(item.sku),
    productName:             item.productName.trim() || "Unknown Product",
    productSlug:             safeStr(item.productSlug),
    categoryId:              safeStr(item.categoryId),
    categoryName:            safeStr(item.categoryName),
    brand:                   safeStr(item.brand),
    tags:                    safeStrArr(item.tags),
    productType:             safeStr(item.productType),
    primaryImageUrl:         safeStr(item.primaryImageUrl),
    galleryImageUrls:        safeStrArr(item.galleryImageUrls),
    regularPrice:            safeNum(item.regularPrice),
    salePrice:               safeNum(item.salePrice),
    currency:                safeStr(item.currency),
    attributes,
  };
}

// ── Normalize variant ─────────────────────────────────────────────────────────

export function normalizeVariant(
  item: WooCommerceLineItemPayload,
): NormalizedVariant | null {
  const rawVarId = safeStr(item.variationId);
  if (!rawVarId || rawVarId === "0") return null;

  const attributes = safeObj(item.attributes);

  return {
    externalVariationId: rawVarId,
    sku:                 safeStr(item.sku),
    variationName:       safeStr(item.variationName),
    color:               safeStr(item.color) ?? extractAttributeField(attributes, ["color", "colour"]),
    size:                safeStr(item.size)  ?? extractAttributeField(attributes, ["size", "taille"]),
    material:            safeStr(item.material) ?? extractAttributeField(attributes, ["material", "matiere"]),
    attributes,
    regularPrice:        safeNum(item.regularPrice),
    salePrice:           safeNum(item.salePrice),
    primaryImageUrl:     safeStr(item.primaryImageUrl),
  };
}

// ── Normalize order line ──────────────────────────────────────────────────────

export function normalizeOrderLine(
  merchantId: string,
  commerceSource: CommerceSource,
  orderId: string,
  orderDate: string | null,
  wilaya: string | null,
  commune: string | null,
  deliveryType: string | null,
  shippingProvider: string | null,
  tracking: string | null,
  item: WooCommerceLineItemPayload,
): NormalizedOrderLine {
  const rawProductId = safeStr(item.productId);
  const externalProductId =
    rawProductId && rawProductId !== "0"
      ? rawProductId
      : makeProductFingerprint(merchantId, commerceSource, item.productName);

  const rawVarId = safeStr(item.variationId);
  const externalVariationId = rawVarId && rawVarId !== "0" ? rawVarId : null;

  const qty     = Math.max(1, Math.round(item.quantity ?? 1));
  const lineTotal = safeNum(item.lineTotal);
  const lineSubtotal = safeNum(item.lineSubtotal);
  const unitPrice   = lineTotal !== null && qty > 0 ? lineTotal / qty : null;
  const discount    = safeNum(item.discountAmount)
    ?? (lineSubtotal !== null && lineTotal !== null ? lineSubtotal - lineTotal : null);

  return {
    externalOrderId:      orderId,
    externalLineItemId:   item.lineItemId,
    commerceSource,
    externalProductId,
    externalVariationId,
    skuSnapshot:          safeStr(item.sku),
    productNameSnapshot:  item.productName.trim() || "Unknown Product",
    categorySnapshot:     safeStr(item.categoryName),
    brandSnapshot:        safeStr(item.brand),
    imageUrlSnapshot:     safeStr(item.primaryImageUrl),
    attributesSnapshot:   safeObj(item.attributes),
    quantity:             qty,
    unitPrice,
    regularPriceSnapshot: safeNum(item.regularPrice),
    salePriceSnapshot:    safeNum(item.salePrice),
    lineSubtotal,
    lineTotal,
    discountAmount:       discount,
    currency:             safeStr(item.currency),
    deliveryProvider:     safeStr(shippingProvider),
    tracking:             safeStr(tracking),
    wilaya:               safeStr(wilaya),
    commune:              safeStr(commune),
    deliveryType:         deliveryType === "stopdesk" ? "stopdesk" : deliveryType === "home" ? "home" : null,
    isStopdesk:           deliveryType === "stopdesk" ? true : deliveryType === "home" ? false : null,
    deliveryStatus:       null,
    deliveryOutcome:      null,
    orderDate,
  };
}
