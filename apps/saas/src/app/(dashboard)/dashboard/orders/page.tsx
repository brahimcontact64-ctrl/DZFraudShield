import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { listCallCenterCards } from "@/lib/dashboard-call-center";
import { OrderOperationsCard } from "@/components/orders/order-operations-card";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";

export default async function DashboardOrdersPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }
  await redirectIfSubscriptionBlocked(merchantId);

  const orders = await listCallCenterCards(merchantId, 40);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#D6A74C]">{t("dashboard.orders.tag")}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-brand">{t("dashboard.orders.title")}</h1>
        <p className="max-w-2xl text-sm text-slate-500">
          {t("dashboard.orders.subtitle")}
        </p>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white px-5 py-12 text-center text-sm text-slate-400">
          {t("dashboard.orders.empty")}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => (
            <OrderOperationsCard key={order.id} order={order} compact />
          ))}
        </div>
      )}
    </div>
  );
}
