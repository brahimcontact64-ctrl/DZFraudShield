// Product recommendations.
//
// Data source: marketing_product_statistics (precomputed table, one read per engine run)
// and marketing_products (for product names).
//
// Generates per-product, per-merchant recommendations for:
//   - Best sellers (promote)
//   - High return rate products (investigate / discontinue)
//   - Products suitable for bundles (high success + adjacent category)
//   - Products with growing demand (detected via recent vs older orders)

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { Recommendation } from "./types";
import { calculateConfidence, rateSignalStrength } from "./scoring";
import {
  highReturnProductSavings,
  discontinueProductSavings,
  promoteProductRevenue,
} from "./financial-impact";

let _id = 0;
function nextId(): string {
  return `prd-${++_id}`;
}

export function resetProductIds(): void {
  _id = 0;
}

const NOW = new Date().toISOString();

// ── Thresholds ────────────────────────────────────────────────────────────────

const MIN_ORDERS_FOR_PRODUCT_REC  = 5;
const HIGH_RETURN_THRESHOLD       = 0.45; // success rate below this → high return rec
const DISCONTINUE_THRESHOLD       = 0.25; // success rate below this AND >= 10 orders → discontinue
const BEST_SELLER_THRESHOLD       = 0.65; // success rate above this → promote
const BEST_SELLER_MIN_REVENUE     = 5000; // DZD gross sales minimum
const BUNDLE_CANDIDATE_THRESHOLD  = 0.70; // success rate for bundle candidates
const PRODUCT_SAMPLE              = 300;  // max product stats rows to analyze

// ── DB row types ──────────────────────────────────────────────────────────────

type ProductStatRow = {
  merchant_id: string;
  product_id: string;
  total_orders: number;
  delivered_orders: number;
  returned_orders: number;
  refused_orders: number;
  cancelled_orders: number;
  no_answer_orders: number;
  delivery_success_rate: number;
  gross_sales: number;
  delivered_sales: number;
  returned_sales: number;
  average_unit_price: number | null;
  best_wilaya: string | null;
  worst_wilaya: string | null;
  top_wilayas: Array<{ wilaya: string; orders: number; successRate: number; grossSales: number }> | null;
  first_order_at: string | null;
  last_order_at: string | null;
};

type ProductNameRow = {
  id: string;
  merchant_id: string;
  product_name: string;
  category_name: string | null;
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateProductRecommendations(
  supabase: SupabaseClient,
  summaries: MerchantIntelSummary[],
): Promise<Recommendation[]> {
  const recs: Recommendation[] = [];

  // Only process merchants that have product intelligence data
  if (summaries.length === 0) return recs;

  // ── 1. Load product stats (variant_id is null → product-level rows only) ───

  const { data: rawStats, error: statsError } = await supabase
    .from("marketing_product_statistics")
    .select(
      "merchant_id, product_id, total_orders, delivered_orders, returned_orders, refused_orders, cancelled_orders, no_answer_orders, delivery_success_rate, gross_sales, delivered_sales, returned_sales, average_unit_price, best_wilaya, worst_wilaya, top_wilayas, first_order_at, last_order_at",
    )
    .is("variant_id", null)
    .gte("total_orders", MIN_ORDERS_FOR_PRODUCT_REC)
    .order("gross_sales", { ascending: false })
    .limit(PRODUCT_SAMPLE);

  if (statsError) {
    console.error("[rec-engine] products stats fetch failed", statsError.message);
    return recs;
  }

  const stats = (rawStats ?? []) as ProductStatRow[];
  if (stats.length === 0) return recs;

  // ── 2. Load product names for the collected product IDs ──────────────────

  const productIds = [...new Set(stats.map((s) => s.product_id))];

  const { data: rawProducts } = await supabase
    .from("marketing_products")
    .select("id, merchant_id, product_name, category_name")
    .in("id", productIds.slice(0, 250)); // Supabase IN limit safety

  const nameMap = new Map<string, ProductNameRow>();
  for (const p of (rawProducts ?? []) as ProductNameRow[]) {
    nameMap.set(p.id, p);
  }

  // ── 3. Build merchant summary index ─────────────────────────────────────

  const merchantIndex = new Map<string, MerchantIntelSummary>();
  for (const m of summaries) {
    merchantIndex.set(m.merchantId, m);
  }

  // ── 4. Generate recommendations per product row ───────────────────────────

  for (const stat of stats) {
    const product = nameMap.get(stat.product_id);
    const productName = product?.product_name ?? `Product ${stat.product_id.slice(0, 8)}`;
    const categoryName = product?.category_name ?? null;
    const merchant = merchantIndex.get(stat.merchant_id);
    const merchantName = merchant?.name ?? `Merchant ${stat.merchant_id.slice(0, 8)}`;
    const avgPrice = stat.average_unit_price ?? (stat.total_orders > 0 ? stat.gross_sales / stat.total_orders : 2500);

    // ── Best seller → promote ───────────────────────────────────────────
    if (
      stat.delivery_success_rate >= BEST_SELLER_THRESHOLD &&
      stat.gross_sales >= BEST_SELLER_MIN_REVENUE
    ) {
      const signal = rateSignalStrength(stat.delivery_success_rate, BEST_SELLER_THRESHOLD, 0.5);
      const confidence = calculateConfidence(stat.total_orders, signal);
      const revenue = promoteProductRevenue(stat.delivered_orders, avgPrice);

      recs.push({
        id: nextId(),
        merchantId: stat.merchant_id,
        merchantName,
        category: "products",
        type: "product_best_seller",
        priority: stat.delivery_success_rate >= 0.80 ? "HIGH" : "MEDIUM",
        title: `Promote "${productName}" — ${(stat.delivery_success_rate * 100).toFixed(1)}% success rate`,
        description: `This product delivered ${stat.delivered_orders.toLocaleString()} of ${stat.total_orders.toLocaleString()} orders with a ${(stat.delivery_success_rate * 100).toFixed(1)}% success rate. Gross sales: ${(stat.gross_sales / 1000).toFixed(0)}K DZD. It is a reliable performer.`,
        reason: `Success rate of ${(stat.delivery_success_rate * 100).toFixed(1)}% significantly exceeds the 65% best-seller threshold. This product generates consistent delivered revenue with low return exposure.`,
        businessImpact: `Increasing ad spend on this product could generate an additional ${(revenue / 1000).toFixed(0)}K DZD in delivered revenue based on current performance.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: revenue,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["marketing_product_statistics"],
        recommendedActions: [
          { label: "Increase ad spend on this product", description: "Scale campaigns featuring this product — it converts reliably." },
          stat.best_wilaya
            ? { label: `Focus on ${stat.best_wilaya}`, description: `Best-performing wilaya for this product.` }
            : { label: "Expand wilaya targeting", description: "Target more wilayas with this proven product." },
          { label: "Bundle with complementary products", description: "High-performing products are strong anchors for bundle offers." },
        ],
        productId: stat.product_id,
        productName,
        categoryName: categoryName ?? undefined,
      });
    }

    // ── Discontinue → very high returns ────────────────────────────────
    if (
      stat.delivery_success_rate < DISCONTINUE_THRESHOLD &&
      stat.total_orders >= MIN_ORDERS_FOR_PRODUCT_REC * 2
    ) {
      const returned = stat.returned_orders + stat.refused_orders + stat.cancelled_orders;
      const signal = rateSignalStrength(stat.delivery_success_rate, 0.55, DISCONTINUE_THRESHOLD);
      const confidence = calculateConfidence(stat.total_orders, signal);
      const savings = discontinueProductSavings(returned, avgPrice);

      recs.push({
        id: nextId(),
        merchantId: stat.merchant_id,
        merchantName,
        category: "products",
        type: "product_discontinue",
        priority: stat.delivery_success_rate < 0.15 ? "CRITICAL" : "HIGH",
        title: `Consider discontinuing "${productName}" — ${(stat.delivery_success_rate * 100).toFixed(1)}% success rate`,
        description: `${returned.toLocaleString()} of ${stat.total_orders.toLocaleString()} orders were returned, refused, or cancelled. Only ${stat.delivered_orders.toLocaleString()} orders were actually delivered. This product is generating more losses than revenue.`,
        reason: `A ${(stat.delivery_success_rate * 100).toFixed(1)}% success rate with ${stat.total_orders.toLocaleString()} orders is a statistically reliable signal of a non-viable product. Return and refusal costs are eroding the merchant's margin.`,
        businessImpact: `Continuing this product generates ${(stat.returned_sales / 1000).toFixed(0)}K DZD in return-related losses per period. Discontinuing avoids ongoing logistics cost.`,
        estimatedSavingsDzd: savings,
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["marketing_product_statistics"],
        recommendedActions: [
          { label: "Pause ads immediately", description: "Stop generating new orders for this product until the issue is resolved." },
          { label: "Review product description and images", description: "High returns often indicate customers received something different from what was advertised." },
          { label: "Consider reformulating or replacing the product", description: "If returns persist after fixes, discontinue and redirect budget to performing products." },
        ],
        productId: stat.product_id,
        productName,
        categoryName: categoryName ?? undefined,
      });
    } else if (
      stat.delivery_success_rate < HIGH_RETURN_THRESHOLD &&
      stat.total_orders >= MIN_ORDERS_FOR_PRODUCT_REC
    ) {
      // ── High return rate → investigate ──────────────────────────────
      const returned = stat.returned_orders + stat.refused_orders;
      const signal = rateSignalStrength(stat.delivery_success_rate, 0.65, HIGH_RETURN_THRESHOLD);
      const confidence = calculateConfidence(stat.total_orders, signal);
      const savings = highReturnProductSavings(returned, avgPrice);

      recs.push({
        id: nextId(),
        merchantId: stat.merchant_id,
        merchantName,
        category: "products",
        type: "product_high_returns",
        priority: "MEDIUM",
        title: `"${productName}" has an elevated return rate — ${(stat.delivery_success_rate * 100).toFixed(1)}% delivered`,
        description: `${returned.toLocaleString()} orders returned or refused out of ${stat.total_orders.toLocaleString()} total. Gross sales: ${(stat.gross_sales / 1000).toFixed(0)}K DZD but delivered sales: ${(stat.delivered_sales / 1000).toFixed(0)}K DZD.`,
        reason: `Delivery success rate of ${(stat.delivery_success_rate * 100).toFixed(1)}% is below the 45% alert threshold. Return costs and failed logistics compound over time.`,
        businessImpact: `Improving success rate from ${(stat.delivery_success_rate * 100).toFixed(1)}% to 65% on this product could recover approximately ${(savings / 1000).toFixed(0)}K DZD in currently lost revenue.`,
        estimatedSavingsDzd: savings,
        estimatedRevenueIncreaseDzd: 0,
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["marketing_product_statistics"],
        recommendedActions: [
          { label: "Investigate return reasons", description: "Contact delivery provider for return reason codes on this product." },
          stat.worst_wilaya
            ? { label: `Reduce targeting in ${stat.worst_wilaya}`, description: "Worst-performing wilaya for this product — consider excluding from targeting." }
            : { label: "Review wilaya targeting", description: "Restrict this product to wilayas with historically higher success." },
          { label: "Audit product packaging", description: "Fragile products with insufficient packaging cause delivery damage and returns." },
        ],
        productId: stat.product_id,
        productName,
        categoryName: categoryName ?? undefined,
      });
    }

    // ── Bundle opportunity ───────────────────────────────────────────────
    if (
      stat.delivery_success_rate >= BUNDLE_CANDIDATE_THRESHOLD &&
      stat.total_orders >= MIN_ORDERS_FOR_PRODUCT_REC &&
      stat.gross_sales >= BEST_SELLER_MIN_REVENUE
    ) {
      // Only generate one bundle recommendation per top product per merchant
      // (avoid flooding with many bundle recs)
      const alreadyHasBundleRec = recs.some(
        (r) =>
          r.type === "product_bundle_opportunity" &&
          r.merchantId === stat.merchant_id,
      );
      if (!alreadyHasBundleRec) {
        const confidence = calculateConfidence(stat.total_orders, 0.5);
        recs.push({
          id: nextId(),
          merchantId: stat.merchant_id,
          merchantName,
          category: "products",
          type: "product_bundle_opportunity",
          priority: "LOW",
          title: `Bundle "${productName}" with complementary products`,
          description: `"${productName}" has a ${(stat.delivery_success_rate * 100).toFixed(1)}% delivery success rate and ${stat.total_orders.toLocaleString()} orders. Strong-performing products are ideal anchors for bundle offers that increase average order value.`,
          reason: `Products with >70% success rate have demonstrated customer acceptance. Bundling them with related items increases average order value without increasing return risk proportionally.`,
          businessImpact: `If 20% of existing customers accept a bundle with 30% higher AOV, this generates additional revenue on top of current ${(stat.gross_sales / 1000).toFixed(0)}K DZD gross sales.`,
          estimatedSavingsDzd: 0,
          estimatedRevenueIncreaseDzd: Math.round(stat.delivered_orders * avgPrice * 0.30 * 0.20),
          confidenceScore: confidence,
          generatedAt: NOW,
          requiredDataSources: ["marketing_product_statistics"],
          recommendedActions: [
            { label: "Create a product bundle", description: "Pair this product with a complementary item and offer at a 10–15% discount." },
            { label: "Test on repeat customers first", description: "Existing buyers of this product are the most likely to accept a bundle." },
          ],
          productId: stat.product_id,
          productName,
          categoryName: categoryName ?? undefined,
        });
      }
    }
  }

  return recs;
}
