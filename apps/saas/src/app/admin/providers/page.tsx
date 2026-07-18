import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader, FlowList } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminProvidersPage() {
  const supabase = createClient();
  const [accountsResult, logsResult] = await Promise.all([
    supabase.from("merchant_delivery_accounts").select("id, merchant_id, provider, provider_name, account_label, active, connection_status, failure_streak, last_sync_at, last_error_message, created_at").order("created_at", { ascending: false }),
    supabase.from("delivery_sync_logs").select("account_id, provider, status, synced_orders, failed_orders, created_at, error_message, merchant_id").order("created_at", { ascending: false })
  ]);

  if (accountsResult.error) throw accountsResult.error;
  if (logsResult.error) throw logsResult.error;

  const accounts = accountsResult.data ?? [];
  const logs = logsResult.data ?? [];

  const byProvider = new Map<string, {
    provider: string;
    providerName: string;
    totalAccounts: number;
    activeAccounts: number;
    ordersSynced: number;
    errors: number;
    lastSyncAt: string | null;
    failureStreak: number;
  }>();

  for (const account of accounts) {
    const current = byProvider.get(account.provider) ?? {
      provider: account.provider,
      providerName: account.provider_name ?? account.provider,
      totalAccounts: 0,
      activeAccounts: 0,
      ordersSynced: 0,
      errors: 0,
      lastSyncAt: null,
      failureStreak: 0
    };

    current.totalAccounts += 1;
    if (account.active) {
      current.activeAccounts += 1;
    }
    current.failureStreak = Math.max(current.failureStreak, Number(account.failure_streak ?? 0));
    current.lastSyncAt = current.lastSyncAt && account.last_sync_at ? (current.lastSyncAt > account.last_sync_at ? current.lastSyncAt : account.last_sync_at) : (account.last_sync_at ?? current.lastSyncAt);
    byProvider.set(account.provider, current);
  }

  for (const log of logs) {
    const current = byProvider.get(log.provider) ?? {
      provider: log.provider,
      providerName: log.provider,
      totalAccounts: 0,
      activeAccounts: 0,
      ordersSynced: 0,
      errors: 0,
      lastSyncAt: null,
      failureStreak: 0
    };

    current.ordersSynced += Number(log.synced_orders ?? 0);
    if (log.status === "failed") {
      current.errors += 1;
    }
    current.lastSyncAt = current.lastSyncAt && log.created_at ? (current.lastSyncAt > log.created_at ? current.lastSyncAt : log.created_at) : (log.created_at ?? current.lastSyncAt);
    byProvider.set(log.provider, current);
  }

  const providers = Array.from(byProvider.values()).map((row) => ({
    ...row,
    healthScore: row.totalAccounts > 0 ? Math.max(0, Math.round(((row.activeAccounts / row.totalAccounts) * 100) - row.errors * 5 - row.failureStreak * 3)) : 0,
    status: row.activeAccounts > 0 ? "Connected" : "Dormant"
  }));

  const topProviders = providers.sort((left, right) => right.healthScore - left.healthScore);
  const totalActiveAccounts = providers.reduce((sum, row) => sum + row.activeAccounts, 0);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">Delivery Providers</AdminBadge>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Provider operations</h1>
        <p className="max-w-3xl text-sm text-slate-300">Monitor health, sync freshness, error pressure, and active account coverage across delivery providers.</p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Providers" value={topProviders.length} tone="sky" />
        <AdminMetricCard label="Active Accounts" value={totalActiveAccounts} tone="emerald" />
        <AdminMetricCard label="Orders Synced" value={providers.reduce((sum, row) => sum + row.ordersSynced, 0).toLocaleString()} tone="gold" />
        <AdminMetricCard label="Total Errors" value={providers.reduce((sum, row) => sum + row.errors, 0)} tone="rose" />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {topProviders.map((provider) => (
          <AdminPanel key={provider.provider} className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-700/40 text-lg font-semibold text-[#D6A74C]">
                  {(provider.providerName ?? provider.provider ?? "?").slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Provider</p>
                  <h2 className="mt-1 text-2xl font-semibold text-white">{provider.providerName}</h2>
                  <p className="mt-1 text-sm text-slate-400">{provider.provider}</p>
                </div>
              </div>
              <AdminBadge tone={provider.healthScore >= 80 ? "emerald" : provider.healthScore >= 50 ? "amber" : "rose"}>Health {provider.healthScore}</AdminBadge>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4"><p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Status</p><p className="mt-2 text-lg font-semibold text-white">{provider.status}</p></div>
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4"><p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Last Sync</p><p className="mt-2 text-lg font-semibold text-white">{provider.lastSyncAt ? new Date(provider.lastSyncAt).toLocaleString() : "-"}</p></div>
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4"><p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Orders Synced</p><p className="mt-2 text-lg font-semibold text-white">{provider.ordersSynced.toLocaleString()}</p></div>
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4"><p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Errors</p><p className="mt-2 text-lg font-semibold text-white">{provider.errors}</p></div>
            </div>

            <div className="flex flex-wrap gap-2">
              <AdminBadge tone="neutral">{provider.activeAccounts} active accounts</AdminBadge>
              <AdminBadge tone="sky">{provider.totalAccounts} total accounts</AdminBadge>
              <AdminBadge tone={provider.failureStreak > 0 ? "amber" : "emerald"}>Failure streak {provider.failureStreak}</AdminBadge>
            </div>
          </AdminPanel>
        ))}
      </section>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader eyebrow="Account queue" title="Recent provider connections" description="Fast review of the latest connected delivery accounts and their health state." />
        <FlowList
          emptyLabel="No delivery accounts found."
          items={accounts.slice(0, 8).map((account) => ({
            title: account.provider_name ?? account.provider,
            subtitle: `${account.account_label} · ${account.connection_status ?? "unknown"} · ${account.active ? "active" : "inactive"}`,
            meta: account.last_sync_at ? new Date(account.last_sync_at).toLocaleDateString() : "No sync",
            tone: account.active ? "emerald" : "amber"
          }))}
        />
      </AdminPanel>
    </div>
  );
}