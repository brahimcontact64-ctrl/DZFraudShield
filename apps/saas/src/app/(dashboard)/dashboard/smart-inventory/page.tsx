import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getSmartInventoryData } from "@/lib/merchant-ops";
import { getI18nServer } from "@/lib/i18n/server";

export default async function SmartInventoryPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const rows = await getSmartInventoryData(merchantId);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.inventory.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.inventory.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.inventory.subtitle")}</p>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          {t("dashboard.inventory.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((item) => (
            <article key={item.productName} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)]">
              <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
                <Cell label={t("dashboard.inventory.product")} value={item.productName} />
                <Cell label={t("dashboard.inventory.revenue")} value={`${item.revenueDzd.toLocaleString("fr-DZ")} DZD`} />
                <Cell label={t("dashboard.inventory.delivered")} value={item.deliveredOrders} />
                <Cell label={t("dashboard.inventory.returned")} value={item.returnedOrders} />
                <Cell label={t("dashboard.inventory.returnRate")} value={`${item.returnRate}%`} />
                <Cell label={t("dashboard.inventory.salesVelocity")} value={`${item.salesVelocityPerDay}/${t("dashboard.inventory.day")}`} />
                <Cell label={t("dashboard.inventory.currentStock")} value={item.stockQuantity ?? t("dashboard.inventory.notProvided")} />
                <Cell
                  label={t("dashboard.inventory.estimatedStock")}
                  value={<span className={item.estimatedStockHealth === "Critical" ? "text-rose-700" : item.estimatedStockHealth === "Low" ? "text-amber-700" : "text-emerald-700"}>{item.estimatedStockHealth}</span>}
                />
              </div>
              <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{item.message}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
