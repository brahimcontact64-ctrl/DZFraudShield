import Link from "next/link";
import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";
import { listAdminMerchants } from "@/lib/admin/merchants";

export const dynamic = "force-dynamic";

function toneForStatus(status: string): "emerald" | "amber" | "rose" | "sky" | "neutral" {
  if (status === "active") return "emerald";
  if (status === "trial") return "sky";
  if (status === "pending_payment") return "amber";
  if (status === "suspended") return "amber";
  return "rose";
}

export default async function AdminMerchantsPage({
  searchParams,
}: {
  searchParams?: { q?: string; status?: string; provider?: string; plan?: string; updated?: string; error?: string };
}) {
  const { merchants, stats } = await listAdminMerchants({
    q: searchParams?.q,
    status: searchParams?.status,
    provider: searchParams?.provider,
    plan: searchParams?.plan,
  });

  const providers = Array.from(new Set(merchants.flatMap((merchant) => merchant.providers))).sort();

  const successMessage = searchParams?.updated ? decodeURIComponent(searchParams.updated) : null;
  const errorMessage = searchParams?.error ? decodeURIComponent(searchParams.error) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="sky">Merchant Management</AdminBadge>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Merchant control center</h1>
          <p className="max-w-4xl text-sm text-slate-300">
            Review subscription and trial state, account access, provider connectivity, and API key footprint in one operational grid.
          </p>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Total Merchants" value={stats.totalMerchants} tone="sky" />
        <AdminMetricCard label="Active Merchants" value={stats.activeMerchants} tone="emerald" />
        <AdminMetricCard label="Trial Merchants" value={stats.trialMerchants} tone="amber" />
        <AdminMetricCard label="Suspended + Disabled" value={stats.suspendedMerchants + stats.disabledMerchants} tone="rose" />
        <AdminMetricCard label="Expired" value={stats.expiredMerchants} tone="amber" />
        <AdminMetricCard label="Total API Keys" value={stats.totalApiKeys} tone="violet" />
        <AdminMetricCard label="Active Providers" value={stats.activeProviders} tone="emerald" />
        <AdminMetricCard label="New This Month" value={stats.newThisMonth} tone="gold" />
      </section>

      {successMessage ? <Notice tone="emerald" text={successMessage} /> : null}
      {errorMessage ? <Notice tone="rose" text={errorMessage} /> : null}

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          eyebrow="Search and filters"
          title="Portfolio filtering"
          description="Filter merchants by account state, provider, plan, and free-text search over IDs and owner fields."
        />
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" method="get" action="/admin/merchants">
          <label className="space-y-1 text-xs uppercase tracking-[0.2em] text-slate-400 xl:col-span-2">
            Search
            <input
              type="text"
              name="q"
              defaultValue={searchParams?.q ?? ""}
              placeholder="Store, merchant ID, email, provider"
              className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none"
            />
          </label>

          <label className="space-y-1 text-xs uppercase tracking-[0.2em] text-slate-400">
            Status
            <select name="status" defaultValue={searchParams?.status ?? "all"} className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none">
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="trial">Trial</option>
              <option value="pending_payment">Pending</option>
              <option value="suspended">Suspended</option>
              <option value="disabled">Disabled</option>
              <option value="expired">Expired</option>
            </select>
          </label>

          <label className="space-y-1 text-xs uppercase tracking-[0.2em] text-slate-400">
            Provider
            <select name="provider" defaultValue={searchParams?.provider ?? "all"} className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none">
              <option value="all">All</option>
              {providers.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-xs uppercase tracking-[0.2em] text-slate-400">
            Plan
            <select name="plan" defaultValue={searchParams?.plan ?? "all"} className="w-full rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm normal-case tracking-normal text-slate-100 outline-none">
              <option value="all">All</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>

          <div className="flex items-end gap-2 xl:col-span-5">
            <button className="rounded-xl border border-slate-700/40 bg-slate-700/30 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700/50">Apply filters</button>
            <Link href="/admin/merchants" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700/40">Reset</Link>
          </div>
        </form>
      </AdminPanel>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          eyebrow="Merchant inventory"
          title="SaaS merchant table"
          description="Store, owner, provider, subscription and account health with quick navigation into account-level controls."
        />

        <div className="overflow-x-auto rounded-xl border border-slate-700/40">
          <table className="min-w-[1380px] w-full text-sm">
            <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wider text-slate-500 border-b border-slate-700/40">
              <tr>
                <th className="px-3 py-3">Store Name</th>
                <th className="px-3 py-3">Merchant ID</th>
                <th className="px-3 py-3">Owner Email</th>
                <th className="px-3 py-3">Phone</th>
                <th className="px-3 py-3">Provider</th>
                <th className="px-3 py-3">Plan</th>
                <th className="px-3 py-3">Trial</th>
                <th className="px-3 py-3">Account Status</th>
                <th className="px-3 py-3">Created</th>
                <th className="px-3 py-3">Last Login</th>
                <th className="px-3 py-3">Last Sync</th>
                <th className="px-3 py-3">API Keys</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((merchant) => (
                <tr key={merchant.id} className="border-t border-slate-700/30">
                  <td className="px-3 py-3 font-medium text-white">{merchant.storeName}</td>
                  <td className="px-3 py-3 text-xs text-slate-300">{merchant.id}</td>
                  <td className="px-3 py-3 text-slate-200">{merchant.ownerEmail ?? "-"}</td>
                  <td className="px-3 py-3 text-slate-200">{merchant.phone ?? "-"}</td>
                  <td className="px-3 py-3 text-slate-200">{merchant.providers.length ? merchant.providers.join(", ") : "-"}</td>
                  <td className="px-3 py-3"><AdminBadge tone="sky">{merchant.subscriptionPlan}</AdminBadge></td>
                  <td className="px-3 py-3 text-slate-200">{merchant.trialStatus}</td>
                  <td className="px-3 py-3"><AdminBadge tone={toneForStatus(merchant.accountStatus)}>{merchant.accountStatus}</AdminBadge></td>
                  <td className="px-3 py-3 text-slate-200">{new Date(merchant.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-3 text-slate-200">{merchant.lastLoginAt ? new Date(merchant.lastLoginAt).toLocaleString() : "-"}</td>
                  <td className="px-3 py-3 text-slate-200">{merchant.lastSyncAt ? new Date(merchant.lastSyncAt).toLocaleString() : "-"}</td>
                  <td className="px-3 py-3 text-slate-200">{merchant.activeApiKeysCount}/{merchant.apiKeysCount}</td>
                  <td className="px-3 py-3">
                    <Link href={`/admin/merchants/${merchant.id}`} className="rounded-lg border border-slate-700/40 bg-slate-700/30 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-600/50">
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!merchants.length ? <p className="text-sm text-slate-300">No merchants match the current filters.</p> : null}
      </AdminPanel>
    </div>
  );
}

function Notice({ tone, text }: { tone: "emerald" | "rose"; text: string }) {
  const classes = tone === "emerald"
    ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
    : "border-rose-400/20 bg-rose-500/10 text-rose-100";

  return <div className={`rounded-2xl border px-4 py-3 text-sm ${classes}`}>{text}</div>;
}