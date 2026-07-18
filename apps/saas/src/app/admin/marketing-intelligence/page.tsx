/**
 * /admin/marketing-intelligence
 *
 * Admin-only marketing intelligence dashboard.
 * In sidebar under INTELLIGENCE section.
 *
 * Tabs: Overview | Products | Regions | Ingestion Health
 */

import { createClient } from "@/lib/supabase/server";
import {
  AdminBadge,
  AdminMetricCard,
  AdminPanel,
  AdminSectionHeader,
} from "@/components/admin/admin-ui";
import Link from "next/link";

export const dynamic = "force-dynamic";

// ── Tab type ──────────────────────────────────────────────────────────────────

type Tab = "overview" | "products" | "regions" | "health";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-DZ", { dateStyle: "short", timeStyle: "short" });
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtRate(r: number | null | undefined): string {
  if (r == null) return "—";
  return (Number(r) * 100).toFixed(1) + "%";
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("fr-DZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " DA";
}

function backfillTone(status: string | null): "emerald" | "sky" | "rose" | "amber" | "neutral" {
  if (status === "completed") return "emerald";
  if (status === "running")   return "sky";
  if (status === "failed")    return "rose";
  if (status === "pending")   return "amber";
  return "neutral";
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function MarketingIntelligencePage({
  searchParams,
}: {
  searchParams?: { tab?: string; page?: string };
}) {
  const supabase = createClient();
  const tab      = ((await searchParams)?.tab ?? "overview") as Tab;
  const page     = Math.max(1, parseInt((await searchParams)?.page ?? "1", 10));
  const PAGE_SIZE = 25;
  const offset    = (page - 1) * PAGE_SIZE;

  // ── Overview tab data ────────────────────────────────────────────────────────

  let totalProducts  = 0;
  let totalLines     = 0;
  let totalMerchants = 0;
  let topBySales:      Record<string, unknown>[] = [];
  let topBySuccess:    Record<string, unknown>[] = [];

  if (tab === "overview") {
    const [prodCount, lineCount, merchantCount, salesTop, successTop] = await Promise.all([
      supabase.from("marketing_products").select("id", { count: "exact", head: true }),
      supabase.from("marketing_product_order_lines").select("id", { count: "exact", head: true }),
      supabase.from("marketing_ingestion_log").select("merchant_id", { count: "exact", head: true }),
      supabase
        .from("marketing_product_statistics")
        .select("product_id, gross_sales, delivered_sales, total_orders, delivered_orders, delivery_success_rate")
        .is("variant_id", null)
        .order("gross_sales", { ascending: false })
        .limit(10),
      supabase
        .from("marketing_product_statistics")
        .select("product_id, delivery_success_rate, total_orders, delivered_orders, gross_sales")
        .is("variant_id", null)
        .gte("total_orders", 3)
        .order("delivery_success_rate", { ascending: false })
        .limit(10),
    ]);

    totalProducts  = prodCount.count  ?? 0;
    totalLines     = lineCount.count  ?? 0;
    totalMerchants = merchantCount.count ?? 0;

    const allPids = [
      ...new Set([
        ...(salesTop.data ?? []).map((r: Record<string, unknown>) => r.product_id as string),
        ...(successTop.data ?? []).map((r: Record<string, unknown>) => r.product_id as string),
      ]),
    ];
    const { data: pNames } = allPids.length > 0
      ? await supabase.from("marketing_products").select("id, product_name").in("id", allPids)
      : { data: [] };

    const nameMap = new Map(((pNames ?? []) as Array<{ id: string; product_name: string }>).map((p) => [p.id, p.product_name]));

    topBySales   = (salesTop.data   ?? []).map((r: Record<string, unknown>) => ({ ...r, productName: nameMap.get(r.product_id as string) ?? r.product_id }));
    topBySuccess = (successTop.data ?? []).map((r: Record<string, unknown>) => ({ ...r, productName: nameMap.get(r.product_id as string) ?? r.product_id }));
  }

  // ── Products tab data ────────────────────────────────────────────────────────

  let products:     Record<string, unknown>[] = [];
  let totalProdCount = 0;

  if (tab === "products") {
    const statsRes = await supabase
      .from("marketing_product_statistics")
      .select("product_id, merchant_id, total_orders, delivered_orders, returned_orders, refused_orders, delivery_success_rate, gross_sales, delivered_sales, returned_sales, best_wilaya, worst_wilaya, average_unit_price, first_order_at, last_order_at", { count: "exact" })
      .is("variant_id", null)
      .order("gross_sales", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    totalProdCount = statsRes.count ?? 0;
    const rows = (statsRes.data ?? []) as Record<string, unknown>[];

    const pids = rows.map((r) => r.product_id as string);
    const { data: pData } = pids.length > 0
      ? await supabase.from("marketing_products").select("id, product_name, category_name, primary_image_url, sku").in("id", pids)
      : { data: [] };

    const pMap = new Map(((pData ?? []) as Array<{ id: string; [k: string]: unknown }>).map((p) => [p.id, p]));

    products = rows.map((r) => {
      const p = pMap.get(r.product_id as string);
      return { ...r, productName: p?.product_name ?? "—", categoryName: p?.category_name ?? "—", sku: p?.sku ?? null };
    });
  }

  // ── Regions tab data ─────────────────────────────────────────────────────────

  let regions: Record<string, unknown>[] = [];

  if (tab === "regions") {
    const regRes = await supabase
      .from("marketing_product_wilaya_statistics")
      .select("wilaya, merchant_id, total_orders, delivered_orders, returned_orders, refused_orders, delivery_success_rate, gross_sales, delivered_sales, returned_sales, pending_orders")
      .is("variant_id", null)
      .order("gross_sales", { ascending: false })
      .limit(58); // All 58 wilayas
    regions = (regRes.data ?? []) as Record<string, unknown>[];
  }

  // ── Health tab data ──────────────────────────────────────────────────────────

  let healthRows: Record<string, unknown>[] = [];

  if (tab === "health") {
    const healthRes = await supabase
      .from("marketing_ingestion_log")
      .select("merchant_id, commerce_source, last_ingestion_at, products_imported, order_lines_imported, last_backfill_at, backfill_status, backfill_cursor, last_error, updated_at")
      .order("updated_at", { ascending: false });
    healthRows = (healthRes.data ?? []) as Record<string, unknown>[];
  }

  // ── Tab navigation ────────────────────────────────────────────────────────────

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "products", label: "Products" },
    { key: "regions",  label: "Regions" },
    { key: "health",   label: "Ingestion Health" },
  ];

  return (
    <div className="space-y-6">
      <AdminSectionHeader
        eyebrow="Admin — Marketing Intelligence"
        title="Product Intelligence"
        description="Admin-only analytics for product performance and delivery outcomes across all merchants."
      />

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-slate-700/50 pb-0">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/admin/marketing-intelligence?tab=${t.key}`}
            className={
              "px-4 py-2 text-sm font-medium rounded-t transition-colors " +
              (tab === t.key
                ? "bg-[#0F1C2E] text-[#D6A74C] border border-b-0 border-slate-700/50"
                : "text-slate-400 hover:text-slate-200")
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* ── OVERVIEW ─────────────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <AdminMetricCard
              label="Total Products"
              value={fmtNumber(totalProducts)}
              tone="gold"
            />
            <AdminMetricCard
              label="Order Lines Tracked"
              value={fmtNumber(totalLines)}
              tone="emerald"
            />
            <AdminMetricCard
              label="Active Merchants"
              value={fmtNumber(totalMerchants)}
              tone="sky"
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <AdminPanel>
              <h3 className="text-sm font-semibold text-[#D6A74C] mb-3">Top 10 by Gross Sales</h3>
              <div className="space-y-2">
                {topBySales.length === 0 && <p className="text-slate-500 text-xs">No data yet</p>}
                {topBySales.map((r, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 truncate max-w-[60%]">{String(r.productName ?? "—")}</span>
                    <span className="text-[#D6A74C] font-mono">{fmtCurrency(r.gross_sales as number)}</span>
                  </div>
                ))}
              </div>
            </AdminPanel>

            <AdminPanel>
              <h3 className="text-sm font-semibold text-emerald-400 mb-3">Top 10 by Delivery Rate</h3>
              <div className="space-y-2">
                {topBySuccess.length === 0 && <p className="text-slate-500 text-xs">No data yet (need ≥3 orders)</p>}
                {topBySuccess.map((r, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 truncate max-w-[60%]">{String(r.productName ?? "—")}</span>
                    <span className="text-emerald-400 font-mono">{fmtRate(r.delivery_success_rate as number)}</span>
                  </div>
                ))}
              </div>
            </AdminPanel>
          </div>
        </div>
      )}

      {/* ── PRODUCTS ─────────────────────────────────────────────────────────── */}
      {tab === "products" && (
        <div className="space-y-4">
          <div className="text-xs text-slate-400">
            {fmtNumber(totalProdCount)} products · Page {page}
          </div>

          <AdminPanel>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-slate-300">
                <thead>
                  <tr className="border-b border-slate-700/50 text-slate-500 text-left">
                    <th className="py-2 pr-4 font-medium">Product</th>
                    <th className="py-2 pr-4 font-medium text-right">Orders</th>
                    <th className="py-2 pr-4 font-medium text-right">Success Rate</th>
                    <th className="py-2 pr-4 font-medium text-right">Gross Sales</th>
                    <th className="py-2 pr-4 font-medium text-right">Delivered</th>
                    <th className="py-2 pr-4 font-medium">Best Wilaya</th>
                    <th className="py-2 pr-4 font-medium">Worst Wilaya</th>
                    <th className="py-2 font-medium text-right">Last Order</th>
                  </tr>
                </thead>
                <tbody>
                  {products.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-6 text-center text-slate-500">No products yet</td>
                    </tr>
                  )}
                  {products.map((r, i) => (
                    <tr key={i} className="border-b border-slate-800/60 hover:bg-[#0F1C2E]/40 transition-colors">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-200 truncate max-w-[200px]">{String(r.productName ?? "—")}</div>
                        <div className="text-slate-500">{String(r.categoryName ?? "—")}</div>
                      </td>
                      <td className="py-2 pr-4 text-right font-mono">{fmtNumber(r.total_orders as number)}</td>
                      <td className="py-2 pr-4 text-right font-mono">
                        <span className={Number(r.delivery_success_rate ?? 0) >= 0.7 ? "text-emerald-400" : Number(r.delivery_success_rate ?? 0) >= 0.4 ? "text-amber-400" : "text-rose-400"}>
                          {fmtRate(r.delivery_success_rate as number)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-[#D6A74C]">{fmtCurrency(r.gross_sales as number)}</td>
                      <td className="py-2 pr-4 text-right font-mono text-emerald-400">{fmtCurrency(r.delivered_sales as number)}</td>
                      <td className="py-2 pr-4 text-slate-400">{String(r.best_wilaya ?? "—")}</td>
                      <td className="py-2 pr-4 text-slate-400">{String(r.worst_wilaya ?? "—")}</td>
                      <td className="py-2 text-right text-slate-500">{fmtDate(r.last_order_at as string)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminPanel>

          {/* Pagination */}
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={`/admin/marketing-intelligence?tab=products&page=${page - 1}`} className="px-3 py-1 text-xs bg-[#0F1C2E] text-slate-300 rounded border border-slate-700/50 hover:text-[#D6A74C] transition-colors">
                ← Previous
              </Link>
            )}
            {products.length === PAGE_SIZE && (
              <Link href={`/admin/marketing-intelligence?tab=products&page=${page + 1}`} className="px-3 py-1 text-xs bg-[#0F1C2E] text-slate-300 rounded border border-slate-700/50 hover:text-[#D6A74C] transition-colors">
                Next →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* ── REGIONS ──────────────────────────────────────────────────────────── */}
      {tab === "regions" && (
        <AdminPanel>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-slate-300">
              <thead>
                <tr className="border-b border-slate-700/50 text-slate-500 text-left">
                  <th className="py-2 pr-4 font-medium">Wilaya</th>
                  <th className="py-2 pr-4 font-medium text-right">Orders</th>
                  <th className="py-2 pr-4 font-medium text-right">Delivered</th>
                  <th className="py-2 pr-4 font-medium text-right">Returned</th>
                  <th className="py-2 pr-4 font-medium text-right">Refused</th>
                  <th className="py-2 pr-4 font-medium text-right">Pending</th>
                  <th className="py-2 pr-4 font-medium text-right">Success Rate</th>
                  <th className="py-2 font-medium text-right">Gross Sales</th>
                </tr>
              </thead>
              <tbody>
                {regions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-slate-500">No region data yet</td>
                  </tr>
                )}
                {regions.map((r, i) => (
                  <tr key={i} className="border-b border-slate-800/60 hover:bg-[#0F1C2E]/40 transition-colors">
                    <td className="py-2 pr-4 font-medium text-slate-200">{String(r.wilaya ?? "—")}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmtNumber(r.total_orders as number)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-emerald-400">{fmtNumber(r.delivered_orders as number)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-rose-400">{fmtNumber(r.returned_orders as number)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-amber-400">{fmtNumber(r.refused_orders as number)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-slate-500">{fmtNumber(r.pending_orders as number)}</td>
                    <td className="py-2 pr-4 text-right font-mono">
                      <span className={Number(r.delivery_success_rate ?? 0) >= 0.7 ? "text-emerald-400" : Number(r.delivery_success_rate ?? 0) >= 0.4 ? "text-amber-400" : "text-rose-400"}>
                        {fmtRate(r.delivery_success_rate as number)}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono text-[#D6A74C]">{fmtCurrency(r.gross_sales as number)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      )}

      {/* ── INGESTION HEALTH ─────────────────────────────────────────────────── */}
      {tab === "health" && (
        <div className="space-y-4">
          <AdminPanel>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-slate-300">
                <thead>
                  <tr className="border-b border-slate-700/50 text-slate-500 text-left">
                    <th className="py-2 pr-4 font-medium">Merchant</th>
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium text-right">Lines</th>
                    <th className="py-2 pr-4 font-medium">Last Ingestion</th>
                    <th className="py-2 pr-4 font-medium">Backfill Status</th>
                    <th className="py-2 pr-4 font-medium">Last Backfill</th>
                    <th className="py-2 font-medium">Last Error</th>
                  </tr>
                </thead>
                <tbody>
                  {healthRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-slate-500">No ingestion data yet</td>
                    </tr>
                  )}
                  {healthRows.map((r, i) => (
                    <tr key={i} className="border-b border-slate-800/60 hover:bg-[#0F1C2E]/40 transition-colors">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400 max-w-[120px] truncate">{String(r.merchant_id ?? "—").slice(0, 8)}…</td>
                      <td className="py-2 pr-4">
                        <AdminBadge tone="sky">{String(r.commerce_source ?? "woocommerce")}</AdminBadge>
                      </td>
                      <td className="py-2 pr-4 text-right font-mono">{fmtNumber(r.order_lines_imported as number)}</td>
                      <td className="py-2 pr-4 text-slate-400">{fmtDate(r.last_ingestion_at as string)}</td>
                      <td className="py-2 pr-4">
                        {r.backfill_status
                          ? <AdminBadge tone={backfillTone(r.backfill_status as string)}>{String(r.backfill_status)}</AdminBadge>
                          : <span className="text-slate-600">—</span>
                        }
                      </td>
                      <td className="py-2 pr-4 text-slate-400">{fmtDate(r.last_backfill_at as string)}</td>
                      <td className="py-2 text-rose-400 max-w-[200px] truncate" title={String(r.last_error ?? "")}>
                        {r.last_error ? String(r.last_error).slice(0, 80) : <span className="text-slate-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminPanel>

          <AdminPanel>
            <h3 className="text-sm font-semibold text-[#D6A74C] mb-2">Trigger Backfill</h3>
            <p className="text-xs text-slate-400 mb-3">
              Use the API endpoint to start or resume a backfill. Run from the admin shell:
            </p>
            <code className="block text-xs bg-[#050E1A] text-slate-300 p-3 rounded border border-slate-700/50 font-mono">
              POST /api/v1/admin/marketing-intelligence/backfill
              <br />
              {"{ \"merchantId\": \"<uuid>\", \"resetCursor\": false }"}
            </code>
          </AdminPanel>
        </div>
      )}
    </div>
  );
}
