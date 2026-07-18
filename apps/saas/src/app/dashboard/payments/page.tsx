import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getEffectiveSubscriptionStatus, getScreenshotSignedUrl } from "@/lib/payments/subscription";
import { getMerchantPaymentRequest, getMerchantSubscription, getPaymentSettings, listMerchantPaymentRequests } from "@/lib/payments/settings";
import { getI18nServer } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type SearchParams = {
  plan?: string;
  payment_submitted?: string;
  payment_error?: string;
  screenshot_error?: string;
};

export default async function PaymentsPage({ searchParams }: { searchParams?: SearchParams }) {
  const { t, dir } = await getI18nServer();
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const supabase = createClient();
  const [{ data: merchant }, paymentSettings, paymentRequest, subscription, effectiveStatus, allRequests] = await Promise.all([
    supabase
      .from("merchants")
      .select("id, name, domain, subscription_status, free_trial, trial_started_at, trial_expires_at")
      .eq("id", merchantId)
      .maybeSingle(),
    getPaymentSettings(),
    getMerchantPaymentRequest(merchantId),
    getMerchantSubscription(merchantId),
    getEffectiveSubscriptionStatus(merchantId),
    listMerchantPaymentRequests(merchantId, 20),
  ]);

  const plan = searchParams?.plan === "yearly" ? "yearly" : "monthly";
  const monthlyPriceDzd = paymentSettings.monthlyPriceDzd;
  const monthlyPriceUsd = paymentSettings.monthlyPriceUsd;
  const yearlyPriceDzd = monthlyPriceDzd * 12;
  const yearlyPriceUsd = monthlyPriceUsd * 12;
  const merchantName = merchant?.name ?? "Your store";
  const merchantDomain = merchant?.domain ?? "—";
  const isFreeTrial = Boolean(merchant?.free_trial);
  const trialEndsAt = merchant?.trial_expires_at ? new Date(merchant.trial_expires_at) : null;
  const trialDaysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;
  const activeRequest = paymentRequest;
  const activeRequestScreenshot = activeRequest?.screenshotUrl
    ? await getScreenshotSignedUrl(activeRequest.screenshotUrl)
    : null;

  const trialTotalDays = paymentSettings.earlyAdopterTrialDurationDays;
  const trialProgressPct =
    isFreeTrial && trialDaysLeft !== null
      ? Math.max(0, Math.min(100, ((trialTotalDays - trialDaysLeft) / Math.max(trialTotalDays, 1)) * 100))
      : null;

  const subscriptionExpiresAt = subscription?.expiresAt ? new Date(subscription.expiresAt) : null;
  const subscriptionDaysLeft = subscriptionExpiresAt
    ? Math.max(0, Math.ceil((subscriptionExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  const showActivationCode = subscription?.activationCode && subscription.status === "pending";

  const featureRows: [string, string, string][] = [
    [t("dashboard.payments.features.riskChecks"), t("dashboard.payments.features.included"), t("dashboard.payments.features.included")],
    [t("dashboard.payments.features.networkIntelligence"), t("dashboard.payments.features.included"), t("dashboard.payments.features.included")],
    [t("dashboard.payments.features.shipmentAutomation"), t("dashboard.payments.features.included"), t("dashboard.payments.features.included")],
    [t("dashboard.payments.features.wooCommerceSync"), t("dashboard.payments.features.included"), t("dashboard.payments.features.included")],
    [t("dashboard.payments.features.supportResponse"), t("dashboard.payments.features.standard"), t("dashboard.payments.features.priority")],
    [t("dashboard.payments.features.billingCycle"), t("dashboard.payments.features.cycleMonthly"), t("dashboard.payments.features.cycleYearly")],
  ];

  const monthlyFeatures = [
    t("dashboard.payments.plans.monthly.f0"),
    t("dashboard.payments.plans.monthly.f1"),
    t("dashboard.payments.plans.monthly.f2"),
  ];

  const yearlyFeatures = [
    t("dashboard.payments.plans.yearly.f0"),
    t("dashboard.payments.plans.yearly.f1"),
    t("dashboard.payments.plans.yearly.f2"),
  ];

  const providerLinks = buildProviderLinks(paymentSettings.whatsappNumber);

  return (
    <main dir={dir} className="min-h-screen bg-[#F4F6F5] text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">

        {/* ── Page header ─────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-amber-800">
            {t("dashboard.payments.portalBadge")}
          </span>
          <h1 className="mt-3 text-2xl font-bold text-slate-900 sm:text-3xl">
            {t("dashboard.payments.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            {t("dashboard.payments.subtitle")}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/dashboard"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              {t("dashboard.payments.backToDashboard")}
            </Link>
            <a
              href="#checkout"
              className="rounded-xl bg-[#D6A74C] px-4 py-2 text-sm font-semibold text-[#0B3D2E] transition hover:brightness-110"
            >
              {t("dashboard.payments.goToCheckout")}
            </a>
          </div>
        </div>

        {/* ── Status summary tiles ─────────────────────────────────────────────── */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatusTile
            label={t("dashboard.payments.currentStatus")}
            value={localizeStatus(effectiveStatus, t)}
            accent={effectiveStatus === "active" ? "emerald" : effectiveStatus === "expired" ? "rose" : "amber"}
          />
          <StatusTile
            label={t("dashboard.payments.trialStatus")}
            value={isFreeTrial ? t("dashboard.payments.trialActive") : t("dashboard.payments.trialOff")}
            accent={isFreeTrial ? "emerald" : "neutral"}
          />
          <StatusTile
            label={t("dashboard.payments.merchantLabel")}
            value={merchantName}
            accent="neutral"
            helper={merchantDomain}
          />
          <StatusTile
            label={t("dashboard.payments.latestRequest")}
            value={activeRequest ? localizeRequestStatus(activeRequest.status, t) : "—"}
            accent={
              activeRequest?.status === "approved"
                ? "emerald"
                : activeRequest?.status === "rejected"
                ? "rose"
                : "amber"
            }
            helper={activeRequest?.paymentMethod ?? undefined}
          />
        </div>

        {/* ── Alerts ──────────────────────────────────────────────────────────── */}
        {searchParams?.payment_submitted === "1" ? (
          <div className="mb-4">
            <Alert
              tone="emerald"
              title={t("dashboard.payments.alerts.paymentSubmitted")}
              text={t("dashboard.payments.alerts.paymentSubmittedDesc")}
            />
          </div>
        ) : null}
        {searchParams?.payment_error ? (
          <div className="mb-4">
            <Alert
              tone="rose"
              title={t("dashboard.payments.alerts.submissionFailed")}
              text={decodeURIComponent(searchParams.payment_error)}
            />
          </div>
        ) : null}
        {searchParams?.screenshot_error ? (
          <div className="mb-4">
            <Alert
              tone="amber"
              title={t("dashboard.payments.alerts.uploadIssue")}
              text={screenshotErrorText(searchParams.screenshot_error, t)}
            />
          </div>
        ) : null}

        {/* ── Activation code banner ───────────────────────────────────────────── */}
        {showActivationCode ? (
          <section
            className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"
            aria-label={t("subscription.activationCodeTitle")}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">
                  {t("subscription.requestApproved")}
                </p>
                <h2 className="mt-2 text-xl font-bold text-slate-900">
                  {t("subscription.activationCodeTitle")}
                </h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-amber-800">
                  {t("subscription.activationCodeDesc")}
                </p>
              </div>
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-300">
                {t("subscription.approvedNotActivated")}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <code className="inline-block rounded-xl border border-amber-200 bg-white px-5 py-2.5 font-mono text-xl font-bold tracking-widest text-slate-900 shadow-sm">
                {subscription!.activationCode}
              </code>
              <p className="text-xs text-amber-700">{t("subscription.activationCodeLabel")}</p>
            </div>
          </section>
        ) : null}

        {/* ── Main content ─────────────────────────────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">

          {/* Left: plan cards + feature table */}
          <div className="space-y-6">

            {/* Plan toggle */}
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {t("dashboard.payments.plans.sectionTitle")}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {t("dashboard.payments.plans.sectionSubtitle")}
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  href="?plan=monthly"
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    plan === "monthly"
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("dashboard.payments.plans.monthly.name")}
                </Link>
                <Link
                  href="?plan=yearly"
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    plan === "yearly"
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("dashboard.payments.plans.yearly.name")}
                </Link>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <PlanCard
                title={t("dashboard.payments.plans.monthly.name")}
                priceDzd={monthlyPriceDzd}
                priceUsd={monthlyPriceUsd}
                note={t("dashboard.payments.plans.monthly.note")}
                highlight={plan === "monthly"}
                ctaLabel={t("dashboard.payments.plans.monthly.cta")}
                ctaHref="#checkout"
                features={monthlyFeatures}
                usdLabel={t("dashboard.payments.usdEquiv", { amount: formatAmount(monthlyPriceUsd) })}
              />
              <PlanCard
                title={t("dashboard.payments.plans.yearly.name")}
                priceDzd={yearlyPriceDzd}
                priceUsd={yearlyPriceUsd}
                note={t("dashboard.payments.plans.yearly.note")}
                badge={t("dashboard.payments.plans.yearly.badge")}
                highlight={plan === "yearly"}
                ctaLabel={t("dashboard.payments.plans.yearly.cta")}
                ctaHref="#checkout"
                features={yearlyFeatures}
                usdLabel={t("dashboard.payments.usdEquiv", { amount: formatAmount(yearlyPriceUsd) })}
              />
            </div>

            {/* Feature comparison */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-slate-900">
                  {t("dashboard.payments.features.sectionTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t("dashboard.payments.features.sectionSubtitle")}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="pb-2 pe-4 text-start text-xs font-semibold uppercase tracking-wider text-slate-400">
                        {t("dashboard.payments.features.colFeature")}
                      </th>
                      <th className="pb-2 pe-4 text-start text-xs font-semibold uppercase tracking-wider text-slate-400">
                        {t("dashboard.payments.features.colMonthly")}
                      </th>
                      <th className="pb-2 text-start text-xs font-semibold uppercase tracking-wider text-slate-400">
                        {t("dashboard.payments.features.colYearly")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {featureRows.map(([feature, monthly, yearly]) => (
                      <tr key={feature}>
                        <td className="py-2.5 pe-4 font-medium text-slate-800">{feature}</td>
                        <td className="py-2.5 pe-4 text-slate-600">{monthly}</td>
                        <td className="py-2.5 text-slate-600">{yearly}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* Right: status + providers */}
          <div className="space-y-4">

            {/* Subscription status card */}
            <section
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              aria-label={t("dashboard.payments.statusCard.title")}
            >
              <p className="text-xs font-semibold uppercase tracking-widest text-[#0B3D2E]">
                {t("dashboard.payments.statusCard.title")}
              </p>
              <p className="mt-2 text-lg font-bold text-slate-900">
                {localizeStatus(effectiveStatus, t)}
              </p>

              {/* Trial progress bar */}
              {isFreeTrial && trialProgressPct !== null ? (
                <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-emerald-800">
                      {t("subscription.freeTrial")}
                    </p>
                    <span className="text-xs text-emerald-700">
                      {t("dashboard.payments.daysRemaining", { days: trialDaysLeft ?? 0 })}
                    </span>
                  </div>
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-emerald-200"
                    role="progressbar"
                    aria-valuenow={Math.round(trialProgressPct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${trialProgressPct}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <dl className="mt-4 space-y-2.5 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-slate-500">{t("dashboard.payments.statusCard.store")}</dt>
                  <dd className="font-medium text-slate-900">{merchantName}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-slate-500">{t("dashboard.payments.statusCard.domain")}</dt>
                  <dd className="font-mono text-xs text-slate-700">{merchantDomain}</dd>
                </div>
                {trialEndsAt && !subscriptionExpiresAt ? (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="shrink-0 text-slate-500">{t("dashboard.payments.statusCard.trialExpires")}</dt>
                    <dd className="font-medium text-slate-900">{trialEndsAt.toLocaleDateString()}</dd>
                  </div>
                ) : null}
                {subscriptionExpiresAt ? (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="shrink-0 text-slate-500">
                      {t("dashboard.payments.statusCard.subscriptionExpires")}
                    </dt>
                    <dd className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-slate-900">
                        {subscriptionExpiresAt.toLocaleDateString()}
                      </span>
                      {subscriptionDaysLeft !== null ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            subscriptionDaysLeft <= 7
                              ? "bg-rose-100 text-rose-700"
                              : subscriptionDaysLeft <= 30
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-100 text-emerald-700"
                          }`}
                        >
                          {t("dashboard.payments.daysRemaining", { days: subscriptionDaysLeft })}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ) : null}
                {subscription?.activatedAt ? (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="shrink-0 text-slate-500">
                      {t("dashboard.payments.statusCard.activatedAt")}
                    </dt>
                    <dd className="font-medium text-slate-900">
                      {new Date(subscription.activatedAt).toLocaleDateString()}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {activeRequest && !showActivationCode ? (
                <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-slate-500">
                        {t("dashboard.payments.statusCard.latestReceipt")}
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-900">
                        {activeRequest.paymentMethod}
                      </p>
                    </div>
                    <span className={statusPillClass(activeRequest.status)}>
                      {localizeRequestStatus(activeRequest.status, t)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">
                    {new Date(activeRequest.createdAt).toLocaleString()}
                  </p>
                  {activeRequest.adminNotes ? (
                    <p className="mt-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {activeRequest.adminNotes}
                    </p>
                  ) : null}
                  {activeRequestScreenshot ? (
                    <a
                      href={activeRequestScreenshot}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex text-xs font-semibold text-[#D6A74C] underline-offset-4 hover:underline"
                    >
                      {t("dashboard.payments.statusCard.viewReceipt")}
                    </a>
                  ) : null}
                </div>
              ) : null}

              <NextStepsGuide
                status={effectiveStatus}
                hasPendingRequest={activeRequest?.status === "pending"}
                t={t}
              />
            </section>

            {/* Payment providers */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#D6A74C]">
                {t("dashboard.payments.providers.title")}
              </p>
              <p className="mt-1 text-sm text-slate-500">{t("dashboard.payments.providers.subtitle")}</p>
              <div className="mt-4 space-y-2">
                <ProviderCard
                  title="BaridiMob"
                  description={paymentSettings.baridimobAccount}
                  href={providerLinks.baridimob}
                  tone="emerald"
                  openLabel={t("dashboard.payments.providers.open")}
                />
                <ProviderCard
                  title="RedotPay"
                  description={paymentSettings.redotpayUid}
                  href={providerLinks.redotpay}
                  tone="amber"
                  openLabel={t("dashboard.payments.providers.open")}
                />
                <ProviderCard
                  title="WhatsApp"
                  description={paymentSettings.whatsappNumber}
                  href={providerLinks.whatsapp}
                  tone="slate"
                  openLabel={t("dashboard.payments.providers.open")}
                />
              </div>
            </section>
          </div>
        </div>

        {/* ── Checkout ─────────────────────────────────────────────────────────── */}
        <section
          id="checkout"
          className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:p-8"
        >
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#D6A74C]">
                {t("dashboard.payments.checkout.title")}
              </p>
              <h2 className="text-xl font-bold text-slate-900">
                {t("dashboard.payments.checkout.subtitle")}
              </h2>
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-800">
                  {t("dashboard.payments.checkout.selectedPlan")}
                </p>
                <p className="mt-1 text-slate-600">
                  {plan === "yearly"
                    ? t("dashboard.payments.checkout.planYearly", {
                        dzd: formatAmount(yearlyPriceDzd),
                        usd: formatAmount(yearlyPriceUsd),
                      })
                    : t("dashboard.payments.checkout.planMonthly", {
                        dzd: formatAmount(monthlyPriceDzd),
                        usd: formatAmount(monthlyPriceUsd),
                      })}
                </p>
              </div>
            </div>

            <form
              action="/api/v1/merchant/payment-requests"
              method="post"
              encType="multipart/form-data"
              className="space-y-4 rounded-2xl border border-slate-100 bg-slate-50 p-5"
            >
              <input type="hidden" name="selected_plan" value={plan} />

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  {t("dashboard.payments.checkout.chooseProvider")}
                </legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  <RadioCard
                    name="payment_method"
                    value={`BaridiMob - ${plan}`}
                    label="BaridiMob"
                    helper={paymentSettings.baridimobAccount}
                    defaultChecked
                  />
                  <RadioCard
                    name="payment_method"
                    value={`RedotPay - ${plan}`}
                    label="RedotPay"
                    helper={paymentSettings.redotpayUid}
                  />
                  <RadioCard
                    name="payment_method"
                    value={`WhatsApp - ${plan}`}
                    label="WhatsApp"
                    helper={paymentSettings.whatsappNumber}
                  />
                </div>
              </fieldset>

              <label className="block space-y-1.5">
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  {t("dashboard.payments.checkout.receipt")}
                </span>
                <input
                  type="file"
                  name="screenshot"
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  aria-label={t("dashboard.payments.checkout.receipt")}
                  className="block w-full rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 file:me-4 file:rounded-lg file:border-0 file:bg-[#0B3D2E] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:border-slate-400"
                />
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  className="rounded-xl bg-[#D6A74C] px-5 py-2.5 text-sm font-semibold text-[#0B3D2E] transition hover:brightness-110"
                >
                  {t("dashboard.payments.checkout.submit")}
                </button>
                <p className="text-xs text-slate-400">
                  {t("dashboard.payments.checkout.acceptedFiles")}
                </p>
              </div>
            </form>
          </div>
        </section>

        {/* ── Billing history ───────────────────────────────────────────────────── */}
        {allRequests.length > 0 ? (
          <section
            className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:p-8"
            aria-label={t("dashboard.payments.history.title")}
          >
            <div className="mb-5">
              <h2 className="text-base font-semibold text-slate-900">
                {t("dashboard.payments.history.title")}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {t("dashboard.payments.history.subtitle")}
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-3 text-start">
                      {t("dashboard.payments.history.date")}
                    </th>
                    <th scope="col" className="px-4 py-3 text-start">
                      {t("dashboard.payments.history.method")}
                    </th>
                    <th scope="col" className="px-4 py-3 text-start">
                      {t("dashboard.payments.history.status")}
                    </th>
                    <th scope="col" className="px-4 py-3 text-start">
                      {t("dashboard.payments.history.adminNotes")}
                    </th>
                    <th scope="col" className="px-4 py-3 text-start">
                      {t("dashboard.payments.history.reviewed")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {allRequests.map((request) => (
                    <tr key={request.id} className="transition hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {new Date(request.createdAt).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {request.paymentMethod}
                      </td>
                      <td className="px-4 py-3">
                        <span className={statusPillClass(request.status)}>
                          {localizeRequestStatus(request.status, t)}
                        </span>
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-3 text-slate-600">
                        {request.adminNotes ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                        {request.reviewedAt ? (
                          new Date(request.reviewedAt).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })
                        ) : (
                          <span className="text-slate-400">
                            {t("dashboard.payments.history.pendingReview")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAmount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function localizeStatus(status: string, t: (k: string) => string): string {
  const map: Record<string, string> = {
    active: "subscription.active",
    expired: "subscription.expired",
    rejected: "subscription.rejected",
    suspended: "subscription.suspended",
  };
  const key = map[status];
  return key ? t(key) : t("subscription.pendingPayment");
}

function localizeRequestStatus(status: string, t: (k: string) => string): string {
  if (status === "approved") return t("subscription.requestApproved");
  if (status === "rejected") return t("subscription.requestRejected");
  return t("subscription.requestPending");
}

function screenshotErrorText(error: string, t: (k: string) => string): string {
  if (error === "missing_file") return t("dashboard.payments.alerts.missingFile");
  if (error === "file_too_large") return t("dashboard.payments.alerts.fileTooLarge");
  if (error === "invalid_file_type") return t("dashboard.payments.alerts.invalidFileType");
  return decodeURIComponent(error);
}

function statusPillClass(status: string): string {
  const base = "rounded-full px-2.5 py-0.5 text-xs font-semibold";
  if (status === "approved") return `${base} bg-emerald-100 text-emerald-800`;
  if (status === "rejected") return `${base} bg-rose-100 text-rose-800`;
  return `${base} bg-amber-100 text-amber-800`;
}

function buildProviderLinks(whatsappNumber: string) {
  const digits = whatsappNumber.replace(/[^0-9]/g, "");
  return {
    whatsapp: digits ? `https://wa.me/${digits}` : "#",
    redotpay: "#checkout",
    baridimob: "#checkout",
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusTile({
  label,
  value,
  accent,
  helper,
}: {
  label: string;
  value: string;
  accent: "emerald" | "amber" | "rose" | "neutral";
  helper?: string;
}) {
  const cls = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
    neutral: "border-slate-200 bg-white text-slate-900",
  }[accent];
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${cls}`}>
      <p className="text-xs font-semibold uppercase tracking-wider opacity-60">{label}</p>
      <p className="mt-2 text-base font-bold">{value}</p>
      {helper ? <p className="mt-0.5 truncate text-xs opacity-60">{helper}</p> : null}
    </div>
  );
}

function Alert({
  tone,
  title,
  text,
}: {
  tone: "emerald" | "rose" | "amber";
  title: string;
  text: string;
}) {
  const cls = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    amber: "border-amber-200 bg-amber-50 text-amber-950",
  }[tone];
  return (
    <div role="alert" className={`rounded-2xl border px-5 py-4 ${cls}`}>
      <p className="text-sm font-bold">{title}</p>
      <p className="mt-1 text-sm leading-6 opacity-90">{text}</p>
    </div>
  );
}

function NextStepsGuide({
  status,
  hasPendingRequest,
  t,
}: {
  status: string;
  hasPendingRequest: boolean;
  t: (k: string) => string;
}) {
  if (status === "active") {
    return (
      <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-900">
        <p className="font-semibold">{t("dashboard.payments.nextSteps.activeTitle")}</p>
        <p className="mt-1 leading-6 opacity-90">{t("dashboard.payments.nextSteps.activeDesc")}</p>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-900">
        <p className="font-semibold">{t("dashboard.payments.nextSteps.expiredTitle")}</p>
        <p className="mt-1 leading-6 opacity-90">{t("dashboard.payments.nextSteps.expiredDesc")}</p>
        <a href="#checkout" className="mt-2 inline-flex font-semibold underline-offset-4 hover:underline">
          {t("dashboard.payments.nextSteps.expiredLink")} →
        </a>
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-900">
        <p className="font-semibold">{t("dashboard.payments.nextSteps.rejectedTitle")}</p>
        <p className="mt-1 leading-6 opacity-90">{t("dashboard.payments.nextSteps.rejectedDesc")}</p>
        <a href="#checkout" className="mt-2 inline-flex font-semibold underline-offset-4 hover:underline">
          {t("dashboard.payments.nextSteps.rejectedLink")} →
        </a>
      </div>
    );
  }
  if (hasPendingRequest) {
    return (
      <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">{t("dashboard.payments.nextSteps.pendingTitle")}</p>
        <p className="mt-1 leading-6 opacity-90">{t("dashboard.payments.nextSteps.pendingDesc")}</p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
      <p className="font-semibold">{t("dashboard.payments.nextSteps.noneTitle")}</p>
      <p className="mt-1 leading-6 opacity-80">{t("dashboard.payments.nextSteps.noneDesc")}</p>
      <a href="#checkout" className="mt-2 inline-flex font-semibold text-slate-900 underline-offset-4 hover:underline">
        {t("dashboard.payments.nextSteps.noneLink")} →
      </a>
    </div>
  );
}

function PlanCard({
  title,
  priceDzd,
  priceUsd,
  note,
  features,
  ctaLabel,
  ctaHref,
  badge,
  highlight,
  usdLabel,
}: {
  title: string;
  priceDzd: number;
  priceUsd: number;
  note: string;
  features: string[];
  ctaLabel: string;
  ctaHref: string;
  badge?: string;
  highlight?: boolean;
  usdLabel: string;
}) {
  return (
    <article
      className={`rounded-2xl border p-5 ${
        highlight
          ? "border-[#0B3D2E] bg-[#0B3D2E] text-white"
          : "border-slate-200 bg-white text-slate-900"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          {badge ? (
            <span
              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                highlight ? "bg-[#D6A74C] text-[#0B3D2E]" : "bg-amber-100 text-amber-800"
              }`}
            >
              {badge}
            </span>
          ) : null}
          <h3 className={`mt-2 text-lg font-bold ${badge ? "" : "mt-0"}`}>{title}</h3>
        </div>
      </div>
      <div className="mt-4 space-y-0.5">
        <p className="text-3xl font-black">DZD {formatAmount(priceDzd)}</p>
        <p className={`text-xs ${highlight ? "text-white/60" : "text-slate-500"}`}>{usdLabel}</p>
      </div>
      <p className={`mt-3 text-sm leading-6 ${highlight ? "text-white/80" : "text-slate-600"}`}>
        {note}
      </p>
      <ul className="mt-4 space-y-2 text-sm">
        {features.map((feature) => (
          <li key={feature} className={`flex gap-2.5 ${highlight ? "text-white/90" : "text-slate-700"}`}>
            <span
              className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                highlight ? "bg-[#D6A74C] text-[#0B3D2E]" : "bg-emerald-100 text-emerald-700"
              }`}
              aria-hidden="true"
            >
              ✓
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <a
        href={ctaHref}
        className={`mt-5 inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
          highlight
            ? "bg-[#D6A74C] text-[#0B3D2E] hover:brightness-110"
            : "bg-slate-900 text-white hover:bg-slate-800"
        }`}
      >
        {ctaLabel}
      </a>
    </article>
  );
}

function ProviderCard({
  title,
  description,
  href,
  tone,
  openLabel,
}: {
  title: string;
  description: string;
  href: string;
  tone: "emerald" | "amber" | "slate";
  openLabel: string;
}) {
  const dot = { emerald: "bg-emerald-400", amber: "bg-amber-400", slate: "bg-slate-400" }[tone];
  return (
    <a
      href={href}
      target={href.startsWith("http") ? "_blank" : undefined}
      rel={href.startsWith("http") ? "noreferrer" : undefined}
      className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm transition hover:border-slate-200 hover:bg-white"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">{title}</p>
          <p className="truncate text-xs text-slate-500">{description}</p>
        </div>
      </div>
      <span className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
        {openLabel}
      </span>
    </a>
  );
}

function RadioCard({
  name,
  value,
  label,
  helper,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  helper: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 text-sm transition hover:border-slate-300 has-[:checked]:border-[#0B3D2E] has-[:checked]:bg-[#0B3D2E]/5">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} className="sr-only" />
      <span className="block font-semibold text-slate-900">{label}</span>
      <span className="mt-0.5 block truncate text-xs text-slate-500">{helper}</span>
    </label>
  );
}
