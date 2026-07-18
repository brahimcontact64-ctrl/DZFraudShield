import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { ExternalLinkIcon, BarChartIcon, KeyIcon } from "@/components/ui/icons";
import { getI18nServer } from "@/lib/i18n/server";
import { formatDateOnly } from "@/lib/format-date";

export default async function StoresPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) redirect("/auth/login");

  const supabase = createClient();
  const { data: stores } = await supabase
    .from("stores")
    .select("id, name, domain, is_active, created_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{t("dashboard.stores.title")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("dashboard.stores.subtitle")}</p>
        </div>
        <button className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-soft">
          {t("dashboard.stores.connect")}
        </button>
      </div>

      {/* Store grid */}
      {(stores ?? []).length === 0 ? (
        <EmptyStores emptyTitle={t("dashboard.stores.emptyTitle")} emptyDesc={t("dashboard.stores.emptyDesc")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(stores ?? []).map((store) => (
            <StoreCard key={store.id} store={store} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function StoreCard({ store, t }: {
  store: { id: string; name: string; domain: string; is_active: boolean; created_at: string };
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card transition-shadow hover:shadow-card-hover">
      {/* Card header */}
      <div className="flex items-start justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-slate-900">{store.name}</p>
            <p className="text-xs text-slate-400">{store.domain}</p>
          </div>
        </div>
        <StatusDot active={store.is_active} activeLabel={t("dashboard.apiKeys.active")} inactiveLabel={t("dashboard.apiKeys.inactive")} />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 divide-x divide-slate-100 border-t border-slate-100">
        <div className="px-5 py-3">
          <p className="text-xs text-slate-400">{t("dashboard.stores.connected")}</p>
          <p className="mt-0.5 text-sm font-medium text-slate-700">{formatDateOnly(store.created_at)}</p>
        </div>
        <div className="px-5 py-3">
          <p className="text-xs text-slate-400">{t("dashboard.apiKeys.status")}</p>
          <p className={`mt-0.5 text-sm font-semibold ${store.is_active ? "text-emerald-600" : "text-slate-400"}`}>
            {store.is_active ? t("dashboard.apiKeys.active") : t("dashboard.apiKeys.inactive")}
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3">
        <ActionBtn icon={<ExternalLinkIcon size={13} />} label={t("dashboard.stores.manage")} />
        <ActionBtn icon={<BarChartIcon size={13} />} label={t("dashboard.stores.analytics")} />
        <ActionBtn icon={<KeyIcon size={13} />} label={t("dashboard.stores.apiKeys")} href="/dashboard/api-keys" />
      </div>
    </div>
  );
}

function StatusDot({ active, activeLabel, inactiveLabel }: { active: boolean; activeLabel: string; inactiveLabel: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${active ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-slate-400"}`} />
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

function ActionBtn({ icon, label, href }: { icon: React.ReactNode; label: string; href?: string }) {
  const cls = "flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900";
  if (href) return <Link href={href as any} className={cls}>{icon}{label}</Link>;
  return <button className={cls}>{icon}{label}</button>;
}

function EmptyStores({ emptyTitle, emptyDesc }: { emptyTitle: string; emptyDesc: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-700">{emptyTitle}</p>
      <p className="mt-1 text-xs text-slate-400">{emptyDesc}</p>
    </div>
  );
}
