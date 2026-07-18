import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";
import { getAdminMerchantDetails } from "@/lib/admin/merchants";

export const dynamic = "force-dynamic";

function toneForStatus(status: string): "emerald" | "amber" | "rose" | "sky" | "neutral" {
  if (status === "active") return "emerald";
  if (status === "trial") return "sky";
  if (status === "pending_payment") return "amber";
  if (status === "suspended") return "amber";
  return "rose";
}

export default async function MerchantDetailsPage({
  params,
  searchParams,
}: {
  params: { merchantId: string };
  searchParams?: { updated?: string; error?: string };
}) {
  const details = await getAdminMerchantDetails(params.merchantId);
  if (!details) {
    notFound();
  }

  const { merchant, usage, recentActivity } = details;
  const successMessage = searchParams?.updated ? decodeURIComponent(searchParams.updated) : null;
  const errorMessage = searchParams?.error ? decodeURIComponent(searchParams.error) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="sky">Merchant Details</AdminBadge>
          <h1 className="text-3xl font-semibold tracking-tight text-white">{merchant.name}</h1>
          <p className="text-sm text-slate-300">Merchant ID: {merchant.id}</p>
        </div>
        <Link href="/admin/merchants" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700/40">
          Back to merchants
        </Link>
      </div>

      {successMessage ? <Notice tone="emerald" text={successMessage} /> : null}
      {errorMessage ? <Notice tone="rose" text={errorMessage} /> : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Account status" value={merchant.accountStatus} tone={toneForStatus(merchant.accountStatus) === "rose" ? "rose" : toneForStatus(merchant.accountStatus) === "sky" ? "sky" : toneForStatus(merchant.accountStatus) === "amber" ? "amber" : "emerald"} />
        <AdminMetricCard label="Subscription plan" value={merchant.subscriptionPlan} tone="sky" />
        <AdminMetricCard label="Order checks" value={usage.totalOrderChecks} tone="gold" />
        <AdminMetricCard label="Blocked checks" value={usage.blockedOrderChecks} tone="rose" />
        <AdminMetricCard label="Checks (30d)" value={usage.orderChecksLast30Days} tone="amber" />
        <AdminMetricCard label="Providers" value={merchant.providers.length} tone="emerald" />
        <AdminMetricCard label="API keys" value={`${merchant.activeApiKeysCount}/${merchant.apiKeysCount}`} tone="violet" />
        <AdminMetricCard label="Trial" value={merchant.trialStatus} tone="sky" />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Identity"
            title="Store and owner profile"
            description="Core profile fields and provider connectivity for this merchant account."
          />
          <div className="grid gap-3 md:grid-cols-2">
            <DataCard label="Store name" value={merchant.storeName} />
            <DataCard label="Owner email" value={merchant.ownerEmail ?? "-"} />
            <DataCard label="Phone" value={merchant.phone ?? "-"} />
            <DataCard label="Created" value={new Date(merchant.createdAt).toLocaleString()} />
            <DataCard label="Last sync" value={merchant.lastSyncAt ? new Date(merchant.lastSyncAt).toLocaleString() : "-"} />
            <DataCard label="Subscription status" value={merchant.subscriptionStatus} />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Connected providers</p>
            <div className="flex flex-wrap gap-2">
              {merchant.providers.length ? merchant.providers.map((provider) => <AdminBadge key={provider} tone="emerald">{provider}</AdminBadge>) : <span className="text-sm text-slate-400">No providers connected</span>}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Stores</p>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-800/60 text-left text-xs uppercase border-b border-slate-700/40 tracking-[0.16em] text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Domain</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {merchant.stores.map((store) => (
                    <tr key={store.id} className="border-t border-slate-700/30">
                      <td className="px-3 py-2 text-slate-100">{store.name}</td>
                      <td className="px-3 py-2 text-slate-300">{store.domain ?? "-"}</td>
                      <td className="px-3 py-2 text-slate-300">{store.phone ?? "-"}</td>
                      <td className="px-3 py-2">{store.isActive ? <AdminBadge tone="emerald">Active</AdminBadge> : <AdminBadge tone="amber">Inactive</AdminBadge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </AdminPanel>

        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Controls"
            title="Account and subscription actions"
            description="Delete, disable, and change-plan actions require super admin privileges."
          />

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Account controls</p>
            <div className="flex flex-wrap gap-2">
              <ActionForm merchantId={merchant.id} action="activate" label="Activate" buttonClass="border-emerald-400/30 bg-emerald-500/10 text-emerald-200" />
              <ActionForm merchantId={merchant.id} action="suspend" label="Suspend" buttonClass="border-amber-400/30 bg-amber-500/10 text-amber-200" />
              <ActionForm merchantId={merchant.id} action="disable" label="Disable (Super Admin)" buttonClass="border-rose-400/30 bg-rose-500/10 text-rose-200" />
              <ActionForm merchantId={merchant.id} action="delete" label="Delete Merchant (Super Admin)" buttonClass="border-rose-400/30 bg-rose-500/10 text-rose-200" />
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Subscription controls</p>
            <form action={`/api/v1/admin/merchants/${merchant.id}/actions`} method="post" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/40 p-3">
              <input type="hidden" name="action" value="change_plan" />
              <label className="text-xs text-slate-300">Plan</label>
              <select name="plan" defaultValue={merchant.subscriptionPlan} className="rounded-lg border border-slate-700/40 bg-[#07111B] px-2 py-1 text-sm text-slate-100 outline-none">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
              <button className="rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200">Change Plan (Super Admin)</button>
            </form>

            <form action={`/api/v1/admin/merchants/${merchant.id}/actions`} method="post" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/40 p-3">
              <input type="hidden" name="action" value="extend_subscription" />
              <label className="text-xs text-slate-300">Extend by months</label>
              <select name="extend_months" defaultValue="1" className="rounded-lg border border-slate-700/40 bg-[#07111B] px-2 py-1 text-sm text-slate-100 outline-none">
                <option value="1">1</option>
                <option value="3">3</option>
                <option value="6">6</option>
                <option value="12">12</option>
              </select>
              <button className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200">Extend Subscription</button>
            </form>

            <form action={`/api/v1/admin/merchants/${merchant.id}/actions`} method="post" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/40 p-3">
              <input type="hidden" name="action" value="extend_trial" />
              <label className="text-xs text-slate-300">Extend trial days</label>
              <select name="trial_days" defaultValue="7" className="rounded-lg border border-slate-700/40 bg-[#07111B] px-2 py-1 text-sm text-slate-100 outline-none">
                <option value="7">7</option>
                <option value="14">14</option>
                <option value="30">30</option>
              </select>
              <button className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-200">Extend Trial</button>
            </form>

            <ActionForm merchantId={merchant.id} action="cancel_subscription" label="Cancel Subscription" buttonClass="border-rose-400/30 bg-rose-500/10 text-rose-200" />
          </div>
        </AdminPanel>
      </section>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          eyebrow="Activity"
          title="Recent merchant events"
          description="Latest admin, plugin, and system events captured in audit logs for this merchant."
        />
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-800/60 text-left text-xs uppercase border-b border-slate-700/40 tracking-[0.16em] text-slate-400">
              <tr>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">At</th>
              </tr>
            </thead>
            <tbody>
              {recentActivity.map((entry) => (
                <tr key={entry.id} className="border-t border-slate-700/30">
                  <td className="px-3 py-2 text-slate-100">{entry.action}</td>
                  <td className="px-3 py-2 text-slate-300">{entry.actorType ?? "-"}</td>
                  <td className="px-3 py-2 text-slate-300">{new Date(entry.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminPanel>
    </div>
  );
}

function DataCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-3">
      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{label}</p>
      <p className="mt-1 text-sm text-slate-100">{value}</p>
    </article>
  );
}

function ActionForm({
  merchantId,
  action,
  label,
  buttonClass,
}: {
  merchantId: string;
  action: string;
  label: string;
  buttonClass: string;
}) {
  return (
    <form action={`/api/v1/admin/merchants/${merchantId}/actions`} method="post">
      <input type="hidden" name="action" value={action} />
      <button className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${buttonClass}`}>{label}</button>
    </form>
  );
}

function Notice({ tone, text }: { tone: "emerald" | "rose"; text: string }) {
  const classes = tone === "emerald"
    ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
    : "border-rose-400/20 bg-rose-500/10 text-rose-100";

  return <div className={`rounded-2xl border px-4 py-3 text-sm ${classes}`}>{text}</div>;
}
