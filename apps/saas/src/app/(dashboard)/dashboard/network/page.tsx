import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { listNetworkMerchantView } from "@/lib/merchant-ops";
import { getI18nServer } from "@/lib/i18n/server";

export default async function DashboardNetworkPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const rows = await listNetworkMerchantView(merchantId);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.network.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.network.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.network.subtitle")}</p>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          {t("dashboard.network.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <article key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)]">
              <div className="grid gap-3 md:grid-cols-5">
                <Cell label={t("dashboard.network.trustLevel")} value={row.trustLevel} />
                <Cell label={t("dashboard.network.seenBy")} value={row.seenByMerchants} />
                <Cell label={t("dashboard.network.successfulDeliveries")} value={row.successfulDeliveries} />
                <Cell label={t("dashboard.network.failedDeliveries")} value={row.failedDeliveries} />
                <Cell label={t("dashboard.network.recommendation")} value={row.recommendation} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
