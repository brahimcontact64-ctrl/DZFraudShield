import Link from "next/link";
import { redirect } from "next/navigation";
import { getOverviewData, listMerchantNotifications } from "@/lib/merchant-ops";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { listCallCenterCards } from "@/lib/dashboard-call-center";
import { OrderOperationsCard } from "@/components/orders/order-operations-card";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";
import { formatDateTime } from "@/lib/format-date";

export default async function DashboardPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }
  await redirectIfSubscriptionBlocked(merchantId);

  const [overview, recentCards] = await Promise.all([
    getOverviewData(merchantId),
    listCallCenterCards(merchantId, 8)
  ]);
  const activityFeed = (await listMerchantNotifications(merchantId)).slice(0, 6);

  const codWaiting = Math.max(overview.metrics.ordersToday - overview.metrics.confirmedOrders - overview.metrics.refusedOrders, 0);
  const waitingCalls = overview.metrics.noAnswerOrders;
  const returnsCount = overview.metrics.returnRate >= 100
    ? overview.metrics.deliveredOrders
    : Math.round((overview.metrics.deliveredOrders * overview.metrics.returnRate) / Math.max(100 - overview.metrics.returnRate, 1));

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.overview.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.overview.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.overview.subtitle")}</p>
        <p className="sr-only">{t("dashboard.overview.a11ySummary")}</p>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Metric label={t("dashboard.overview.revenueToday")} value={`${overview.metrics.revenueDzd.toLocaleString("fr-DZ")} DZD`} tone="success" />
        <Metric label={t("dashboard.overview.deliveredToday")} value={overview.metrics.deliveredOrders} tone="success" />
        <Metric label={t("dashboard.overview.codWaiting")} value={codWaiting} tone="warning" />
        <Metric label={t("dashboard.overview.returns")} value={returnsCount} tone="warning" />
        <Metric label={t("dashboard.overview.activeShipments")} value={overview.metrics.activeShipments} />
        <Metric label={t("dashboard.overview.waitingCalls")} value={waitingCalls} tone="warning" />
      </section>

      <p className="text-xs text-slate-500">{t("dashboard.overview.cardsHint")}</p>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">{t("dashboard.overview.recentCards")}</h2>
          <Link href="/dashboard/orders" className="text-xs font-semibold text-brand hover:underline">{t("dashboard.overview.viewAll")}</Link>
        </div>

        {recentCards.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
            {t("dashboard.overview.empty")}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {recentCards.map((order) => (
              <OrderOperationsCard key={order.id} order={order} compact />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Merchant activity feed</h2>
          <Link href="/dashboard/notifications" className="text-xs font-semibold text-brand hover:underline">Open notifications</Link>
        </div>
        {activityFeed.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-6 text-sm text-slate-500">
            No activity yet.
          </div>
        ) : (
          <div className="space-y-2">
            {activityFeed.map((item) => (
              <article key={item.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-900">{item.event}</p>
                  <p className="text-[11px] text-slate-500">{formatDateTime(item.createdAt)}</p>
                </div>
                <p className="mt-1 text-xs text-slate-600">{item.message}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "success" | "warning" }) {
  const toneClass = tone === "success"
    ? "text-emerald-700"
    : tone === "warning"
      ? "text-amber-700"
      : "text-slate-900";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
