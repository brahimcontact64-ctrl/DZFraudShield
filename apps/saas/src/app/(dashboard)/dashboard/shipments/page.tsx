import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { listShipmentControlCards } from "@/lib/merchant-ops";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";
import { formatDateTime, formatDateOnly } from "@/lib/format-date";

const STATUSES = [
  "SHIPMENT_CREATED",
  "AWAITING_PICKUP",
  "PICKED_UP",
  "IN_SORTING_CENTER",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION_CITY",
  "OUT_FOR_DELIVERY",
  "DELIVERED_SUCCESSFULLY",
  "CUSTOMER_REFUSED_PARCEL",
  "CUSTOMER_UNREACHABLE",
  "DELIVERY_FAILED",
  "RETURNED_TO_SENDER",
  "RETURN_RECEIVED_BY_MERCHANT",
] as const;

export default async function ShipmentsPage({ searchParams }: { searchParams?: { status?: string } }) {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }
  await redirectIfSubscriptionBlocked(merchantId);

  const status = String(searchParams?.status ?? "ALL").toUpperCase();
  const allShipments = await listShipmentControlCards(merchantId);
  const shipments = status === "ALL" ? allShipments : allShipments.filter((item) => item.shipmentStatus === status);

  const counts = STATUSES.reduce((acc, current) => {
    acc[current] = allShipments.filter((item) => item.shipmentStatus === current).length;
    return acc;
  }, {} as Record<(typeof STATUSES)[number], number>);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.shipments.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.shipments.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.shipments.subtitle")}</p>
      </section>

      <section className="flex flex-wrap gap-2">
        <StatusFilter status={status} value="ALL" label={`${t("dashboard.shipments.all")} (${allShipments.length})`} />
        {STATUSES.map((item) => (
          <StatusFilter key={item} status={status} value={item} label={`${humanizeStatus(item)} (${counts[item]})`} />
        ))}
      </section>

      {shipments.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          {t("dashboard.shipments.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {shipments.map((shipment) => (
            <article key={shipment.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
              <div className="grid gap-3 md:grid-cols-5">
                <Field label={t("dashboard.shipments.trackingNumber")} value={shipment.trackingNumber} />
                <Field label={t("dashboard.shipments.provider")} value={shipment.deliveryCompanyName} />
                <Field label={t("dashboard.shipments.shipmentStatus")} value={shipment.shipmentStatusLabel} />
                <Field
                  label={t("dashboard.shipments.labelLink")}
                  value={shipment.labelLink ? <a href={shipment.labelLink} target="_blank" rel="noreferrer" className="text-brand hover:underline">{t("dashboard.shipments.openLabel")}</a> : t("dashboard.shipments.notAvailable")}
                />
                <Field label={t("dashboard.shipments.createdDate")} value={formatDateOnly(shipment.createdDate)} />
                <Field label={t("dashboard.shipments.lastUpdate")} value={formatDateTime(shipment.lastUpdateDate)} />
              </div>

              <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Status timeline</p>
                {shipment.statusHistory.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">No lifecycle events yet.</p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {shipment.statusHistory.map((event, index) => (
                      <div key={`${shipment.id}-event-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                        <p className="text-xs font-semibold text-slate-800">{event.newStatusLabel}</p>
                        <p className="text-[11px] text-slate-500">{formatDateTime(event.eventDate)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function StatusFilter({ status, value, label }: { status: string; value: string; label: string }) {
  const active = status === value || (status === "ALL" && value === "ALL");
  return (
    <a
      href={value === "ALL" ? "?" : `?status=${value}`}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700"}`}
    >
      {label}
    </a>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
