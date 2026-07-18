/**
 * POST /api/v1/plugin/product-intel
 *
 * Receives enriched product line-item data from the WooCommerce plugin and
 * ingests it into the Marketing Intelligence subsystem.
 *
 * AUTHENTICATION: same API key used for /api/v1/check-order
 * ISOLATION: failures here never affect primary order processing
 * ADMIN-ONLY: no merchant-visible response data; returns only a receipt
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { ingestProductIntelPayload } from "@/lib/marketing-intelligence/product-intelligence-writer";

// ── Request schema ────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
  lineItemId:       z.string().max(100),
  productId:        z.string().max(100).nullable().optional(),
  variationId:      z.string().max(100).nullable().optional(),
  sku:              z.string().max(200).nullable().optional(),
  productName:      z.string().min(1).max(500),
  productSlug:      z.string().max(300).nullable().optional(),
  parentProductId:  z.string().max(100).nullable().optional(),
  productType:      z.string().max(80).nullable().optional(),
  categoryId:       z.string().max(100).nullable().optional(),
  categoryName:     z.string().max(200).nullable().optional(),
  brand:            z.string().max(200).nullable().optional(),
  tags:             z.array(z.string().max(100)).max(30).default([]),
  primaryImageUrl:  z.string().url().max(2000).nullable().optional(),
  galleryImageUrls: z.array(z.string().url().max(2000)).max(20).default([]),
  variationName:    z.string().max(300).nullable().optional(),
  attributes:       z.record(z.string().max(200)).default({}),
  color:            z.string().max(100).nullable().optional(),
  size:             z.string().max(100).nullable().optional(),
  material:         z.string().max(100).nullable().optional(),
  regularPrice:     z.number().nonnegative().nullable().optional(),
  salePrice:        z.number().nonnegative().nullable().optional(),
  quantity:         z.number().int().positive(),
  lineSubtotal:     z.number().nonnegative().nullable().optional(),
  lineTotal:        z.number().nonnegative().nullable().optional(),
  discountAmount:   z.number().nonnegative().nullable().optional(),
  currency:         z.string().max(10).nullable().optional(),
});

const productIntelRequestSchema = z.object({
  orderId:          z.string().min(1).max(100),
  orderDate:        z.string().datetime().nullable().optional(),
  wilaya:           z.string().max(120).nullable().optional(),
  commune:          z.string().max(120).nullable().optional(),
  deliveryType:     z.enum(["home", "stopdesk"]).nullable().optional(),
  shippingProvider: z.string().max(80).nullable().optional(),
  tracking:         z.string().max(100).nullable().optional(),
  lineItems:        z.array(lineItemSchema).min(1).max(50),
});

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth — same pattern as check-order
  const auth = await requireApiKeyAuth(req, "product-intel");
  if (!auth.ok) {
    return auth.response;
  }

  const merchantId = auth.keyRecord.merchant_id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = productIntelRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", details: parsed.error.issues }, { status: 400 });
  }

  const data = parsed.data;

  const payload = {
    orderId:          data.orderId,
    orderDate:        data.orderDate ?? null,
    wilaya:           data.wilaya    ?? null,
    commune:          data.commune   ?? null,
    deliveryType:     data.deliveryType ?? null,
    shippingProvider: data.shippingProvider ?? null,
    tracking:         data.tracking   ?? null,
    lineItems: data.lineItems.map((item) => ({
      lineItemId:       item.lineItemId,
      productId:        item.productId    ?? null,
      variationId:      item.variationId  ?? null,
      sku:              item.sku          ?? null,
      productName:      item.productName,
      productSlug:      item.productSlug  ?? null,
      parentProductId:  item.parentProductId ?? null,
      productType:      item.productType  ?? null,
      categoryId:       item.categoryId   ?? null,
      categoryName:     item.categoryName ?? null,
      brand:            item.brand        ?? null,
      tags:             item.tags,
      primaryImageUrl:  item.primaryImageUrl  ?? null,
      galleryImageUrls: item.galleryImageUrls,
      variationName:    item.variationName ?? null,
      attributes:       item.attributes,
      color:            item.color     ?? null,
      size:             item.size      ?? null,
      material:         item.material  ?? null,
      regularPrice:     item.regularPrice ?? null,
      salePrice:        item.salePrice    ?? null,
      quantity:         item.quantity,
      lineSubtotal:     item.lineSubtotal ?? null,
      lineTotal:        item.lineTotal    ?? null,
      discountAmount:   item.discountAmount ?? null,
      currency:         item.currency   ?? null,
    })),
  };

  // Non-fatal: ingest errors are counted in result, never throw to the caller
  try {
    const result = await ingestProductIntelPayload(merchantId, "woocommerce", payload);
    return NextResponse.json({
      ok:                true,
      productsUpserted:  result.productsUpserted,
      orderLinesUpserted: result.orderLinesUpserted,
      errors:            result.errors,
    });
  } catch (err) {
    // Should never reach here — ingestProductIntelPayload is non-fatal internally
    console.error("[product-intel] ingest threw unexpectedly", {
      merchantId,
      orderId: data.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false, error: "ingestion_failed" }, { status: 200 });
  }
}
