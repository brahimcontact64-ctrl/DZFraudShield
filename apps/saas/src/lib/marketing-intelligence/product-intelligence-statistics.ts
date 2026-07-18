/**
 * product-intelligence-statistics.ts
 *
 * Full-rebuild statistics recompute for marketing_product_statistics and
 * marketing_product_wilaya_statistics.
 *
 * DESIGN:
 *   Both tables use expression-based UNIQUE constraints (COALESCE sentinel
 *   UUID for nullable variant_id). Supabase's JS upsert() only accepts plain
 *   column names in onConflict, so it cannot target these constraints.
 *
 *   Instead we use a full DELETE + INSERT cycle per productId. This is safe
 *   because recomputeProductStatistics is only called from background jobs
 *   that process one productId at a time, and the tables have no data that
 *   would be lost — they are always derivable from marketing_product_order_lines.
 *
 * DELIVERY_SUCCESS_RATE FORMULA:
 *   delivered / (delivered + returned + refused + cancelled + no_answer)
 *   Pending / in-transit orders are NOT in the denominator.
 *   Returns 0 when denominator is 0 (no terminal-outcome orders yet).
 *
 * BEST/WORST WILAYA THRESHOLD:
 *   A wilaya requires >= MIN_TERMINAL_ORDERS_FOR_RANKING terminal-outcome orders
 *   to qualify for ranking. Wilayas below this threshold are excluded to avoid
 *   noise from a single delivered order in a rarely-served region.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TopWilaya } from "./product-intelligence-types";

const MIN_TERMINAL_ORDERS_FOR_RANKING = 3;
const TOP_WILAYA_LIMIT = 5;

// ── Outcome classification ────────────────────────────────────────────────────

type OutcomeGroup =
  | "delivered"
  | "returned"
  | "refused"
  | "cancelled"
  | "no_answer"
  | "pending";

function classifyOutcome(raw: string | null): OutcomeGroup {
  if (!raw) return "pending";
  const s = raw.toUpperCase();
  if (s === "DELIVERED")                          return "delivered";
  if (s === "RETURNED")                           return "returned";
  if (s === "REFUSED")                            return "refused";
  if (s === "CANCELLED" || s === "FAKE_ORDER")    return "cancelled";
  if (s === "NO_ANSWER")                          return "no_answer";
  return "pending";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function successRate(
  delivered: number,
  returned:  number,
  refused:   number,
  cancelled: number,
  noAnswer:  number,
): number {
  const denominator = delivered + returned + refused + cancelled + noAnswer;
  if (denominator === 0) return 0;
  return Number((delivered / denominator).toFixed(4));
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Order-line DB row shape (what we SELECT) ──────────────────────────────────

type OrderLineAggRow = {
  variant_id:       string | null;
  wilaya:           string | null;
  delivery_outcome: string | null;
  quantity:         number | null;
  line_total:       number | null;
  unit_price:       number | null;
  order_date:       string | null;
};

// ── Per-bucket accumulator ────────────────────────────────────────────────────

type Agg = {
  totalOrders:    number;
  totalUnits:     number;
  delivered:      number;
  returned:       number;
  refused:        number;
  cancelled:      number;
  noAnswer:       number;
  pending:        number;
  grossSales:     number;
  deliveredSales: number;
  returnedSales:  number;
  unitPriceSum:   number;
  unitPriceCount: number;
  firstOrderAt:   string | null;
  lastOrderAt:    string | null;
};

function emptyAgg(): Agg {
  return {
    totalOrders: 0, totalUnits: 0,
    delivered: 0, returned: 0, refused: 0, cancelled: 0, noAnswer: 0, pending: 0,
    grossSales: 0, deliveredSales: 0, returnedSales: 0,
    unitPriceSum: 0, unitPriceCount: 0,
    firstOrderAt: null, lastOrderAt: null,
  };
}

function accumulate(agg: Agg, row: OrderLineAggRow): void {
  const qty     = Math.max(0, row.quantity   ?? 0);
  const total   = Math.max(0, row.line_total ?? 0);
  const outcome = classifyOutcome(row.delivery_outcome);
  const d       = row.order_date ?? null;

  agg.totalOrders++;
  agg.totalUnits += qty;
  agg.grossSales += total;

  if      (outcome === "delivered") { agg.delivered++;  agg.deliveredSales += total; }
  else if (outcome === "returned")  { agg.returned++;   agg.returnedSales  += total; }
  else if (outcome === "refused")   { agg.refused++;    agg.returnedSales  += total; }
  else if (outcome === "cancelled") { agg.cancelled++; }
  else if (outcome === "no_answer") { agg.noAnswer++;  }
  else                              { agg.pending++;   }

  if (row.unit_price) { agg.unitPriceSum += row.unit_price; agg.unitPriceCount++; }
  if (d) {
    if (!agg.firstOrderAt || d < agg.firstOrderAt) agg.firstOrderAt = d;
    if (!agg.lastOrderAt  || d > agg.lastOrderAt)  agg.lastOrderAt  = d;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Recomputes both marketing_product_statistics and marketing_product_wilaya_statistics
 * for a given (merchantId, productId) using a full DELETE + INSERT cycle.
 *
 * Variant-level rows are produced automatically when variant_id values appear
 * in order lines. No separate call per variant is needed.
 */
export async function recomputeProductStatistics(
  supabase:   SupabaseClient,
  merchantId: string,
  productId:  string,
): Promise<{ productRows: number; wilayaRows: number; errors: number }> {
  const result = { productRows: 0, wilayaRows: 0, errors: 0 };

  try {
    // ── 1. Load all order lines for this product ──────────────────────────────

    const { data: rows, error: fetchErr } = await supabase
      .from("marketing_product_order_lines")
      .select("variant_id, wilaya, delivery_outcome, quantity, line_total, unit_price, order_date")
      .eq("merchant_id", merchantId)
      .eq("product_id",  productId);

    if (fetchErr) {
      console.error("[pi-stats] fetch order lines failed", { merchantId, productId, error: fetchErr.message });
      result.errors++;
      return result;
    }

    const lines = (rows ?? []) as OrderLineAggRow[];
    if (lines.length === 0) return result;

    // ── 2. Aggregate by (variantId, wilaya) and (variantId) ──────────────────

    // Key: `${variantId ?? "null"}:${wilaya ?? "null"}`
    const byVW  = new Map<string, Agg & { variantId: string | null; wilaya: string | null }>();
    const byVar = new Map<string | null, Agg>();

    for (const row of lines) {
      const varId  = row.variant_id ?? null;
      const wilaya = row.wilaya     ?? null;

      // Wilaya bucket
      const wk = `${varId ?? "null"}:${wilaya ?? "null"}`;
      if (!byVW.has(wk)) byVW.set(wk, { ...emptyAgg(), variantId: varId, wilaya });
      accumulate(byVW.get(wk)!, row);

      // Variant-level bucket (wilaya-agnostic)
      if (!byVar.has(varId)) byVar.set(varId, emptyAgg());
      accumulate(byVar.get(varId)!, row);
    }

    const ts = nowIso();

    // ── 3. Delete + reinsert wilaya statistics ────────────────────────────────

    // Delete first (full rebuild)
    const { error: wDelErr } = await supabase
      .from("marketing_product_wilaya_statistics")
      .delete()
      .eq("merchant_id", merchantId)
      .eq("product_id",  productId);

    if (wDelErr) {
      console.error("[pi-stats] wilaya delete failed", { merchantId, productId, error: wDelErr.message });
      result.errors++;
      // Continue — the insert may still produce valid rows
    }

    type WilayaInsertRow = {
      variantId: string | null;
      wilaya: string;
      rate: number;
      totalOrders: number;
      grossSales: number;
    };
    const qualifyingWilayasByVariant = new Map<string | null, WilayaInsertRow[]>();

    const wilayaInserts: Record<string, unknown>[] = [];

    for (const [, wb] of byVW) {
      if (!wb.wilaya) continue; // skip lines without wilaya — they're unclassifiable

      const rate = successRate(wb.delivered, wb.returned, wb.refused, wb.cancelled, wb.noAnswer);

      wilayaInserts.push({
        merchant_id:           merchantId,
        product_id:            productId,
        variant_id:            wb.variantId,
        wilaya:                wb.wilaya,
        total_orders:          wb.totalOrders,
        total_units:           wb.totalUnits,
        delivered_orders:      wb.delivered,
        returned_orders:       wb.returned,
        refused_orders:        wb.refused,
        cancelled_orders:      wb.cancelled,
        no_answer_orders:      wb.noAnswer,
        pending_orders:        wb.pending,
        delivery_success_rate: rate,
        gross_sales:           wb.grossSales,
        delivered_sales:       wb.deliveredSales,
        returned_sales:        wb.returnedSales,
        average_unit_price:    wb.unitPriceCount > 0 ? wb.unitPriceSum / wb.unitPriceCount : null,
        first_order_at:        wb.firstOrderAt,
        last_order_at:         wb.lastOrderAt,
        updated_at:            ts,
      });

      // Track qualified wilayas (>= threshold terminal orders) for ranking
      const terminalOrders = wb.delivered + wb.returned + wb.refused + wb.cancelled + wb.noAnswer;
      if (terminalOrders >= MIN_TERMINAL_ORDERS_FOR_RANKING) {
        if (!qualifyingWilayasByVariant.has(wb.variantId)) {
          qualifyingWilayasByVariant.set(wb.variantId, []);
        }
        qualifyingWilayasByVariant.get(wb.variantId)!.push({
          variantId:   wb.variantId,
          wilaya:      wb.wilaya,
          rate,
          totalOrders: wb.totalOrders,
          grossSales:  wb.grossSales,
        });
      }
    }

    // Insert in batches of 50
    for (let i = 0; i < wilayaInserts.length; i += 50) {
      const batch = wilayaInserts.slice(i, i + 50);
      const { error: wInsErr } = await supabase
        .from("marketing_product_wilaya_statistics")
        .insert(batch);

      if (wInsErr) {
        console.error("[pi-stats] wilaya insert failed", { merchantId, productId, error: wInsErr.message });
        result.errors++;
      } else {
        result.wilayaRows += batch.length;
      }
    }

    // ── 4. Delete + reinsert product statistics ───────────────────────────────

    const { error: pDelErr } = await supabase
      .from("marketing_product_statistics")
      .delete()
      .eq("merchant_id", merchantId)
      .eq("product_id",  productId);

    if (pDelErr) {
      console.error("[pi-stats] product stats delete failed", { merchantId, productId, error: pDelErr.message });
      result.errors++;
    }

    for (const [variantId, vb] of byVar) {
      const qualifiedForVariant = (qualifyingWilayasByVariant.get(variantId) ?? [])
        .sort((a, b) => b.rate - a.rate);

      const bestWilaya  = qualifiedForVariant.length > 0
        ? qualifiedForVariant[0].wilaya
        : null;
      const worstWilaya = qualifiedForVariant.length > 0
        ? qualifiedForVariant[qualifiedForVariant.length - 1].wilaya
        : null;

      const topWilayas: TopWilaya[] = qualifiedForVariant
        .slice(0, TOP_WILAYA_LIMIT)
        .map((r) => ({
          wilaya:      r.wilaya,
          orders:      r.totalOrders,
          successRate: r.rate,
          grossSales:  r.grossSales,
        }));

      const { error: pInsErr } = await supabase
        .from("marketing_product_statistics")
        .insert({
          merchant_id:           merchantId,
          product_id:            productId,
          variant_id:            variantId,
          total_orders:          vb.totalOrders,
          total_units:           vb.totalUnits,
          delivered_orders:      vb.delivered,
          returned_orders:       vb.returned,
          refused_orders:        vb.refused,
          cancelled_orders:      vb.cancelled,
          no_answer_orders:      vb.noAnswer,
          pending_orders:        vb.pending,
          delivery_success_rate: successRate(vb.delivered, vb.returned, vb.refused, vb.cancelled, vb.noAnswer),
          gross_sales:           vb.grossSales,
          delivered_sales:       vb.deliveredSales,
          returned_sales:        vb.returnedSales,
          average_unit_price:    vb.unitPriceCount > 0 ? vb.unitPriceSum / vb.unitPriceCount : null,
          best_wilaya:           bestWilaya,
          worst_wilaya:          worstWilaya,
          top_wilayas:           topWilayas,
          first_order_at:        vb.firstOrderAt,
          last_order_at:         vb.lastOrderAt,
          updated_at:            ts,
        });

      if (pInsErr) {
        console.error("[pi-stats] product stats insert failed", { merchantId, productId, variantId, error: pInsErr.message });
        result.errors++;
      } else {
        result.productRows++;
      }
    }

  } catch (err) {
    console.error("[pi-stats] recomputeProductStatistics threw", { merchantId, productId, error: err });
    result.errors++;
  }

  return result;
}
