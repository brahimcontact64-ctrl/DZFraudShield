import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { listCallCenterCards, type CallCenterQueue } from "@/lib/dashboard-call-center";
import { OrderOperationsCard } from "@/components/orders/order-operations-card";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";

const QUEUE_ORDER: CallCenterQueue[] = ["NEW", "CALL_LATER", "NO_ANSWER", "CONFIRMED", "REFUSED"];

const QUEUE_META: Record<CallCenterQueue, { tone: string }> = {
  NEW: { tone: "border-sky-200 bg-sky-50 text-sky-700" },
  CALL_LATER: { tone: "border-amber-200 bg-amber-50 text-amber-700" },
  NO_ANSWER: { tone: "border-orange-200 bg-orange-50 text-orange-700" },
  CONFIRMED: { tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  REFUSED: { tone: "border-rose-200 bg-rose-50 text-rose-700" },
};

export default async function DashboardCallCenterPage({ searchParams }: { searchParams?: { shipment_error?: string } }) {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();

  if (!merchantId) {
    redirect("/auth/login");
  }
  await redirectIfSubscriptionBlocked(merchantId);

  const cards = await listCallCenterCards(merchantId);
  const grouped = new Map<CallCenterQueue, typeof cards>();
  for (const queue of QUEUE_ORDER) {
    grouped.set(queue, cards.filter((card) => card.queue === queue));
  }

  const shipmentError = searchParams?.shipment_error === "shipping_profile_missing"
    ? t("dashboard.callCenter.shipmentError")
    : null;

  return (
    <div className="space-y-6">
      {shipmentError ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          {shipmentError}
        </div>
      ) : null}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.callCenter.tag")}</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.callCenter.title")}</h1>
            <p className="mt-2 text-sm text-slate-600">{t("dashboard.callCenter.subtitle")}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {QUEUE_ORDER.map((queue) => (
              <div key={queue} className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{t(`dashboard.callCenter.queues.${queue}.label`)}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{grouped.get(queue)?.length ?? 0}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {QUEUE_ORDER.map((queue) => {
        const items = grouped.get(queue) ?? [];
        return (
          <section key={queue} className="space-y-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${QUEUE_META[queue].tone}`}>{t(`dashboard.callCenter.queues.${queue}.label`)}</div>
                <p className="mt-2 text-sm text-slate-500">{t(`dashboard.callCenter.queues.${queue}.description`)}</p>
              </div>
              <p className="text-sm font-medium text-slate-500">{items.length === 1 ? t("dashboard.callCenter.ordersCount", { count: items.length }) : t("dashboard.callCenter.ordersCountPlural", { count: items.length })}</p>
            </div>

            {items.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-200 bg-white px-5 py-8 text-sm text-slate-400">{t("dashboard.callCenter.emptyQueue")}</div>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {items.map((card) => (
                  <OrderOperationsCard key={card.id} order={card} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
