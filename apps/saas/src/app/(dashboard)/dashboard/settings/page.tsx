import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { MerchantCategoryPicker } from "@/components/merchant/merchant-category-picker";
import { NotificationSettingsCard } from "@/components/notifications/notification-settings-card";
import { normalizeMerchantCategory } from "@/lib/merchant/categories";
import { getI18nServer } from "@/lib/i18n/server";
import { getMerchantNotificationSettings } from "@/lib/notifications/settings";
import { getMerchantShippingProfile } from "@/lib/delivery-intelligence/shipping-profile";
import { formatDateTime } from "@/lib/format-date";

export default async function SettingsPage({ searchParams }: {
  searchParams?: {
    merchant_category_saved?: string;
    merchant_category_error?: string;
    shipping_profile_saved?: string;
    shipping_profile_error?: string;
  }
}) {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const supabase = createClient();
  const { data: merchant } = await supabase
    .from("merchants")
    .select("id, category, category_updated_at")
    .eq("id", merchantId)
    .maybeSingle();

  const selectedCategory = normalizeMerchantCategory(merchant?.category ?? null);
  const [notificationSettings, shippingProfile] = await Promise.all([
    getMerchantNotificationSettings(merchantId),
    getMerchantShippingProfile(merchantId),
  ]);
  const saved = searchParams?.merchant_category_saved === "1";
  const categoryError = searchParams?.merchant_category_error ? decodeURIComponent(searchParams.merchant_category_error) : null;
  const shippingProfileSaved = searchParams?.shipping_profile_saved === "1";
  const shippingProfileError = searchParams?.shipping_profile_error ? decodeURIComponent(searchParams.shipping_profile_error) : null;

  const sections = [
    {
      id: "general",
      title: t("dashboard.settings.general"),
      description: t("dashboard.settings.generalDesc"),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      content: (
        <div className="space-y-4 text-sm text-slate-600">
          <SettingRow label={t("dashboard.settings.workspace")} value="My Store" />
          <SettingRow label={t("dashboard.settings.timezone")} value="Africa/Algiers (UTC+1)" />
          <SettingRow label={t("dashboard.settings.language")} value="العربية / Français / English" />
        </div>
      )
    },
    {
      id: "shipping",
      title: t("dashboard.settings.shipping"),
      description: t("dashboard.settings.shippingDesc"),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7h18v10H3z" />
          <path d="M3 11h18" />
          <path d="M7 7v10" />
        </svg>
      ),
      content: (
        <div className="space-y-5">
          {shippingProfileError ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{shippingProfileError}</div>
          ) : null}
          {shippingProfileSaved ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{t("dashboard.shippingProfile.saved")}</div>
          ) : null}
          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <form method="post" action="/dashboard/shipping-profile/save" className="space-y-6">
              <section className="grid gap-4 md:grid-cols-2">
                <ShippingField label={t("dashboard.shippingProfile.senderName")} name="sender_name" required defaultValue={shippingProfile?.sender_name ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.senderPhone")} name="sender_phone" required defaultValue={shippingProfile?.sender_phone ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.fromWilaya")} name="from_wilaya_name" required defaultValue={shippingProfile?.from_wilaya_name ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.fromCommune")} name="from_commune_name" required defaultValue={shippingProfile?.from_commune_name ?? ""} />
                <ShippingField className="md:col-span-2" label={t("dashboard.shippingProfile.defaultProductList")} name="default_product_list" required defaultValue={shippingProfile?.default_product_list ?? ""} helper={t("dashboard.shippingProfile.defaultProductListHint")} />
              </section>
              <section className="grid gap-4 md:grid-cols-3">
                <ShippingField label={t("dashboard.shippingProfile.declaredValue")} name="default_declared_value" type="number" step="0.01" required defaultValue={shippingProfile?.default_declared_value?.toString() ?? ""} helper={t("dashboard.shippingProfile.declaredValueHint")} />
                <ShippingField label={t("dashboard.shippingProfile.weight")} name="default_weight" type="number" step="0.001" required defaultValue={shippingProfile?.default_weight?.toString() ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.length")} name="default_length" type="number" step="0.001" required defaultValue={shippingProfile?.default_length?.toString() ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.width")} name="default_width" type="number" step="0.001" required defaultValue={shippingProfile?.default_width?.toString() ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.height")} name="default_height" type="number" step="0.001" required defaultValue={shippingProfile?.default_height?.toString() ?? ""} />
                <ShippingField label={t("dashboard.shippingProfile.stopdeskId")} name="default_stopdesk_id" defaultValue={shippingProfile?.default_stopdesk_id ?? ""} helper={t("dashboard.shippingProfile.stopdeskIdHint")} />
              </section>
              <section className="grid gap-4 md:grid-cols-2">
                <ShippingCheckbox label={t("dashboard.shippingProfile.defaultInsurance")} name="default_do_insurance" checked={shippingProfile?.default_do_insurance ?? false} />
                <ShippingCheckbox label={t("dashboard.shippingProfile.defaultFreeShipping")} name="default_freeshipping" checked={shippingProfile?.default_freeshipping ?? false} />
                <ShippingCheckbox label={t("dashboard.shippingProfile.defaultStopdesk")} name="default_is_stopdesk" checked={shippingProfile?.default_is_stopdesk ?? false} />
                <ShippingField label={t("dashboard.shippingProfile.returnCenterCode")} name="return_center_code" defaultValue={shippingProfile?.return_center_code ?? ""} helper={t("dashboard.shippingProfile.returnCenterCodeHint")} />
              </section>
              <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
                <button type="submit" className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-soft">
                  {t("dashboard.shippingProfile.save")}
                </button>
                <p className="text-xs text-slate-400">{t("dashboard.shippingProfile.autouseHint")}</p>
              </div>
            </form>
            <aside className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{t("dashboard.shippingProfile.howUsed")}</h2>
                <p className="mt-1 text-sm text-slate-500">{t("dashboard.shippingProfile.howUsedDesc")}</p>
              </div>
              <div className="space-y-3 text-sm text-slate-600">
                <ShippingInfoRow label={t("dashboard.apiKeys.status")} value={shippingProfile ? t("dashboard.shippingProfile.configured") : t("dashboard.shippingProfile.missing")} />
                <ShippingInfoRow label={t("dashboard.shippingProfile.sender")} value={shippingProfile?.sender_name ?? t("dashboard.shippingProfile.notSet")} />
                <ShippingInfoRow label={t("dashboard.shippingProfile.origin")} value={shippingProfile ? `${shippingProfile.from_wilaya_name}, ${shippingProfile.from_commune_name}` : t("dashboard.shippingProfile.notSet")} />
                <ShippingInfoRow label={t("dashboard.shippingProfile.declaredValue")} value={shippingProfile ? `${shippingProfile.default_declared_value.toFixed(2)} DZD` : t("dashboard.shippingProfile.notSet")} />
                <ShippingInfoRow label={t("dashboard.shippingProfile.stopdesk")} value={shippingProfile?.default_is_stopdesk ? t("dashboard.settings.on") : t("dashboard.settings.off")} />
              </div>
            </aside>
          </div>
        </div>
      )
    },
    {
      id: "payments",
      title: "Payments",
      description: "Subscription payment instructions and receipt submission.",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7h18v10H3z" />
          <path d="M3 11h18" />
        </svg>
      ),
      content: (
        <div className="space-y-3 text-sm text-slate-600">
          <p>Open the live payment page to view instructions and upload your receipt screenshot.</p>
          <a href="/dashboard/payments" className="inline-flex rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-soft">Open payment page</a>
        </div>
      )
    },
    {
      id: "billing",
      title: t("dashboard.settings.billing"),
      description: t("dashboard.settings.billingDesc"),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
          <line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      ),
      content: (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">{t("dashboard.settings.freePlan")}</p>
              <p className="text-xs text-slate-400">{t("dashboard.settings.upgradeHint")}</p>
            </div>
            <button className="rounded-lg bg-brand-accent px-4 py-2 text-xs font-bold text-brand transition hover:opacity-90">
              {t("dashboard.settings.upgrade")}
            </button>
          </div>
          <p className="text-xs text-slate-400">{t("dashboard.settings.billingSoon")}</p>
        </div>
      )
    },
    {
      id: "risk-engine",
      title: t("dashboard.settings.riskEngine"),
      description: t("dashboard.settings.riskEngineDesc"),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      content: (
        <div className="space-y-4 text-sm">
          <SettingRow label={t("dashboard.settings.codMultiplier")} value="1.5×" badge />
          <SettingRow label={t("dashboard.settings.networkWeight")} value="High" badge />
          <SettingRow label={t("dashboard.settings.newCustomerPenalty")} value={t("dashboard.settings.enabled")} badge />
          <p className="text-xs text-slate-400">{t("dashboard.settings.advancedSoon")}</p>
        </div>
      )
    },
    {
      id: "privacy",
      title: t("dashboard.settings.privacy"),
      description: t("dashboard.settings.privacyDesc"),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
      content: (
        <div className="space-y-3 text-sm text-slate-600">
          <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 shrink-0 text-emerald-600">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="text-emerald-800 text-xs">{t("dashboard.settings.privacySafe")}</span>
          </div>
          <SettingRow label={t("dashboard.settings.retention")} value="90 days" />
          <SettingRow label={t("dashboard.settings.contribution")} value={t("dashboard.settings.anonymous")} />
        </div>
      )
    },
    {
      id: "notifications",
      title: t("dashboard.settings.notifications"),
      description: t("dashboard.settings.notificationsDesc"),
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
      content: (
        <NotificationSettingsCard initialSettings={notificationSettings} />
      )
    }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{t("dashboard.settings.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("dashboard.settings.subtitle")}</p>
      </div>

      {saved ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{t("dashboard.settings.categorySaved")}</div> : null}
      {categoryError ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{categoryError}</div> : null}

      <MerchantCategoryPicker
        currentCategory={selectedCategory}
        action="/dashboard/settings/category/save"
        returnTo="/dashboard/settings?merchant_category_saved=1"
        title={t("dashboard.settings.marketingTitle")}
        description={t("dashboard.settings.marketingDesc")}
        buttonLabel={t("dashboard.settings.saveCategory")}
        helperText={merchant?.category_updated_at ? t("dashboard.settings.lastUpdated", { date: formatDateTime(merchant.category_updated_at) }) : t("dashboard.settings.requiredOnboarding")}
      />

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="flex items-start gap-4 border-b border-slate-100 bg-slate-50/60 px-6 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                {section.icon}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{section.title}</p>
                <p className="text-xs text-slate-400">{section.description}</p>
              </div>
            </div>
            <div className="px-6 py-5">{section.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingRow({ label, value, badge }: { label: string; value: string; badge?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <span className="text-slate-500">{label}</span>
      {badge ? (
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{value}</span>
      ) : (
        <span className="font-medium text-slate-800">{value}</span>
      )}
    </div>
  );
}

function ShippingField({ label, name, defaultValue, type = "text", step, required, helper, className = "" }: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  step?: string;
  required?: boolean;
  helper?: string;
  className?: string;
}) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="text-sm font-medium text-slate-700">{label}{required ? <span className="ml-1 text-rose-500">*</span> : null}</span>
      <input
        type={type}
        step={step}
        name={name}
        defaultValue={defaultValue}
        required={required}
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
      />
      {helper ? <p className="text-xs text-slate-400">{helper}</p> : null}
    </label>
  );
}

function ShippingCheckbox({ label, name, checked }: { label: string; name: string; checked: boolean }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input type="checkbox" name={name} defaultChecked={checked} className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand" />
    </label>
  );
}

function ShippingInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  );
}
