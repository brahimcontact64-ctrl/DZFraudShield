import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { listMerchantNotifications } from "@/lib/merchant-ops";
import { getI18nServer } from "@/lib/i18n/server";
import { NotificationCenterClient } from "@/components/notifications/notification-center-client";

export default async function DashboardNotificationsPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const notifications = await listMerchantNotifications(merchantId);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.notifications.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.notifications.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.notifications.subtitle")}</p>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Metric label={t("dashboard.notifications.openAlerts")} value={notifications.filter((item) => !item.resolved).length} />
        <Metric label={t("dashboard.notifications.usefulEvents")} value={notifications.length} />
      </section>

      {notifications.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          {t("dashboard.notifications.empty")}
        </div>
      ) : (
        <NotificationCenterClient initialItems={notifications} />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-2 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}
