import { OrderActions } from "@/components/orders/order-actions";
import type { CallCenterCard } from "@/lib/dashboard-call-center";
import { getI18nServer } from "@/lib/i18n/server";
import { formatDateOnly } from "@/lib/format-date";

export async function OrderOperationsCard({ order, compact = false }: { order: CallCenterCard; compact?: boolean }) {
  const { t } = await getI18nServer();
  const trust = getTrustBadge(order.networkTrustLevel, t);
  const deliveredOrders = order.networkDeliveredOrders;
  const refusedOrders = order.networkRefusedOrders;
  const returnedOrders = order.networkReturnedOrders;

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-slate-900">{order.customerName}</p>
          <p className="text-sm text-slate-600">{order.phone ?? t("orderCard.noPhone")}</p>
          <p className="mt-1 text-xs font-medium text-slate-500">{order.wilaya ?? t("orderCard.unknownWilaya")}{order.commune ? `, ${order.commune}` : ""}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${trust.className}`}>{trust.label}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Field label={t("orderCard.orderAmount")} value={`${order.orderAmount.toLocaleString("fr-DZ")} DZD`} />
        <Field label={t("orderCard.currentStatus")} value={order.lastCallEventLabel ?? humanizeStatus(order.queue)} />
        <Field label={t("orderCard.shipmentStatus")} value={humanizeStatus(order.shipment?.shipmentStatus ?? order.queue)} />
        <Field label={t("orderCard.trustLevel")} value={humanizeTrustLevel(order.networkTrustLevel, t)} />
      </div>

      <div className="mt-3 space-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{t("orderCard.customerIntelligenceCard")}</p>
        <div className="grid grid-cols-2 gap-2 text-xs text-slate-700">
          <p><span className="font-semibold text-slate-900">{t("orderCard.riskScore")}:</span> {order.riskScore}</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.recommendation")}:</span> {humanizeRecommendation(order.recommendedAction, t)}</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.seenByMerchants")}:</span> {order.networkMerchantCount}</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.deliveredOrders")}:</span> {deliveredOrders}</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.refusedOrders")}:</span> {refusedOrders}</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.returnedOrders")}:</span> {returnedOrders}</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.returnRate")}:</span> {order.networkReturnRate}%</p>
          <p><span className="font-semibold text-slate-900">{t("orderCard.lastActivity")}:</span> {order.networkLastActivityAt ? formatDateOnly(order.networkLastActivityAt) : t("orderCard.noRecentActivity")}</p>
        </div>
      </div>

      <div className="mt-3">
        <OrderActions
          checkId={order.id}
          phone={order.phone}
          compact={compact}
          showSecondaryActions={!compact}
          viewDetailsHref={`/dashboard/checks/${order.id}`}
          initialDecision={order.queue === "CONFIRMED" ? "ACCEPTED" : order.queue === "REFUSED" ? "BLOCKED" : null}
          initialProvider={order.shipment?.provider ?? null}
          initialShipmentStatus={order.shipment?.shipmentStatus ?? null}
          initialTrackingNumber={order.shipment?.trackingNumber ?? null}
          initialLabelPdfUrl={order.shipment?.labelPdfUrl ?? null}
          initialLabelsUrl={order.shipment?.labelsUrl ?? null}
          initialLabelUrl={order.shipment?.labelPdfUrl ?? order.shipment?.labelsUrl ?? order.shipment?.labelUrl ?? null}
        />
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{t("orderCard.recentTimeline")}</p>
        {order.customerTimeline.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">{t("orderCard.noPreviousActivity")}</p>
        ) : (
          <ul className="mt-2 space-y-1.5 text-xs text-slate-700">
            {order.customerTimeline.map((item, index) => (
              <li key={`${order.id}-${index}-${item.date}`} className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1.5">
                <span className="font-semibold text-slate-900">{item.status}</span>
                <span className="text-slate-500">{new Date(item.date).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function getTrustBadge(level: string | null, t: (key: string) => string): { label: string; className: string } {
  const value = String(level ?? "WATCHLIST").toUpperCase();
  if (value === "TRUSTED") {
    return { label: t("orderCard.trustReliable"), className: "bg-emerald-100 text-emerald-700" };
  }
  if (value === "HIGH_RISK" || value === "BLACKLIST") {
    return { label: t("orderCard.trustHighRisk"), className: "bg-rose-100 text-rose-700" };
  }
  return { label: t("orderCard.trustWatchlist"), className: "bg-amber-100 text-amber-700" };
}

function humanizeRecommendation(action: string | null, t: (key: string) => string): string {
  const value = String(action ?? "verify").toLowerCase();
  if (value === "accept") return t("orderActions.confirm");
  if (value === "block") return t("orderActions.refuse");
  return t("orderActions.verify");
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function humanizeTrustLevel(level: string | null, t: (key: string) => string): string {
  const value = String(level ?? "WATCHLIST").toUpperCase();
  if (value === "TRUSTED") return t("orderCard.reliable");
  if (value === "HIGH_RISK" || value === "BLACKLIST") return t("orderCard.highRisk");
  return t("orderCard.watchlist");
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
