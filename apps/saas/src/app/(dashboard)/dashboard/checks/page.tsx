import Link from "next/link";
import { redirect } from "next/navigation";
import { listDashboardChecks, resolveDashboardMerchantId, merchantRiskStatusFromCheck } from "@/lib/dashboard-data";
import { MerchantRiskBadge, type MerchantRiskStatus } from "@/components/ui/badge";
import { getI18nServer } from "@/lib/i18n/server";
import { redirectIfSubscriptionBlocked } from "@/lib/payments/subscription";
import { formatDateOnly } from "@/lib/format-date";

export default async function ChecksPage({ searchParams }: { searchParams: { level?: string } }) {
  const { t } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) redirect("/auth/login");
  await redirectIfSubscriptionBlocked(merchantId);

  const checks = await listDashboardChecks(merchantId, { level: searchParams.level, limit: 50 });

  const filterLinks = [
    { label: t("dashboard.checks.all"), level: undefined },
    { label: t("dashboard.checks.blacklisted"), level: "BLOCK" },
    { label: t("dashboard.checks.highRisk"), level: "HIGH" },
    { label: t("dashboard.checks.watchlist"), level: "MEDIUM" },
    { label: t("dashboard.checks.clean"), level: "LOW" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{t("dashboard.checks.title")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("dashboard.checks.recentChecks", { count: checks.length })}</p>
        </div>
        {/* Filter pills */}
        <div className="flex flex-wrap gap-1.5">
          {filterLinks.map(({ label, level }) => {
            const active = (searchParams.level ?? undefined) === level;
            return (
              <Link
                key={label}
                href={level ? `/dashboard/checks?level=${level}` : "/dashboard/checks"}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "bg-brand text-white"
                    : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Table */}
      {checks.length === 0 ? (
        <EmptyChecks t={t} />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3.5">{t("dashboard.checks.customer")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.wilaya")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.score")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.riskStatus")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.recommendation")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.amount")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.date")}</th>
                <th className="px-5 py-3.5">{t("dashboard.checks.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check: any) => {
                const { status } = merchantRiskStatusFromCheck(check);
                return <CheckRow key={check.id} check={check} status={status} t={t} />;
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CheckRow({ check, status, t }: { check: any; status: MerchantRiskStatus; t: (key: string) => string }) {
  const actionMap: Record<string, string> = {
    accept: t("dashboard.checks.ship"),
    verify: t("dashboard.checks.verify"),
    manual_review: t("dashboard.checks.review"),
    block: t("dashboard.checks.block"),
  };

  const actionColor: Record<string, string> = {
    accept: "text-emerald-600",
    verify: "text-amber-600",
    manual_review: "text-orange-600",
    block: "text-rose-600",
  };

  return (
    <tr className="border-b border-slate-100 last:border-0 transition-colors hover:bg-slate-50/70">
      <td className="px-5 py-4">
        <Link href={`/dashboard/checks/${check.id}`} className="font-medium text-slate-900 hover:text-brand hover:underline underline-offset-2">
          {check.customer_name ?? "-"}
        </Link>
        <p className="text-xs text-slate-400">{check.order_id ?? check.external_order_id ?? check.id.slice(0, 8)}</p>
      </td>
      <td className="px-5 py-4 text-slate-600">{check.wilaya ?? "-"}</td>
      <td className="px-5 py-4">
        <span className="font-semibold text-slate-800">{check.risk_score}</span>
        <span className="text-slate-400">/100</span>
      </td>
      <td className="px-5 py-4">
        <MerchantRiskBadge status={status} />
      </td>
      <td className={`px-5 py-4 font-medium ${actionColor[check.recommended_action] ?? "text-slate-600"}`}>
        {actionMap[check.recommended_action] ?? check.recommended_action ?? "-"}
      </td>
      <td className="px-5 py-4 text-slate-600">
        {Number(check.total_amount ?? check.cart_total ?? 0).toFixed(0)} DZD
      </td>
      <td className="px-5 py-4 text-slate-400">
        {formatDateOnly(check.created_at)}
      </td>
      <td className="px-5 py-4">
        <div className="flex items-center gap-1.5">
          <Link
            href={`/dashboard/checks/${check.id}`}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            {t("dashboard.checks.view")}
          </Link>
          <QuickDecision checkId={check.id} decision="ACCEPTED" label={t("dashboard.checks.ship")} className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" />
          <QuickDecision checkId={check.id} decision="BLOCKED" label={t("dashboard.checks.block")} className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100" />
        </div>
      </td>
    </tr>
  );
}

function QuickDecision({ checkId, decision, label, className }: { checkId: string; decision: string; label: string; className: string }) {
  return (
    <form method="post" action={`/dashboard/checks/${checkId}/decision`}>
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="decisionReason" value={`checks_quick_${decision.toLowerCase()}`} />
      <button type="submit" className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${className}`}>
        {label}
      </button>
    </form>
  );
}

function EmptyChecks({ t }: { t: (key: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-700">{t("dashboard.checks.emptyTitle")}</p>
      <p className="mt-1 text-xs text-slate-400">{t("dashboard.checks.emptyDesc")}</p>
    </div>
  );
}



