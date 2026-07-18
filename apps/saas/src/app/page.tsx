import Link from "next/link";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const merchantId = await resolveDashboardMerchantId();
  const supabase = createClient();
  const { data: merchant } = merchantId
    ? await supabase
        .from("merchants")
        .select("subscription_status, free_trial, trial_expires_at")
        .eq("id", merchantId)
        .maybeSingle()
    : { data: null };

  const hasMerchant = Boolean(merchantId);
  const isTrialActive = hasMerchant && merchant?.subscription_status === "active" && Boolean(merchant?.free_trial);
  const trialDaysRemaining = isTrialActive && merchant?.trial_expires_at
    ? Math.max(0, Math.ceil((new Date(merchant.trial_expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;
  const isNeedsActivation = hasMerchant && merchant?.subscription_status !== "active" && !merchant?.free_trial;
  const primaryCtaHref = !hasMerchant ? "/auth/signup" : isNeedsActivation ? "/dashboard/payments" : "/dashboard";
  const primaryCtaLabel = !hasMerchant ? "Start Free Trial" : isTrialActive ? "Trial Active" : isNeedsActivation ? "Activate Store" : "Open Dashboard";

  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <div className="overflow-hidden rounded-3xl border border-brand/20 bg-white/70 shadow-card backdrop-blur">
        <div className="bg-[linear-gradient(135deg,rgba(11,61,46,0.08),rgba(214,167,76,0.12))] px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-brand">DZ Fraud Shield</p>
        </div>
        <div className="space-y-8 px-6 py-10 sm:px-10">
          <div className="max-w-3xl space-y-4 text-start" dir="ltr">
            <h1 className="text-4xl font-bold tracking-tight text-brand sm:text-5xl">DZ Fraud Shield</h1>
            <p className="text-lg leading-8 text-slate-700" dir="ltr" style={{ unicodeBidi: "isolate" }}>
              Production-focused fraud prevention SaaS and WooCommerce plugin for Algerian COD stores.
            </p>
            <p className="max-w-2xl text-sm leading-6 text-slate-600" dir="ltr">
              Free Trial, Activation, Subscription, and Payment Verification are handled in one merchant lifecycle so the plugin always matches the current store state.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-white transition hover:bg-brand-soft" href={primaryCtaHref}>
              {primaryCtaLabel}
            </Link>
            <Link className="rounded-lg border border-brand px-5 py-2.5 font-semibold text-brand transition hover:bg-brand/5" href="/dashboard">
              Open Dashboard
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <StateChip title="Free Trial" value={!hasMerchant ? "Available" : isTrialActive ? "Active" : "Unavailable"} />
            <StateChip title="Activation" value={isNeedsActivation ? "Required" : "Ready"} />
            <StateChip title="Subscription" value={isTrialActive ? `Trial Active${trialDaysRemaining !== null ? ` · ${trialDaysRemaining} days left` : ""}` : hasMerchant ? "Subscription Ready" : "Pending"} />
          </div>

          {merchant && merchant.subscription_status === "active" ? (
            <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-700 shadow-sm">
              <p className="font-semibold text-slate-900">Subscription details</p>
              <p className="mt-1">Status: Active</p>
              <p>Plan: Trial</p>
              <p>Trial: {merchant.free_trial ? "Active" : "Inactive"}</p>
              {merchant.trial_expires_at ? <p>Days remaining: {trialDaysRemaining ?? 0}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function StateChip({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">{title}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}
