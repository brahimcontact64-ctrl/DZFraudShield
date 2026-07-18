/**
 * GET /api/v1/admin/marketing-intelligence/regions
 *
 * Wilaya-level delivery statistics, optionally scoped to a product.
 *
 * Query params:
 *   productId   — required if fetching per-product breakdown
 *   merchantId  — filter by merchant (optional)
 *   sortBy      — "gross_sales" | "success_rate" | "total_orders" (default "gross_sales")
 *   limit       — max regions (default 58 = all Algerian wilayas)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase  = createClient();
    const url       = new URL(req.url);
    const productId = url.searchParams.get("productId")  ?? null;
    const merchantId = url.searchParams.get("merchantId") ?? null;
    const sortBy    = url.searchParams.get("sortBy") ?? "gross_sales";
    const limit     = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "58")));

    const sortColumn: Record<string, string> = {
      gross_sales:   "gross_sales",
      success_rate:  "delivery_success_rate",
      total_orders:  "total_orders",
    };
    const sortCol = sortColumn[sortBy] ?? "gross_sales";

    let query = supabase
      .from("marketing_product_wilaya_statistics")
      .select("product_id, merchant_id, wilaya, total_orders, total_units, delivered_orders, returned_orders, refused_orders, cancelled_orders, no_answer_orders, pending_orders, delivery_success_rate, gross_sales, delivered_sales, returned_sales, average_unit_price, first_order_at, last_order_at")
      .is("variant_id", null)
      .order(sortCol, { ascending: false })
      .limit(limit);

    if (productId)  query = query.eq("product_id",  productId);
    if (merchantId) query = query.eq("merchant_id", merchantId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ ok: true, regions: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "regions_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
