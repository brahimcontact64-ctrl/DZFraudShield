/**
 * product-intelligence-backfill.ts
 *
 * Cursor-based, resumable backfill that converts historical order_checks rows
 * into marketing intelligence order lines.
 *
 * DATA AVAILABLE IN BACKFILL:
 *   order_checks has: order_id (WC), wilaya, shipping_type, product_items
 *     [{productName, quantity, itemTotal}]
 *   Fields unavailable from old orders: product_id, SKU, category, images,
 *   variation data. These are stored as null; the product fingerprint fallback
 *   (makeProductFingerprint) creates a stable external_product_id from name.
 *
 * DELIVERY OUTCOME ENRICHMENT:
 *   The backfill reads merchant_shipments (tracking_number) and then
 *   merchant_shipment_history (normalized_outcome, normalized_status) by
 *   wc_order_id or tracking_number so terminal outcomes are captured at
 *   backfill time rather than waiting for the enrich job.
 *
 * CURSOR DESIGN:
 *   Cursor is the created_at of the last processed order_checks row, stored
 *   in marketing_ingestion_log.backfill_cursor. Each job processes
 *   BACKFILL_BATCH_SIZE rows and then enqueues the next chunk job. When no
 *   more rows exist, backfill_status is set to "completed".
 *
 * NON-FATAL:
 *   Errors per order check are counted and logged but never abort the batch.
 */

import { createClient } from "@/lib/supabase/server";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { ingestProductIntelPayload } from "./product-intelligence-writer";
import type { ProductIntelPayload, WooCommerceLineItemPayload } from "./product-intelligence-types";

const BACKFILL_BATCH_SIZE = 50;
const COMMERCE_SOURCE = "woocommerce" as const;

// ── DB row types ──────────────────────────────────────────────────────────────

type OrderCheckRow = {
  id:               string;
  order_id:         string | null;
  external_order_id: string | null;
  created_at:       string;
  wilaya:           string | null;
  shipping_wilaya:  string | null;
  shipping_commune: string | null;
  shipping_type:    string | null;
  product_items:    ProductItemJson[] | null;
};

type ProductItemJson = {
  productName?: string;
  quantity?:    number;
  itemTotal?:   number;
};

type ShipmentRow = {
  order_check_id: string | null;
  tracking_number: string | null;
  provider:        string | null;
};

type MshRow = {
  tracking:          string;
  wc_order_id:       string | null;
  normalized_outcome: string | null;
  normalized_status:  string | null;
  wilaya_name:        string | null;
  commune_name:       string | null;
  is_stopdesk:        boolean | null;
  date_last_status:   string | null;
};

// ── Ingestion log updater ─────────────────────────────────────────────────────

async function updateIngestionLog(params: {
  merchantId:       string;
  cursor?:          string | null;
  status:           "running" | "completed" | "failed";
  linesImported?:   number;
  lastError?:       string | null;
}): Promise<void> {
  try {
    const supabase = createClient();
    const ts = new Date().toISOString();
    const upsertPayload: Record<string, unknown> = {
      merchant_id:     params.merchantId,
      commerce_source: COMMERCE_SOURCE,
      backfill_status: params.status,
      updated_at:      ts,
    };
    if (params.cursor !== undefined) {
      upsertPayload["backfill_cursor"] = params.cursor;
    }
    if (params.status === "completed") {
      upsertPayload["last_backfill_at"] = ts;
    }
    if (params.linesImported !== undefined && params.linesImported > 0) {
      upsertPayload["order_lines_imported"] = params.linesImported;
    }
    if (params.lastError !== undefined) {
      upsertPayload["last_error"] = params.lastError;
    }
    await supabase
      .from("marketing_ingestion_log")
      .upsert(upsertPayload, { onConflict: "merchant_id,commerce_source", ignoreDuplicates: false });
  } catch {
    // Non-fatal: log writes are observability only
  }
}

// ── Main backfill function ────────────────────────────────────────────────────

export type BackfillResult = {
  processed:    number;
  ingested:     number;
  errors:       number;
  hasMore:      boolean;
  nextCursor:   string | null;
};

export async function runMarketingIntelligenceBackfill(params: {
  merchantId: string;
  cursor?:    string | null;  // ISO timestamp — process rows created AFTER this time
}): Promise<BackfillResult> {
  const { merchantId, cursor } = params;
  const supabase = createClient();

  const result: BackfillResult = {
    processed: 0, ingested: 0, errors: 0, hasMore: false, nextCursor: cursor ?? null,
  };

  // ── 1. Load a batch of order_checks rows ─────────────────────────────────

  let query = supabase
    .from("order_checks")
    .select("id, order_id, external_order_id, created_at, wilaya, shipping_wilaya, shipping_commune, shipping_type, product_items")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true })
    .limit(BACKFILL_BATCH_SIZE + 1); // +1 to detect if more exist

  if (cursor) {
    query = query.gt("created_at", cursor);
  }

  const { data: checkRows, error: checkErr } = await query;

  if (checkErr) {
    console.error("[pi-backfill] order_checks fetch failed", { merchantId, error: checkErr.message });
    await updateIngestionLog({ merchantId, status: "failed", lastError: checkErr.message });
    result.errors++;
    return result;
  }

  const rows = (checkRows ?? []) as OrderCheckRow[];
  result.hasMore = rows.length > BACKFILL_BATCH_SIZE;
  const batch = rows.slice(0, BACKFILL_BATCH_SIZE);

  if (batch.length === 0) {
    await updateIngestionLog({ merchantId, status: "completed", cursor: null });
    return result;
  }

  // ── 2. Load merchant_shipments for this batch (tracking_number) ──────────

  const orderCheckIds = batch.map((r) => r.id);

  const { data: shipmentRows } = await supabase
    .from("merchant_shipments")
    .select("order_check_id, tracking_number, provider")
    .eq("merchant_id", merchantId)
    .in("order_check_id", orderCheckIds);

  // Map: order_check_id → {tracking, provider}
  const shipmentByCheckId = new Map<string, { tracking: string; provider: string }>();
  for (const s of (shipmentRows ?? []) as ShipmentRow[]) {
    if (s.order_check_id && s.tracking_number) {
      shipmentByCheckId.set(s.order_check_id, {
        tracking: s.tracking_number,
        provider: s.provider ?? "yalidine",
      });
    }
  }

  // ── 3. Load MSH for known tracking numbers ────────────────────────────────

  const trackingNumbers = [...new Set(
    [...shipmentByCheckId.values()].map((s) => s.tracking),
  )];

  const mshByTracking = new Map<string, MshRow>();

  if (trackingNumbers.length > 0) {
    const { data: mshRows } = await supabase
      .from("merchant_shipment_history")
      .select("tracking, wc_order_id, normalized_outcome, normalized_status, wilaya_name, commune_name, is_stopdesk, date_last_status")
      .eq("merchant_id", merchantId)
      .in("tracking", trackingNumbers);

    for (const m of (mshRows ?? []) as MshRow[]) {
      if (m.tracking) mshByTracking.set(m.tracking, m);
    }
  }

  // ── 4. Ingest each row ────────────────────────────────────────────────────

  let lastCreatedAt: string | null = null;

  for (const check of batch) {
    try {
      const items = Array.isArray(check.product_items) ? check.product_items : [];
      if (items.length === 0) {
        result.processed++;
        lastCreatedAt = check.created_at;
        continue;
      }

      const shipment = shipmentByCheckId.get(check.id) ?? null;
      const msh      = shipment ? mshByTracking.get(shipment.tracking) ?? null : null;

      const wilaya  = msh?.wilaya_name ?? check.shipping_wilaya ?? check.wilaya ?? null;
      const commune = msh?.commune_name ?? check.shipping_commune ?? null;
      const isStopdesk = msh?.is_stopdesk ?? null;
      const deliveryType: "home" | "stopdesk" | null =
        isStopdesk === true
          ? "stopdesk"
          : isStopdesk === false
          ? "home"
          : (check.shipping_type === "stopdesk" ? "stopdesk" : check.shipping_type === "home" ? "home" : null);

      // Stable external order ID: prefer real WC order ID, fall back to check UUID
      const externalOrderId = check.order_id ?? check.external_order_id ?? check.id;

      const lineItems: WooCommerceLineItemPayload[] = items.map((item, idx) => ({
        lineItemId:           `${check.id}:${idx}`, // synthetic — stable per check+position
        productId:            null,                  // not available in legacy order_checks
        variationId:          null,
        sku:                  null,
        productName:          String(item.productName ?? "Unknown Product").trim() || "Unknown Product",
        productSlug:          null,
        parentProductId:      null,
        productType:          null,
        categoryId:           null,
        categoryName:         null,
        brand:                null,
        tags:                 [],
        primaryImageUrl:      null,
        galleryImageUrls:     [],
        variationName:        null,
        attributes:           {},
        color:                null,
        size:                 null,
        material:             null,
        regularPrice:         null,
        salePrice:            null,
        quantity:             Math.max(1, Math.round(Number(item.quantity) || 1)),
        lineSubtotal:         null,
        lineTotal:            Number(item.itemTotal) || null,
        discountAmount:       null,
        currency:             null,
      }));

      const payload: ProductIntelPayload = {
        orderId:          externalOrderId,
        orderDate:        check.created_at,
        wilaya,
        commune,
        deliveryType,
        shippingProvider: shipment?.provider ?? null,
        tracking:         shipment?.tracking ?? null,
        lineItems,
      };

      const ingested = await ingestProductIntelPayload(merchantId, COMMERCE_SOURCE, payload);
      result.ingested += ingested.orderLinesUpserted;
      result.errors   += ingested.errors;

    } catch (err) {
      result.errors++;
      console.error("[pi-backfill] order check ingestion failed", {
        merchantId,
        checkId: check.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    result.processed++;
    lastCreatedAt = check.created_at;
  }

  result.nextCursor = lastCreatedAt;

  // ── 5. Update cursor and status ───────────────────────────────────────────

  await updateIngestionLog({
    merchantId,
    cursor:       result.hasMore ? result.nextCursor : null,
    status:       result.hasMore ? "running" : "completed",
    linesImported: result.ingested,
    lastError:    result.errors > 0 ? `${result.errors} errors in batch` : null,
  });

  // ── 6. Enqueue next chunk if more rows remain ─────────────────────────────

  if (result.hasMore && result.nextCursor) {
    await enqueueBackgroundJob({
      type:       "marketing_intelligence_backfill",
      merchantId,
      payload:    { merchantId, cursor: result.nextCursor },
      // 10-second delay between chunks to avoid overwhelming the DB
      runAfter:   new Date(Date.now() + 10_000).toISOString(),
    });
  }

  return result;
}
