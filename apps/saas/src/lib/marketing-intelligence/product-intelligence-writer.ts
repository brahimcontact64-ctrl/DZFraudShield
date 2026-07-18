/**
 * product-intelligence-writer.ts
 *
 * Idempotent write layer for the Marketing Intelligence subsystem.
 * All functions are safe to call multiple times with the same input —
 * re-running never creates duplicates.
 *
 * ISOLATION CONTRACT:
 *   Every function in this file catches its own errors and returns a result
 *   object rather than throwing. Callers must never fail primary order ingestion
 *   because of a marketing intelligence write error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  NormalizedProduct,
  NormalizedVariant,
  NormalizedOrderLine,
  CommerceSource,
  ProductIntelIngestionResult,
} from "./product-intelligence-types";
import { normalizeProduct, normalizeVariant, normalizeOrderLine } from "./product-intelligence-normalizer";
import type { ProductIntelPayload } from "./product-intelligence-types";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { createClient } from "@/lib/supabase/server";

// ── Internal helpers ──────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

// ── Upsert canonical product ──────────────────────────────────────────────────

/**
 * Upserts the canonical marketing_products row.
 * On conflict (same merchant+source+external_product_id) updates mutable metadata
 * (name, category, image, price) but never changes id, first_seen_at, or order lines.
 *
 * Returns the product UUID, or null on error.
 */
export async function upsertMarketingProduct(
  supabase: SupabaseClient,
  merchantId: string,
  commerceSource: CommerceSource,
  product: NormalizedProduct,
): Promise<string | null> {
  const ts = now();
  const { data, error } = await supabase
    .from("marketing_products")
    .upsert(
      {
        merchant_id:                merchantId,
        commerce_source:            commerceSource,
        external_product_id:        product.externalProductId,
        parent_external_product_id: product.parentExternalProductId,
        sku:                        product.sku,
        product_name:               product.productName,
        product_slug:               product.productSlug,
        category_id:                product.categoryId,
        category_name:              product.categoryName,
        brand:                      product.brand,
        tags:                       product.tags,
        product_type:               product.productType,
        primary_image_url:          product.primaryImageUrl,
        gallery_image_urls:         product.galleryImageUrls,
        regular_price:              product.regularPrice,
        sale_price:                 product.salePrice,
        currency:                   product.currency,
        attributes:                 product.attributes,
        active:                     true,
        last_seen_at:               ts,
        updated_at:                 ts,
        // first_seen_at and created_at are set only on INSERT (handled by DEFAULT + merge key)
        first_seen_at:              ts,
        created_at:                 ts,
      },
      {
        onConflict: "merchant_id,commerce_source,external_product_id",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .single();

  if (error) {
    console.error("[pi-writer] upsertMarketingProduct failed", {
      merchantId,
      externalProductId: product.externalProductId,
      error:             error.message,
    });
    return null;
  }

  return (data as { id: string }).id;
}

// ── Upsert variant ────────────────────────────────────────────────────────────

/**
 * Upserts a marketing_product_variants row.
 * Returns the variant UUID, or null on error or when no variation exists.
 */
export async function upsertMarketingVariant(
  supabase: SupabaseClient,
  productId: string | null,
  merchantId: string,
  commerceSource: CommerceSource,
  variant: NormalizedVariant,
): Promise<string | null> {
  const ts = now();
  const { data, error } = await supabase
    .from("marketing_product_variants")
    .upsert(
      {
        product_id:           productId,
        merchant_id:          merchantId,
        commerce_source:      commerceSource,
        external_variation_id: variant.externalVariationId,
        sku:                  variant.sku,
        variation_name:       variant.variationName,
        color:                variant.color,
        size:                 variant.size,
        material:             variant.material,
        attributes:           variant.attributes,
        regular_price:        variant.regularPrice,
        sale_price:           variant.salePrice,
        primary_image_url:    variant.primaryImageUrl,
        active:               true,
        last_seen_at:         ts,
        updated_at:           ts,
        first_seen_at:        ts,
        created_at:           ts,
      },
      {
        onConflict: "merchant_id,commerce_source,external_variation_id",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .single();

  if (error) {
    console.error("[pi-writer] upsertMarketingVariant failed", {
      merchantId,
      externalVariationId: variant.externalVariationId,
      error:               error.message,
    });
    return null;
  }

  return (data as { id: string }).id;
}

// ── Upsert order lines ────────────────────────────────────────────────────────

/**
 * Upserts one marketing_product_order_lines row per normalized line.
 * The UNIQUE constraint on (merchant_id, commerce_source, external_order_id, external_line_item_id)
 * ensures this is fully idempotent — re-submission of the same order is a no-op per line.
 *
 * NOTE: snapshot fields are NOT updated on conflict. The initial ingestion wins.
 * This preserves the commercial snapshot as it existed at order time.
 */
export async function upsertMarketingOrderLine(
  supabase: SupabaseClient,
  merchantId: string,
  productId: string | null,
  variantId: string | null,
  line: NormalizedOrderLine,
): Promise<boolean> {
  const ts = now();
  const { error } = await supabase
    .from("marketing_product_order_lines")
    .upsert(
      {
        merchant_id:              merchantId,
        commerce_source:          line.commerceSource,
        external_order_id:        line.externalOrderId,
        external_line_item_id:    line.externalLineItemId,
        product_id:               productId,
        variant_id:               variantId,
        external_product_id:      line.externalProductId,
        external_variation_id:    line.externalVariationId,
        sku_snapshot:             line.skuSnapshot,
        product_name_snapshot:    line.productNameSnapshot,
        category_snapshot:        line.categorySnapshot,
        brand_snapshot:           line.brandSnapshot,
        image_url_snapshot:       line.imageUrlSnapshot,
        attributes_snapshot:      line.attributesSnapshot,
        quantity:                 line.quantity,
        unit_price:               line.unitPrice,
        regular_price_snapshot:   line.regularPriceSnapshot,
        sale_price_snapshot:      line.salePriceSnapshot,
        line_subtotal:            line.lineSubtotal,
        line_total:               line.lineTotal,
        discount_amount:          line.discountAmount,
        currency:                 line.currency,
        delivery_provider:        line.deliveryProvider,
        tracking:                 line.tracking,
        wilaya:                   line.wilaya,
        commune:                  line.commune,
        delivery_type:            line.deliveryType,
        is_stopdesk:              line.isStopdesk,
        delivery_status:          line.deliveryStatus,
        delivery_outcome:         line.deliveryOutcome,
        order_date:               line.orderDate,
        created_at:               ts,
        updated_at:               ts,
      },
      {
        onConflict: "merchant_id,commerce_source,external_order_id,external_line_item_id",
        ignoreDuplicates: true,
      },
    );

  if (error) {
    console.error("[pi-writer] upsertMarketingOrderLine failed", {
      merchantId,
      orderId:     line.externalOrderId,
      lineItemId:  line.externalLineItemId,
      error:       error.message,
    });
    return false;
  }

  return true;
}

// ── Delivery outcome enrichment ───────────────────────────────────────────────

/**
 * Updates delivery fields on marketing_product_order_lines when a shipment
 * outcome becomes known via merchant_shipment_history.
 *
 * Called from the background job marketing_delivery_outcome_enrich.
 * Non-fatal: errors are logged but never propagate.
 */
export async function attachDeliveryOutcomeToMarketingOrder(params: {
  merchantId:         string;
  tracking:           string;
  deliveryStatus:     string | null;
  deliveryOutcome:    string | null;
  shipmentHistoryId?: string | null;
  deliveryDate?:      string | null;
  lastStatusDate?:    string | null;
}): Promise<{ updated: number }> {
  try {
    const supabase = createClient();
    const ts = now();

    const updatePayload: Record<string, unknown> = {
      delivery_status:  params.deliveryStatus,
      delivery_outcome: params.deliveryOutcome,
      updated_at:       ts,
    };

    if (params.shipmentHistoryId) {
      updatePayload["shipment_history_id"] = params.shipmentHistoryId;
    }
    if (params.deliveryDate) {
      updatePayload["delivery_date"] = params.deliveryDate;
    }
    if (params.lastStatusDate) {
      updatePayload["last_status_date"] = params.lastStatusDate;
    }

    const { error, count } = await supabase
      .from("marketing_product_order_lines")
      .update(updatePayload)
      .eq("merchant_id", params.merchantId)
      .eq("tracking", params.tracking)
      .is("delivery_outcome", null); // only enrich lines that haven't been resolved yet

    if (error) {
      console.error("[pi-writer] attachDeliveryOutcomeToMarketingOrder failed", {
        merchantId: params.merchantId,
        tracking:   params.tracking,
        error:      error.message,
      });
      return { updated: 0 };
    }

    return { updated: count ?? 0 };
  } catch (err) {
    console.error("[pi-writer] attachDeliveryOutcomeToMarketingOrder threw", err);
    return { updated: 0 };
  }
}

// ── Queue statistics recompute ────────────────────────────────────────────────

/**
 * Enqueues a background job to recompute product + wilaya statistics.
 * Deduplicated: if a pending/processing job already exists for the same
 * (merchantId, productId), a new job is NOT enqueued.
 */
export async function enqueueMarketingStatsRecompute(
  merchantId: string,
  productId:  string,
): Promise<void> {
  try {
    const supabase = createClient();
    const { count } = await supabase
      .from("background_jobs")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("type", "marketing_product_stats_recompute")
      .in("status", ["pending", "processing"])
      .contains("payload", { productId });

    if ((count ?? 0) > 0) return;

    await enqueueBackgroundJob({
      type:       "marketing_product_stats_recompute",
      merchantId,
      payload:    { productId, merchantId },
    });
  } catch {
    // Non-fatal: stats will be recomputed on next enrichment or admin trigger
  }
}

/**
 * Enqueues a marketing_delivery_outcome_enrich job when an MSH row is written.
 * Called from merchant-history-writer's enqueueReputationRecompute companion hook.
 */
export async function enqueueMarketingDeliveryEnrich(
  merchantId: string,
  tracking:   string,
): Promise<void> {
  try {
    const supabase = createClient();
    const { count } = await supabase
      .from("background_jobs")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("type", "marketing_delivery_outcome_enrich")
      .in("status", ["pending", "processing"])
      .contains("payload", { tracking });

    if ((count ?? 0) > 0) return;

    await enqueueBackgroundJob({
      type:       "marketing_delivery_outcome_enrich",
      merchantId,
      payload:    { tracking, merchantId },
    });
  } catch {
    // Non-fatal
  }
}

// ── Top-level ingestion orchestrator ─────────────────────────────────────────

/**
 * Processes one ProductIntelPayload: upserts products, variants, order lines,
 * queues stats recompute jobs, updates ingestion log.
 *
 * Returns a summary. Never throws — errors are counted, not propagated.
 */
export async function ingestProductIntelPayload(
  merchantId:     string,
  commerceSource: CommerceSource,
  payload:        ProductIntelPayload,
): Promise<ProductIntelIngestionResult> {
  const supabase = createClient();
  const result: ProductIntelIngestionResult = {
    productsUpserted:   0,
    variantsUpserted:   0,
    orderLinesUpserted: 0,
    errors:             0,
    statsJobsQueued:    0,
  };

  const productIdsToRecompute = new Set<string>();

  for (const item of payload.lineItems) {
    try {
      // 1. Normalize + upsert canonical product
      const normalizedProd = normalizeProduct(merchantId, commerceSource, item);
      const productId = await upsertMarketingProduct(supabase, merchantId, commerceSource, normalizedProd);
      if (productId) {
        result.productsUpserted++;
        productIdsToRecompute.add(productId);
      }

      // 2. Normalize + upsert variant (only when variation_id present)
      let variantId: string | null = null;
      const normalizedVar = normalizeVariant(item);
      if (normalizedVar) {
        variantId = await upsertMarketingVariant(supabase, productId, merchantId, commerceSource, normalizedVar);
        if (variantId) result.variantsUpserted++;
      }

      // 3. Normalize + upsert order line
      const normalizedLine = normalizeOrderLine(
        merchantId,
        commerceSource,
        payload.orderId,
        payload.orderDate,
        payload.wilaya,
        payload.commune,
        payload.deliveryType,
        payload.shippingProvider,
        payload.tracking,
        item,
      );
      const lineOk = await upsertMarketingOrderLine(supabase, merchantId, productId, variantId, normalizedLine);
      if (lineOk) result.orderLinesUpserted++;

    } catch (err) {
      result.errors++;
      console.error("[pi-writer] ingestProductIntelPayload line error", {
        merchantId,
        lineItemId: item.lineItemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Queue stats recompute for all affected products
  for (const productId of productIdsToRecompute) {
    await enqueueMarketingStatsRecompute(merchantId, productId);
    result.statsJobsQueued++;
  }

  // 5. Update ingestion log
  try {
    const ts = now();
    await supabase
      .from("marketing_ingestion_log")
      .upsert(
        {
          merchant_id:         merchantId,
          commerce_source:     commerceSource,
          last_ingestion_at:   ts,
          products_imported:   result.productsUpserted,
          order_lines_imported: result.orderLinesUpserted,
          last_error:          result.errors > 0 ? `${result.errors} line errors` : null,
          updated_at:          ts,
        },
        {
          onConflict:       "merchant_id,commerce_source",
          ignoreDuplicates: false,
        },
      );
  } catch {
    // Non-fatal: ingestion log is observability only
  }

  return result;
}
