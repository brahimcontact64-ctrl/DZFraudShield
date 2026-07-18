import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ApiKeyGenerator } from "./key-generator";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";
import { formatDateTime, formatDateOnly } from "@/lib/format-date";

export default async function ApiKeysPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) redirect("/auth/login");
  await redirectIfSubscriptionBlocked(merchantId);

  const supabase = createClient();
  const { data: keys } = await supabase
    .from("merchant_api_keys")
    .select("id, key_name, key_prefix, is_active, created_at, last_used_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{t("dashboard.apiKeys.title")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("dashboard.apiKeys.subtitle")}</p>
        </div>
      </div>

      {/* Security notice */}
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-amber-600">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-amber-800">
          {t("dashboard.apiKeys.notice")}
        </span>
      </div>

      {/* Generate */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-sm font-semibold text-slate-700">{t("dashboard.apiKeys.generate")}</p>
        <p className="mt-0.5 text-xs text-slate-400">{t("dashboard.apiKeys.generateDesc")}</p>
        <div className="mt-4">
          <ApiKeyGenerator />
        </div>
      </div>

      {/* Keys list */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 bg-slate-50 px-5 py-3.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.apiKeys.activeKeys")}</p>
        </div>
        {(keys ?? []).length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400">{t("dashboard.apiKeys.empty")}</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3">{t("dashboard.apiKeys.name")}</th>
                <th className="px-5 py-3">{t("dashboard.apiKeys.prefix")}</th>
                <th className="px-5 py-3">{t("dashboard.apiKeys.status")}</th>
                <th className="px-5 py-3">{t("dashboard.apiKeys.lastUsed")}</th>
                <th className="px-5 py-3">{t("dashboard.apiKeys.created")}</th>
              </tr>
            </thead>
            <tbody>
              {(keys ?? []).map((key) => (
                <tr key={key.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-4 font-medium text-slate-800">{key.key_name}</td>
                  <td className="px-5 py-4">
                    <code className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
                      {key.key_prefix}••••••••
                    </code>
                  </td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${key.is_active ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-500"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${key.is_active ? "bg-emerald-500" : "bg-slate-400"}`} />
                      {key.is_active ? t("dashboard.apiKeys.active") : t("dashboard.apiKeys.inactive")}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-400">
                    {key.last_used_at ? formatDateTime(key.last_used_at) : <span className="text-slate-300">{t("dashboard.apiKeys.never")}</span>}
                  </td>
                  <td className="px-5 py-4 text-slate-400">
                    {formatDateOnly(key.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}



