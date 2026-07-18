import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getSmartInventoryData } from "@/lib/merchant-ops";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";

export default async function InventoryPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }
  await redirectIfSubscriptionBlocked(merchantId);

  const rows = await getSmartInventoryData(merchantId);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.inventory.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.inventory.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.inventory.subtitle")}</p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <article className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">{t("dashboard.inventory.modeA")}</p>
          <p className="mt-1 text-base font-semibold text-emerald-900">{t("dashboard.inventory.modeATitle")}</p>
          <p className="mt-2 text-sm text-emerald-800">{t("dashboard.inventory.modeADesc")}</p>
        </article>
        <article className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">{t("dashboard.inventory.modeB")}</p>
          <p className="mt-1 text-base font-semibold text-amber-900">{t("dashboard.inventory.modeBTitle")}</p>
          <p className="mt-2 text-sm text-amber-800">{t("dashboard.inventory.modeBDesc")}</p>
          <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-amber-900">{t("dashboard.inventory.formula")}</p>
        </article>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          {t("dashboard.inventory.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((item) => {
            const estimatedDaysLeft = item.stockQuantity !== null
              ? Number((item.stockQuantity / Math.max(item.salesVelocityPerDay, 0.1)).toFixed(1))
              : null;

            return (
              <article key={item.productName} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)]">
                <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
                  <Cell label={t("dashboard.inventory.product")} value={item.productName} />
                  <Cell label={t("dashboard.inventory.delivered")} value={item.deliveredOrders} />
                  <Cell label={t("dashboard.inventory.returned")} value={item.returnedOrders} />
                  <Cell label={t("dashboard.inventory.salesVelocity")} value={`${item.salesVelocityPerDay}/${t("dashboard.inventory.day")}`} />
                  <Cell label={t("dashboard.inventory.currentStock")} value={item.stockQuantity ?? t("dashboard.inventory.notProvided")} />
                  <Cell label={t("dashboard.inventory.estimatedStock")} value={estimatedDaysLeft === null ? t("dashboard.inventory.na") : `${Math.max(Math.round(item.salesVelocityPerDay * estimatedDaysLeft), 0)}`} />
                  <Cell label={t("dashboard.inventory.daysRemaining")} value={estimatedDaysLeft === null ? t("dashboard.inventory.na") : `${estimatedDaysLeft} ${t("dashboard.inventory.days")}`} />
                  <Cell
                    label={t("dashboard.inventory.lowStockRisk")}
                    value={<span className={item.estimatedStockHealth === "Critical" ? "text-rose-700" : item.estimatedStockHealth === "Low" ? "text-amber-700" : "text-emerald-700"}>{humanizeRisk(item.estimatedStockHealth, t)}</span>}
                  />
                </div>
                <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{item.message}</p>
                <p className="mt-2 text-xs text-slate-500">{t("dashboard.inventory.supportingHint")}</p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function humanizeRisk(value: "Healthy" | "Low" | "Critical", t: (key: string) => string): string {
  if (value === "Critical") return t("dashboard.inventory.riskHigh");
  if (value === "Low") return t("dashboard.inventory.riskMedium");
  return t("dashboard.inventory.riskLow");
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
