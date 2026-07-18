import Link from "next/link";
import { AdminBadge, AdminPanel, AdminSectionHeader, FlowList } from "@/components/admin/admin-ui";
import { getPaymentSettings, listPaymentRequests, getMerchantSubscription } from "@/lib/payments/settings";
import { getScreenshotSignedUrl } from "@/lib/payments/subscription";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminPaymentSettingsPage({ searchParams }: { searchParams?: { settings_saved?: string; review_saved?: string; settings_error?: string; review_error?: string } }) {
  const settings = await getPaymentSettings();
  const requests = await listPaymentRequests(50);
  const supabase = createClient();
  const { data: merchantOptions } = await supabase
    .from("merchants")
    .select("id, name, subscription_status, free_trial, trial_expires_at")
    .order("created_at", { ascending: false })
    .limit(200);
  const merchantIds = Array.from(new Set(requests.map((request) => request.merchantId)));
  const merchantMap = new Map<string, { name: string | null; domain: string | null; subscription_status: string | null }>();

  if (merchantIds.length) {
    const { data } = await supabase.from("merchants").select("id, name, domain, subscription_status").in("id", merchantIds);
    for (const merchant of data ?? []) {
      merchantMap.set(merchant.id, {
        name: merchant.name ?? null,
        domain: merchant.domain ?? null,
        subscription_status: merchant.subscription_status ?? null,
      });
    }
  }

  // Build signed URL map; bucket is private.
  const signedUrlMap = new Map<string, string | null>();
  await Promise.all(
    requests.map(async (request) => {
      if (request.screenshotUrl) {
        const url = await getScreenshotSignedUrl(request.screenshotUrl);
        signedUrlMap.set(request.id, url);
      }
    })
  );

  // Subscription data map for merchants that already have subscriptions.
  const subscriptionMap = new Map<string, Awaited<ReturnType<typeof getMerchantSubscription>>>();
  await Promise.all(
    merchantIds.map(async (mid) => {
      const sub = await getMerchantSubscription(mid);
      subscriptionMap.set(mid, sub);
    })
  );

  const items = requests.map((request) => {
    const merchant = merchantMap.get(request.merchantId);
    const tone: "emerald" | "rose" | "amber" = request.status === "approved" ? "emerald" : request.status === "rejected" ? "rose" : "amber";
    return {
      title: merchant?.name ?? request.merchantId,
      subtitle: `${request.paymentMethod} - ${merchant?.domain ?? "no domain"}`,
      meta: request.status,
      tone,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="emerald">Payment settings</AdminBadge>
          <h1 className="text-3xl font-semibold text-white">Merchant subscription payments</h1>
          <p className="max-w-3xl text-sm text-slate-300">Update the live payment instructions and review submitted screenshots without changing the application code.</p>
        </div>
        <Link href={"/admin/settings" as any} className="rounded-full border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700/40">
          Back to settings
        </Link>
      </div>

      {searchParams?.settings_saved === "1" ? <Notice tone="emerald" text="Payment settings updated." /> : null}
      {searchParams?.review_saved === "1" ? <Notice tone="emerald" text="Payment review saved." /> : null}
      {searchParams?.settings_error ? <Notice tone="rose" text={decodeURIComponent(searchParams.settings_error)} /> : null}
      {searchParams?.review_error ? <Notice tone="rose" text={decodeURIComponent(searchParams.review_error)} /> : null}

      <AdminPanel className="bg-white/6 text-slate-50">
        <AdminSectionHeader eyebrow="Live values" title="Editable payment instructions" description="This data powers the merchant payment page and should be edited here rather than hardcoded in the app." />
        <form action="/api/v1/admin/payment-settings" method="post" className="mt-5 grid gap-4 md:grid-cols-2">
          <input type="hidden" name="early_adopter_trial_enabled" value="false" />
          <Field label="WhatsApp link" name="whatsapp_number" defaultValue={settings.whatsappNumber} />
          <Field label="RedotPay UID" name="redotpay_uid" defaultValue={settings.redotpayUid} />
          <Field label="BaridiMob account" name="baridimob_account" defaultValue={settings.baridimobAccount} />
          <Field label="Monthly price DZD" name="monthly_price_dzd" defaultValue={String(settings.monthlyPriceDzd)} inputMode="decimal" />
          <Field label="Monthly price USD" name="monthly_price_usd" defaultValue={String(settings.monthlyPriceUsd)} inputMode="decimal" />
          <label className="space-y-2 text-sm text-slate-200 md:col-span-2">
            <span className="block text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Early Adopter Program</span>
            <label className="inline-flex items-center gap-2 rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2">
              <input
                type="checkbox"
                name="early_adopter_trial_enabled"
                value="true"
                defaultChecked={settings.earlyAdopterTrialEnabled}
                className="h-4 w-4 rounded border-white/20 bg-[#07111B]"
              />
              <span>Enable free trial program</span>
            </label>
          </label>
          <Field
            label="Trial slots limit"
            name="early_adopter_trial_limit"
            defaultValue={String(settings.earlyAdopterTrialLimit)}
            inputMode="numeric"
          />
          <Field
            label="Trial duration (days)"
            name="early_adopter_trial_duration_days"
            defaultValue={String(settings.earlyAdopterTrialDurationDays)}
            inputMode="numeric"
          />
          <div className="flex items-end justify-end md:col-span-2">
            <button className="rounded-full bg-[#D6A74C] px-5 py-2.5 text-sm font-semibold text-[#07111B] transition hover:opacity-90">Save payment settings</button>
          </div>
        </form>
      </AdminPanel>

      <AdminPanel className="bg-white/6 text-slate-50">
        <AdminSectionHeader
          eyebrow="Trials"
          title="Early Adopter Program"
          description="Control free-trial slots and manually grant or extend trials for specific merchants."
        />
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <article className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Used slots</p>
            <p className="mt-2 text-2xl font-semibold text-white">{settings.usedEarlyAdopterTrials}</p>
          </article>
          <article className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Available slots</p>
            <p className="mt-2 text-2xl font-semibold text-white">{settings.availableEarlyAdopterTrials}</p>
          </article>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <form action="/api/v1/admin/early-adopter" method="post">
            <input type="hidden" name="action" value="reset_slots" />
            <button className="rounded-full border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-500/20">
              Reset Slots
            </button>
          </form>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <form action="/api/v1/admin/early-adopter" method="post" className="space-y-3 rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
            <input type="hidden" name="action" value="grant_trial" />
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Grant Trial To Merchant</p>
            <select name="merchant_id" className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none">
              {(merchantOptions ?? []).map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {(merchant.name ?? merchant.id)} · {merchant.subscription_status ?? "unknown"}
                </option>
              ))}
            </select>
            <select name="duration_days" defaultValue="14" className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none">
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
            <button className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/20">Grant Trial</button>
          </form>

          <form action="/api/v1/admin/early-adopter" method="post" className="space-y-3 rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
            <input type="hidden" name="action" value="extend_trial" />
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Extend Existing Trial</p>
            <select name="merchant_id" className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none">
              {(merchantOptions ?? []).map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {(merchant.name ?? merchant.id)} · {merchant.free_trial ? "trial" : "no trial"}
                </option>
              ))}
            </select>
            <select name="additional_days" defaultValue="7" className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none">
              <option value="7">+7 days</option>
              <option value="14">+14 days</option>
              <option value="30">+30 days</option>
            </select>
            <button className="rounded-full border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/20">Extend Trial</button>
          </form>
        </div>
      </AdminPanel>

      <AdminPanel className="bg-white/6 text-slate-50">
        <AdminSectionHeader eyebrow="Queue" title="Screenshot reviews" description="Approve or reject merchant payment submissions. Select a duration when approving; an activation code will be generated for the merchant to enter in their plugin." />
        <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <FlowList items={items} emptyLabel="No payment requests yet." />
          </div>
          <div className="space-y-4">
            {requests.slice(0, 8).map((request) => {
              const merchant = merchantMap.get(request.merchantId);
              const signedUrl = signedUrlMap.get(request.id);
              const subscription = subscriptionMap.get(request.merchantId);
              const merchantStatus = merchant?.subscription_status;

              return (
                <div key={request.id} className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-white">{merchant?.name ?? request.merchantId}</p>
                      <p className="text-xs text-slate-400">{request.paymentMethod} - {request.status} - {merchantStatus ?? "unknown"}</p>
                    </div>
                    {signedUrl ? (
                      <a href={signedUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-[#D6A74C] underline-offset-4 hover:underline">
                        View screenshot
                      </a>
                    ) : (
                      <span className="text-xs text-slate-500">No screenshot</span>
                    )}
                  </div>

                  {/* Activation code display if subscription is pending */}
                  {subscription?.activationCode && subscription.status === "pending" ? (
                    <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs">
                      <span className="text-amber-300">Activation code: </span>
                      <span className="font-mono font-bold text-amber-100">{subscription.activationCode}</span>
                      {subscription.expiresAt ? null : <span className="ml-2 text-amber-400">(awaiting plugin redemption)</span>}
                    </div>
                  ) : null}

                  {/* Approve / reject form */}
                  {request.status === "pending" ? (
                    <form action={`/api/v1/admin/payment-requests/${request.id}/review`} method="post" className="mt-4 space-y-3">
                      <input type="hidden" name="merchant_id" value={request.merchantId} />
                      <input type="hidden" name="action" value="review" />
                      <textarea name="admin_notes" rows={2} placeholder="Notes for the merchant" className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500" defaultValue={request.adminNotes ?? ""} />
                      <label className="block text-xs text-slate-400">
                        Duration (months)
                        <select name="duration_months" defaultValue="1" className="ml-2 rounded-lg border border-slate-700/40 bg-[#07111B] px-2 py-1 text-sm text-slate-100 outline-none">
                          <option value="1">1 month</option>
                          <option value="3">3 months</option>
                          <option value="6">6 months</option>
                          <option value="12">12 months</option>
                        </select>
                      </label>
                      <div className="flex gap-2">
                        <button name="status" value="approved" className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90">Approve</button>
                        <button name="status" value="rejected" className="rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90">Reject</button>
                      </div>
                    </form>
                  ) : null}

                  {/* Manage subscription actions */}
                  {subscription ? (
                    <div className="mt-4 border-t border-slate-700/30 pt-3 space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Manage subscription</p>
                      <div className="flex flex-wrap gap-2">
                        <form action={`/api/v1/admin/payment-requests/${request.id}/review`} method="post" className="flex items-center gap-2">
                          <input type="hidden" name="merchant_id" value={request.merchantId} />
                          <input type="hidden" name="action" value="extend" />
                          <select name="extend_months" defaultValue="1" className="rounded-lg border border-slate-700/40 bg-[#07111B] px-2 py-1 text-xs text-slate-100 outline-none">
                            <option value="1">+1 mo</option>
                            <option value="3">+3 mo</option>
                            <option value="6">+6 mo</option>
                            <option value="12">+12 mo</option>
                          </select>
                          <button className="rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20">Extend</button>
                        </form>
                        {merchantStatus !== "suspended" ? (
                          <form action={`/api/v1/admin/payment-requests/${request.id}/review`} method="post">
                            <input type="hidden" name="merchant_id" value={request.merchantId} />
                            <input type="hidden" name="action" value="suspend" />
                            <button className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20">Suspend</button>
                          </form>
                        ) : (
                          <form action={`/api/v1/admin/payment-requests/${request.id}/review`} method="post">
                            <input type="hidden" name="merchant_id" value={request.merchantId} />
                            <input type="hidden" name="action" value="reactivate" />
                            <button className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20">Reactivate</button>
                          </form>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </AdminPanel>
    </div>
  );
}

function Field({ label, name, defaultValue, inputMode = "text" }: { label: string; name: string; defaultValue: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"] }) {
  return (
    <label className="space-y-2 text-sm text-slate-200">
      <span className="block text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">{label}</span>
      <input
        name={name}
        defaultValue={defaultValue}
        inputMode={inputMode}
        className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500"
      />
    </label>
  );
}

function Notice({ tone, text }: { tone: "emerald" | "rose"; text: string }) {
  const classes = tone === "emerald"
    ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
    : "border-rose-400/20 bg-rose-500/10 text-rose-100";

  return <div className={`rounded-2xl border px-4 py-3 text-sm ${classes}`}>{text}</div>;
}
