import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader, FlowList, Sparkline } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

type DailyPoint = { day: string; protectedOrders: number; blockedOrders: number; savedLosses: number };

export default async function AdminIndexPage() {
  const supabase = createClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const currentMonthStart = new Date();
  currentMonthStart.setUTCDate(1);
  currentMonthStart.setUTCHours(0, 0, 0, 0);
  const previousMonthStart = new Date(currentMonthStart);
  previousMonthStart.setUTCMonth(previousMonthStart.getUTCMonth() - 1);

  const [merchantsResult, storesResult, accountsResult, checksResult, reputationResult] = await Promise.all([
    supabase.from("merchants").select("id, name, created_at").order("created_at", { ascending: false }),
    supabase.from("stores").select("merchant_id, is_active, created_at"),
    supabase.from("merchant_delivery_accounts").select("merchant_id, provider, active, created_at"),
    supabase.from("order_checks").select("merchant_id, created_at, risk_level, recommended_action, total_amount, cart_total"),
    supabase.from("customer_reputation").select("identity_id", { count: "exact", head: true })
  ]);

  if (merchantsResult.error) throw merchantsResult.error;
  if (storesResult.error) throw storesResult.error;
  if (accountsResult.error) throw accountsResult.error;
  if (checksResult.error) throw checksResult.error;
  if (reputationResult.error) throw reputationResult.error;

  const merchants = merchantsResult.data ?? [];
  const stores = storesResult.data ?? [];
  const accounts = accountsResult.data ?? [];
  const checks = checksResult.data ?? [];

  const activeMerchantIds = new Set<string>();
  for (const store of stores) {
    if (store.is_active) {
      activeMerchantIds.add(store.merchant_id);
    }
  }
  for (const account of accounts) {
    if (account.active) {
      activeMerchantIds.add(account.merchant_id);
    }
  }

  const protectedOrders = checks.length;
  const blockedChecks = checks.filter((check) => check.risk_level === "BLOCK" || check.risk_level === "CRITICAL" || check.recommended_action === "block");
  const blockedOrders = blockedChecks.length;
  const estimatedSavedLosses = blockedChecks.reduce((total, row) => total + Number(row.total_amount ?? row.cart_total ?? 0), 0);
  const connectedProviders = new Set(accounts.filter((account) => account.active).map((account) => account.provider)).size;
  const networkProfiles = reputationResult.count ?? 0;

  const monthByMonth = new Map<string, number>();
  const orderTrendMap = new Map<string, DailyPoint>();
  let currentMonthProtected = 0;
  let previousMonthProtected = 0;
  let currentMonthMerchants = 0;
  let previousMonthMerchants = 0;

  for (const merchant of merchants) {
    const createdAt = new Date(merchant.created_at);
    if (createdAt >= currentMonthStart) {
      currentMonthMerchants += 1;
    } else if (createdAt >= previousMonthStart) {
      previousMonthMerchants += 1;
    }

    const monthKey = createdAt.toISOString().slice(0, 7);
    monthByMonth.set(monthKey, (monthByMonth.get(monthKey) ?? 0) + 1);
  }

  for (const check of checks) {
    const createdAt = new Date(check.created_at);
    if (createdAt >= currentMonthStart) {
      currentMonthProtected += 1;
    } else if (createdAt >= previousMonthStart) {
      previousMonthProtected += 1;
    }

    if (createdAt < thirtyDaysAgo) {
      continue;
    }

    const day = createdAt.toISOString().slice(0, 10);
    const entry = orderTrendMap.get(day) ?? { day, protectedOrders: 0, blockedOrders: 0, savedLosses: 0 };
    entry.protectedOrders += 1;
    if (check.risk_level === "BLOCK" || check.risk_level === "CRITICAL" || check.recommended_action === "block") {
      entry.blockedOrders += 1;
      entry.savedLosses += Number(check.total_amount ?? check.cart_total ?? 0);
    }
    orderTrendMap.set(day, entry);
  }

  previousMonthProtected = Math.max(previousMonthProtected, 1);
  const monthlyGrowth = Number((((currentMonthProtected - previousMonthProtected) / previousMonthProtected) * 100).toFixed(1));
  const trend = Array.from(orderTrendMap.values()).sort((left, right) => left.day.localeCompare(right.day));
  const merchantGrowthTrend = Array.from({ length: 12 }, (_, index) => {
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - (11 - index));
    const key = date.toISOString().slice(0, 7);
    return monthByMonth.get(key) ?? 0;
  });

  const topRiskMerchants = Array.from(
    checks.reduce((map, check) => {
      const current = map.get(check.merchant_id) ?? { protected: 0, blocked: 0, saved: 0 };
      current.protected += 1;
      if (check.risk_level === "BLOCK" || check.risk_level === "CRITICAL" || check.recommended_action === "block") {
        current.blocked += 1;
        current.saved += Number(check.total_amount ?? check.cart_total ?? 0);
      }
      map.set(check.merchant_id, current);
      return map;
    }, new Map<string, { protected: number; blocked: number; saved: number }>() )
  )
    .map(([merchantId, stats]) => {
      const merchant = merchants.find((row) => row.id === merchantId);
      return {
        merchantId,
        name: merchant?.name ?? merchantId,
        protected: stats.protected,
        blocked: stats.blocked,
        saved: stats.saved
      };
    })
    .sort((left, right) => right.saved - left.saved)
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-700/40 bg-slate-800/20 p-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="space-y-2">
            <AdminBadge tone="emerald">Admin Overview</AdminBadge>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Fraud intelligence overview</h1>
            <p className="max-w-xl text-sm leading-6 text-slate-400">
              Merchants, customer risk, delivery networks, API activity, and operational audits across Algeria.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2">
            <Link href="/admin/merchants" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700/40 hover:text-white">
              Merchants
            </Link>
            <Link href="/admin/network?tab=reputation" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700/40 hover:text-white">
              Customers
            </Link>
            <Link href="/admin/network" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700/40 hover:text-white">
              Network
            </Link>
            <Link href="/admin/providers" className="rounded-xl bg-[#D6A74C] px-3 py-2 text-sm font-semibold text-[#08111A] transition hover:brightness-110">
              Live ops
            </Link>
            <Link href="/admin/internal/delivery-cache" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700/40 hover:text-white">
              Delivery cache
            </Link>
          </nav>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Total Merchants" value={merchants.length} delta="All merchants in the portfolio" tone="sky" />
        <AdminMetricCard label="Active Merchants" value={activeMerchantIds.size} delta="Merchants with active stores or delivery accounts" tone="emerald" />
        <AdminMetricCard label="Protected Orders" value={protectedOrders.toLocaleString()} delta="Orders evaluated by the intelligence layer" tone="gold" sparkline={trend.map((point) => point.protectedOrders)} />
        <AdminMetricCard label="Blocked Orders" value={blockedOrders.toLocaleString()} delta="Orders stopped before shipment" tone="rose" sparkline={trend.map((point) => point.blockedOrders)} />
        <AdminMetricCard label="Estimated Saved Losses" value={`${Math.round(estimatedSavedLosses).toLocaleString()} DZD`} delta="Blocked order value preserved" tone="amber" />
        <AdminMetricCard label="Network Reputation Profiles" value={networkProfiles.toLocaleString()} delta="Global customer reputations tracked" tone="violet" />
        <AdminMetricCard label="Connected Delivery Providers" value={connectedProviders.toString()} delta="Unique providers currently connected" tone="sky" />
        <AdminMetricCard label="Monthly Growth" value={`${monthlyGrowth >= 0 ? "+" : ""}${monthlyGrowth}%`} delta="Merchant signups this month vs last month" tone={monthlyGrowth >= 0 ? "emerald" : "rose"} sparkline={merchantGrowthTrend} />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <AdminPanel className="xl:col-span-2 space-y-4">
          <AdminSectionHeader
            eyebrow="Trend line"
            title="Protection velocity"
            description="Daily protected and blocked order flow over the last 30 days."
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Protected orders</p>
              <div className="mt-4 h-24 text-[#D6A74C]">
                <Sparkline values={trend.map((point) => point.protectedOrders)} className="h-full w-full" />
              </div>
            </div>
            <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Blocked orders</p>
              <div className="mt-4 h-24 text-rose-400">
                <Sparkline values={trend.map((point) => point.blockedOrders)} className="h-full w-full" />
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Saved losses trend</p>
              <p className="mt-2 text-xl font-bold text-amber-300">{Math.round(trend.reduce((sum, point) => sum + point.savedLosses, 0)).toLocaleString()} DZD</p>
            </div>
            <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Protected today</p>
              <p className="mt-2 text-xl font-bold text-slate-100">{trend.at(-1)?.protectedOrders ?? 0}</p>
            </div>
            <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Blocked today</p>
              <p className="mt-2 text-xl font-bold text-rose-300">{trend.at(-1)?.blockedOrders ?? 0}</p>
            </div>
          </div>
        </AdminPanel>

        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Executive watchlist"
            title="Top risk merchants"
            description="Largest saved-loss profiles ranked by blocked order value."
          />
          <FlowList
            emptyLabel="No blocked merchant activity yet."
            items={topRiskMerchants.map((merchant) => ({
              title: merchant.name,
              subtitle: `${merchant.protected} protected orders · ${merchant.blocked} blocked`,
              meta: `${Math.round(merchant.saved).toLocaleString()} DZD`,
              tone: "rose"
            }))}
          />
        </AdminPanel>
      </section>
    </div>
  );
}
