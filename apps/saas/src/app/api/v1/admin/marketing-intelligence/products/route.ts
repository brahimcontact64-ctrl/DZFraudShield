/**
 * GET /api/v1/admin/marketing-intelligence/products
 *
 * Paginated product list with aggregated statistics.
 *
 * Query params:
 *   page        — 1-based page number (default 1)
 *   pageSize    — rows per page (default 20, max 100)
 *   merchantId  — filter by specific merchant (optional)
 *   sortBy      — "gross_sales" | "success_rate" | "total_orders" (default "gross_sales")
 *   category    — filter by category_name
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient();
    const url       = new URL(req.url);
    const page      = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize  = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") ?? "20")));
    const merchantId = url.searchParams.get("merchantId") ?? null;
    const sortBy    = url.searchParams.get("sortBy") ?? "gross_sales";
    const category  = url.searchParams.get("category") ?? null;

    const offset = (page - 1) * pageSize;

    // Resolve sort column
    const sortColumn: Record<string, string> = {
      gross_sales:   "gross_sales",
      success_rate:  "delivery_success_rate",
      total_orders:  "total_orders",
    };
    const sortCol = sortColumn[sortBy] ?? "gross_sales";

    // Query statistics (product-level, no variant breakdown)
    let statsQuery = supabase
      .from("marketing_product_statistics")
      .select("product_id, merchant_id, total_orders, total_units, delivered_orders, returned_orders, refused_orders, cancelled_orders, no_answer_orders, pending_orders, delivery_success_rate, gross_sales, delivered_sales, returned_sales, average_unit_price, best_wilaya, worst_wilaya, top_wilayas, first_order_at, last_order_at", { count: "exact" })
      .is("variant_id", null)
      .order(sortCol, { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (merchantId) statsQuery = statsQuery.eq("merchant_id", merchantId);

    const { data: statsRows, count: totalCount, error: statsErr } = await statsQuery;
    if (statsErr) throw statsErr;

    const rows = (statsRows ?? []) as Record<string, unknown>[];

    // Enrich with product metadata
    const productIds = rows.map((r) => r.product_id as string);

    if (productIds.length === 0) {
      return NextResponse.json({ ok: true, products: [], total: 0, page, pageSize });
    }

    let productQuery = supabase
      .from("marketing_products")
      .select("id, merchant_id, product_name, category_name, brand, primary_image_url, sku, first_seen_at")
      .in("id", productIds);

    if (category) productQuery = productQuery.eq("category_name", category);

    const { data: productRows } = await productQuery;

    const productMap = new Map(
      ((productRows ?? []) as Array<{ id: string; [k: string]: unknown }>).map((p) => [p.id, p]),
    );

    const products = rows.map((r) => {
      const p = productMap.get(r.product_id as string);
      return {
        ...r,
        productName:   p?.product_name    ?? null,
        categoryName:  p?.category_name   ?? null,
        brand:         p?.brand           ?? null,
        imageUrl:      p?.primary_image_url ?? null,
        sku:           p?.sku             ?? null,
        firstSeenAt:   p?.first_seen_at   ?? null,
      };
    });

    return NextResponse.json({
      ok: true,
      products,
      total:    totalCount ?? 0,
      page,
      pageSize,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "products_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
