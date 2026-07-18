import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getInsightsData } from "@/lib/merchant-ops";
import { MERCHANT_CATEGORY_OPTIONS } from "@/lib/merchant/categories";
import { getI18nServer } from "@/lib/i18n/server";

export default async function InsightsPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const insights = await getInsightsData(merchantId);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.insights.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.insights.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.insights.subtitle")}</p>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t("dashboard.insights.codRevenue")} value={`${insights.summary.revenueDzd.toLocaleString("fr-DZ")} DZD`} />
        <Metric label={t("dashboard.insights.deliveredOrders")} value={insights.summary.deliveredOrders} />
        <Metric label={t("dashboard.insights.returnedOrders")} value={insights.summary.returnedOrders} />
        <Metric label={t("dashboard.insights.returnRate")} value={`${insights.summary.returnRate}%`} />
        <Metric label={t("dashboard.insights.deliveryCost")} value={`${insights.summary.shippingCostTotalDzd.toLocaleString("fr-DZ")} DZD`} />
        <Metric label={t("dashboard.insights.grossMargin")} value={`${insights.summary.grossProfitDzd.toLocaleString("fr-DZ")} DZD`} />
        {insights.summary.netProfitDzd !== null ? <Metric label={t("dashboard.insights.netMargin")} value={`${insights.summary.netProfitDzd.toLocaleString("fr-DZ")} DZD`} /> : null}
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ComingSoonCard title={t("dashboard.insights.categoryInsights")} description={t("dashboard.insights.subtitle")} badge={t("dashboard.insights.comingSoon")} />
        <ComingSoonCard title={t("dashboard.insights.wilayaPerformance")} description={t("dashboard.insights.foundationText")} badge={t("dashboard.insights.comingSoon")} />
        <ComingSoonCard title={t("dashboard.insights.demandTrends")} description={t("dashboard.insights.foundationText")} badge={t("dashboard.insights.comingSoon")} />
        <ComingSoonCard title={t("dashboard.insights.benchmarks")} description={t("dashboard.insights.foundationText")} badge={t("dashboard.insights.comingSoon")} />
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.insights.foundationTag")}</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-900">{t("dashboard.insights.supportedCategories")}</h2>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.insights.foundationText")}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {MERCHANT_CATEGORY_OPTIONS.map((category) => (
            <span key={category.value} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
              {t(`merchantCategory.${category.value}`)}
            </span>
          ))}
        </div>
      </section>

      <p className="text-xs text-slate-500">{t("dashboard.insights.lightweight")}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function ComingSoonCard({ title, description, badge }: { title: string; description: string; badge: string }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)]">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <p className="mt-3 inline-flex rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-700">{badge}</p>
    </section>
  );
}
