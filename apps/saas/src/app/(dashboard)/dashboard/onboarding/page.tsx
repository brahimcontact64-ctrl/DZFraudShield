import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { MerchantCategoryPicker } from "@/components/merchant/merchant-category-picker";
import { normalizeMerchantCategory } from "@/lib/merchant/categories";
import { getI18nServer } from "@/lib/i18n/server";
import { formatDateTime } from "@/lib/format-date";

type StepState = {
  key: string;
  label: string;
  description: string;
  ready: boolean;
  href?: "/dashboard/delivery-providers" | "/dashboard/shipments" | "/dashboard/settings";
  details?: string;
};

export default async function DashboardOnboardingPage() {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();

  if (!merchantId) {
    redirect("/auth/login");
  }

  const supabase = createClient();

  const [
    merchantRow,
    providerAccounts,
    syncLogs,
    importedOrders,
  ] = await Promise.all([
    supabase.from("merchants").select("id, created_at, category, category_updated_at").eq("id", merchantId).maybeSingle(),
    supabase
      .from("merchant_delivery_accounts")
      .select("id, provider, connection_status, last_connection_test_at")
      .eq("merchant_id", merchantId),
    supabase
      .from("delivery_sync_logs")
      .select("id, status, created_at")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("delivery_orders")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId),
  ]);

  const accounts = providerAccounts.data ?? [];
  const connectedAccounts = accounts.filter((item) => item.connection_status === "connected");
  const validatedAccounts = connectedAccounts.filter((item) => Boolean(item.last_connection_test_at));
  const successfulSyncCount = (syncLogs.data ?? []).filter((item) => item.status === "success").length;
  const importedCount = importedOrders.count ?? 0;
  const merchantCategory = normalizeMerchantCategory(merchantRow.data?.category ?? null);

  const steps: StepState[] = [
    {
      key: "merchant_category",
      label: t("merchantCategory.label"),
      description: t("dashboard.onboarding.selectCategory"),
      ready: Boolean(merchantRow.data?.category_updated_at),
      details: merchantRow.data?.category_updated_at
        ? `Selected ${merchantCategory.replace(/_/g, " ")} on ${formatDateTime(merchantRow.data.category_updated_at)}`
        : `Current selection: ${merchantCategory.replace(/_/g, " ")}`,
      href: "/dashboard/settings",
    },
    {
      key: "account_creation",
      label: "Account creation",
      description: "Merchant account exists and can access the dashboard.",
      ready: Boolean(merchantRow.data?.id),
      details: merchantRow.data?.created_at ? `Created ${formatDateTime(merchantRow.data.created_at)}` : undefined,
    },
    {
      key: "provider_connection",
      label: "Delivery provider connection",
      description: "At least one provider account is connected.",
      ready: connectedAccounts.length > 0,
      href: "/dashboard/delivery-providers",
      details: `${connectedAccounts.length} connected account(s)`,
    },
    {
      key: "credential_validation",
      label: "API credential validation",
      description: "Provider credentials were tested successfully.",
      ready: validatedAccounts.length > 0,
      href: "/dashboard/delivery-providers",
      details: `${validatedAccounts.length} validated account(s)`,
    },
    {
      key: "initial_sync_test",
      label: "Initial sync test",
      description: "At least one delivery sync job succeeded.",
      ready: successfulSyncCount > 0,
      href: "/dashboard/delivery-providers",
      details: `${successfulSyncCount} successful sync run(s)`,
    },
    {
      key: "first_successful_import",
      label: "First successful import",
      description: "At least one delivery order exists after sync.",
      ready: importedCount > 0,
      href: "/dashboard/shipments",
      details: `${importedCount} imported delivery order(s)`,
    },
  ];

  const activationComplete = steps.every((step) => step.ready);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-slate-900">{t("dashboard.onboarding.title")}</h1>
        <p className="text-sm text-slate-600">{t("dashboard.onboarding.subtitle")}</p>
      </div>

      <MerchantCategoryPicker
        currentCategory={merchantCategory}
        action="/dashboard/settings/category/save"
        returnTo="/dashboard/onboarding"
        title={t("dashboard.onboarding.requiredSetup")}
        description={t("dashboard.onboarding.selectCategory")}
        buttonLabel={t("dashboard.onboarding.saveCategory")}
        helperText={merchantRow.data?.category_updated_at ? t("dashboard.onboarding.categorySaved") : t("dashboard.onboarding.categoryRequired")}
      />

      <div className={`rounded-2xl border p-6 ${activationComplete ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <p className={`text-2xl font-bold ${activationComplete ? "text-emerald-900" : "text-amber-900"}`}>{activationComplete ? t("dashboard.onboarding.complete") : t("dashboard.onboarding.progress")}</p>
        <p className={`text-sm ${activationComplete ? "text-emerald-700" : "text-amber-700"}`}>{t("dashboard.onboarding.stepsDone", { done: steps.filter((step) => step.ready).length, total: steps.length })}</p>
      </div>

      <div className="space-y-2">
        {steps.map((step, index) => (
          <div key={step.key} className={`rounded-xl border p-4 ${step.ready ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
            <div className="flex items-center gap-3">
              {step.ready ? <CheckIcon className="text-emerald-600" size={18} /> : <XIcon className="text-rose-600" size={18} />}
              <p className={`font-semibold ${step.ready ? "text-emerald-900" : "text-rose-900"}`}>{t("dashboard.onboarding.step", { number: index + 1 })}: {step.label}</p>
            </div>
            <p className={`mt-1 text-sm ${step.ready ? "text-emerald-700" : "text-rose-700"}`}>{step.description}</p>
            {step.details ? <p className={`mt-1 text-xs ${step.ready ? "text-emerald-700" : "text-rose-700"}`}>{step.details}</p> : null}
            {step.href ? (
              <Link href={step.href} className="mt-2 inline-flex rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50">
                {t("dashboard.onboarding.openWorkspace")}
              </Link>
            ) : null}
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        {t("dashboard.onboarding.authorityHint")}
      </div>
    </div>
  );
}
