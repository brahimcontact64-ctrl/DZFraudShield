import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

type CategoryMetrics = {
  category: string;
  merchantCount: number;
  totalOrders: number;
  blockedOrders: number;
  successRate: number;
  returnRate: number;
  avgOrderValue: number;
};

export default async function CategoryMetricsPage() {
  const supabase = createClient();

  // Fetch merchants by category
  const [merchantsResult, checksResult] = await Promise.all([
    supabase.from("merchants").select("id, category"),
    supabase.from("order_checks").select("merchant_id, risk_level, recommended_action, total_amount, cart_total")
  ]);

  if (merchantsResult.error) throw merchantsResult.error;
  if (checksResult.error) throw checksResult.error;

  const merchants = merchantsResult.data ?? [];
  const checks = checksResult.data ?? [];

  // Build category map
  const merchantsByCategory = new Map<string, string[]>();
  for (const merchant of merchants) {
    const cat = merchant.category ?? "Uncategorized";
    const current = merchantsByCategory.get(cat) ?? [];
    current.push(merchant.id);
    merchantsByCategory.set(cat, current);
  }

  // Calculate metrics per category
  const metricsMap = new Map<string, CategoryMetrics>();

  for (const [category, merchantIds] of merchantsByCategory.entries()) {
    const categoryChecks = checks.filter((c) => merchantIds.includes(c.merchant_id));
    const totalOrders = categoryChecks.length;
    const blockedOrders = categoryChecks.filter(
      (c) => c.risk_level === "BLOCK" || c.risk_level === "CRITICAL" || c.recommended_action === "block"
    ).length;
    const successRate = totalOrders > 0 ? ((totalOrders - blockedOrders) / totalOrders) * 100 : 100;
    const totalAmount = categoryChecks.reduce((sum, c) => sum + Number(c.total_amount ?? c.cart_total ?? 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalAmount / totalOrders : 0;

    metricsMap.set(category, {
      category,
      merchantCount: merchantIds.length,
      totalOrders,
      blockedOrders,
      successRate,
      returnRate: 0, // Would be calculated from shipment data
      avgOrderValue
    });
  }

  const metrics = Array.from(metricsMap.values()).sort((a, b) => b.merchantCount - a.merchantCount);
  const topCategory = metrics[0];
  const categoryGrowth = metrics.length > 1 ? metrics[0].merchantCount - metrics[1].merchantCount : metrics[0].merchantCount;
  const totalMerchants = merchants.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="sky">Category Analytics</AdminBadge>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Merchant categories overview</h1>
          <p className="max-w-2xl text-sm text-slate-300">
            View category distribution, growth trends, and performance metrics.
          </p>
        </div>
        <AdminBadge tone="emerald">{metrics.length} categories</AdminBadge>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <AdminPanel className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Total Merchants</p>
          <p className="text-3xl font-semibold text-white">{totalMerchants.toLocaleString()}</p>
        </AdminPanel>

        <AdminPanel className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Top Category</p>
          <p className="text-2xl font-semibold text-white">{topCategory?.category ?? "—"}</p>
          <p className="text-sm text-slate-400">{topCategory?.merchantCount ?? 0} merchants</p>
        </AdminPanel>

        <AdminPanel className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Category Growth</p>
          <p className="text-3xl font-semibold text-white">{categoryGrowth.toLocaleString()}</p>
          <p className="text-sm text-slate-400">lead vs 2nd</p>
        </AdminPanel>

        <AdminPanel className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Avg Success Rate</p>
          <p className="text-3xl font-semibold text-white">
            {metrics.length > 0 ? (metrics.reduce((sum, m) => sum + m.successRate, 0) / metrics.length).toFixed(1) : 0}%
          </p>
        </AdminPanel>
      </div>

      {/* Category Breakdown */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Merchants by Category</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {metrics.map((metric) => (
            <AdminPanel key={metric.category} className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">{metric.category}</h3>
                <AdminBadge tone="sky">{metric.merchantCount}</AdminBadge>
              </div>

              <div className="grid gap-2">
                <div className="flex justify-between">
                  <span className="text-sm text-slate-400">Orders Checked:</span>
                  <span className="font-semibold text-white">{metric.totalOrders.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-slate-400">Blocked:</span>
                  <span className="font-semibold text-white">{metric.blockedOrders.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-slate-400">Success Rate:</span>
                  <span className="font-semibold text-white">{metric.successRate.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-slate-400">Avg Order Value:</span>
                  <span className="font-semibold text-white">{Math.round(metric.avgOrderValue).toLocaleString()} DZD</span>
                </div>
              </div>

              <Link href={`/admin/merchants?category=${encodeURIComponent(metric.category)}`} className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700/40 inline-block">
                View Merchants
              </Link>
            </AdminPanel>
          ))}
        </div>
      </section>

      {metrics.length === 0 ? (
        <AdminPanel className="space-y-4">
          <p className="text-slate-300">No category data available yet.</p>
        </AdminPanel>
      ) : null}
    </div>
  );
}
