import { redirect } from "next/navigation";
import { getDeliveryProviders } from "@/lib/delivery-intelligence/dashboard";
import { listMerchantDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { DeliveryProvidersClient } from "./providers-client";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";

export default async function DeliveryProvidersPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) redirect("/auth/login");
  await redirectIfSubscriptionBlocked(merchantId);

  const [providers, accounts] = await Promise.all([
    getDeliveryProviders(),
    listMerchantDeliveryAccounts(merchantId)
  ]);

  const merchantVisibleProviders = providers.filter((p) => p.visible_to_merchants === true);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{t("dashboard.deliveryProviders.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("dashboard.deliveryProviders.subtitle")}
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3">
        <MiniStat label={t("dashboard.deliveryProviders.available")} value={merchantVisibleProviders.length} />
        <MiniStat label={t("dashboard.deliveryProviders.connected")} value={accounts.filter((a) => a.active && a.connection_status === "connected").length} tone="success" />
        <MiniStat label={t("dashboard.deliveryProviders.attention")} value={accounts.filter((a) => a.connection_status === "failed" || a.connection_status === "attention_required" || a.connection_status === "credentials_invalid").length} tone="warning" />
      </div>

      {/* Providers */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.deliveryProviders.manage")}</p>
        </div>
        <div className="p-6">
          <DeliveryProvidersClient
            initialProviders={merchantVisibleProviders}
            initialAccounts={accounts}
          />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) {
  const valueClass = tone === "success" ? "text-emerald-600" : tone === "warning" ? "text-amber-600" : "text-brand";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-2 text-3xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}
