/**
 * GET /api/v1/admin/marketing-intelligence/stats
 *
 * Overview metrics: top products by gross sales, top by success rate,
 * total products, total order lines, total merchants with ingestion data.
 *
 * Query params:
 *   limit   — max products per ranking list (default 10)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient();
    const url      = new URL(req.url);
    const limit    = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? "10")));

    const [
      totalProductsResult,
      totalLinesResult,
      totalMerchantsResult,
      topBySalesResult,
      topBySuccessResult,
    ] = await Promise.all([
      supabase
        .from("marketing_products")
        .select("id", { count: "exact", head: true }),

      supabase
        .from("marketing_product_order_lines")
        .select("id", { count: "exact", head: true }),

      supabase
        .from("marketing_ingestion_log")
        .select("merchant_id", { count: "exact", head: true }),

      supabase
        .from("marketing_product_statistics")
        .select("product_id, gross_sales, delivered_sales, total_orders, delivered_orders, delivery_success_rate")
        .is("variant_id", null)
        .order("gross_sales", { ascending: false })
        .limit(limit),

      supabase
        .from("marketing_product_statistics")
        .select("product_id, delivery_success_rate, total_orders, delivered_orders, gross_sales")
        .is("variant_id", null)
        .gte("total_orders", 3) // at least 3 orders for meaningful rate
        .order("delivery_success_rate", { ascending: false })
        .limit(limit),
    ]);

    // Enrich with product names
    const allProductIds = [
      ...new Set([
        ...(topBySalesResult.data ?? []).map((r: Record<string, unknown>) => r.product_id as string),
        ...(topBySuccessResult.data ?? []).map((r: Record<string, unknown>) => r.product_id as string),
      ]),
    ];

    const { data: productNames } = allProductIds.length > 0
      ? await supabase
          .from("marketing_products")
          .select("id, product_name, category_name, primary_image_url")
          .in("id", allProductIds)
      : { data: [] };

    const nameMap = new Map(
      ((productNames ?? []) as Array<{ id: string; product_name: string; category_name: string | null; primary_image_url: string | null }>)
        .map((p) => [p.id, p]),
    );

    const enrichRows = (rows: Record<string, unknown>[]) =>
      rows.map((r) => {
        const p = nameMap.get(r.product_id as string);
        return { ...r, productName: p?.product_name ?? null, categoryName: p?.category_name ?? null, imageUrl: p?.primary_image_url ?? null };
      });

    return NextResponse.json({
      ok: true,
      summary: {
        totalProducts:  totalProductsResult.count  ?? 0,
        totalOrderLines: totalLinesResult.count     ?? 0,
        totalMerchants:  totalMerchantsResult.count ?? 0,
      },
      topBySales:       enrichRows((topBySalesResult.data   ?? []) as Record<string, unknown>[]),
      topBySuccessRate: enrichRows((topBySuccessResult.data ?? []) as Record<string, unknown>[]),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stats_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
