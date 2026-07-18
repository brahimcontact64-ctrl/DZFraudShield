import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";

export default async function CustomerIntelligencePage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();

  if (!merchantId) {
    redirect("/auth/login");
  }
  await redirectIfSubscriptionBlocked(merchantId);

  const supabase = createClient();

  const { data: customerStats } = await supabase
    .from("customer_reputation")
    .select("phone_hash, delivered_count, failed_count, cancelled_count, returned_count, fake_count, unreachable_count")
    .eq("merchant_id", merchantId)
    .order("delivered_count", { ascending: false })
    .limit(25);

  const customers = (customerStats ?? []).map((customer) => {
    const delivered = Number(customer.delivered_count ?? 0);
    const failed = Number(customer.failed_count ?? 0);
    const returned = Number(customer.returned_count ?? 0) + Number(customer.cancelled_count ?? 0) + Number(customer.fake_count ?? 0) + Number(customer.unreachable_count ?? 0);
    const total = delivered + failed + returned;
    const trustRate = total > 0 ? delivered / total : 0;

    return {
      phoneHash: customer.phone_hash,
      delivered,
      returned,
      total,
      trustRate,
      trustLevel: trustRate >= 0.8 ? t("orderCard.reliable") : trustRate >= 0.5 ? t("orderCard.watchlist") : t("orderCard.highRisk")
    };
  });

  const stats = {
    totalCustomers: customers.length,
    reliableCustomers: customers.filter((customer) => customer.trustLevel === t("orderCard.reliable")).length,
    watchlistCustomers: customers.filter((customer) => customer.trustLevel === t("orderCard.watchlist")).length,
    highRiskCustomers: customers.filter((customer) => customer.trustLevel === t("orderCard.highRisk")).length,
    averageTrustRate: customers.length > 0 ? customers.reduce((sum, customer) => sum + customer.trustRate, 0) / customers.length : 0
  };

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.customerIntelligence.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.customerIntelligence.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.customerIntelligence.subtitle")}</p>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t("dashboard.customerIntelligence.totalCustomers")} value={stats.totalCustomers} />
        <Metric label={t("dashboard.customerIntelligence.reliable")} value={stats.reliableCustomers} tone="success" />
        <Metric label={t("dashboard.customerIntelligence.watchlist")} value={stats.watchlistCustomers} tone="warning" />
        <Metric label={t("dashboard.customerIntelligence.highRisk")} value={stats.highRiskCustomers} tone="danger" />
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <HighlightCard title={t("dashboard.customerIntelligence.trustWorkflow")} description={t("dashboard.customerIntelligence.trustWorkflowDesc")} />
        <HighlightCard title={t("dashboard.customerIntelligence.authority")} description={t("dashboard.customerIntelligence.authorityDesc")} />
        <HighlightCard title={t("dashboard.customerIntelligence.history")} description={t("dashboard.customerIntelligence.historyDesc")} />
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.customerIntelligence.cardTag")}</p>
            <h2 className="mt-2 text-lg font-semibold text-slate-900">{t("dashboard.customerIntelligence.breakdown")}</h2>
          </div>
          <p className="text-sm text-slate-500">{t("dashboard.customerIntelligence.averageTrust", { rate: (stats.averageTrustRate * 100).toFixed(0) })}</p>
        </div>

        <div className="mt-4 space-y-3">
          {customers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-sm text-slate-500">{t("dashboard.customerIntelligence.empty")}</div>
          ) : (
            customers.slice(0, 8).map((customer) => (
              <div key={customer.phoneHash} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{customer.phoneHash}</p>
                    <p className="text-xs text-slate-500">{t("dashboard.customerIntelligence.deliveredReturned", { delivered: customer.delivered, returned: customer.returned })}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${customer.trustLevel === "Reliable" ? "bg-emerald-100 text-emerald-700" : customer.trustLevel === "Watchlist" ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>
                    {customer.trustLevel}
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                  <div className={`h-full rounded-full ${customer.trustLevel === "Reliable" ? "bg-emerald-500" : customer.trustLevel === "Watchlist" ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${Math.max(4, Math.round(customer.trustRate * 100))}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "success" | "warning" | "danger" }) {
  const toneClass = tone === "success"
    ? "text-emerald-700"
    : tone === "warning"
      ? "text-amber-700"
      : tone === "danger"
        ? "text-rose-700"
        : "text-slate-900";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function HighlightCard({ title, description }: { title: string; description: string }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)]">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
    </section>
  );
}