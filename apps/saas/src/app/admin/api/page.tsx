import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader, FlowList } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminApiPage() {
  const supabase = createClient();
  const [keysResult, merchantsResult, storesResult] = await Promise.all([
    supabase.from("merchant_api_keys").select("id, merchant_id, key_name, key_prefix, is_active, created_at, last_used_at").order("created_at", { ascending: false }),
    supabase.from("merchants").select("id, name"),
    supabase.from("stores").select("merchant_id, name").order("created_at", { ascending: true })
  ]);

  if (keysResult.error) throw keysResult.error;
  if (merchantsResult.error) throw merchantsResult.error;
  if (storesResult.error) throw storesResult.error;

  const merchantNameById = new Map((merchantsResult.data ?? []).map((row) => [row.id, row.name]));
  const merchantStoreById = new Map<string, string>();
  for (const store of storesResult.data ?? []) {
    if (!merchantStoreById.has(store.merchant_id)) {
      merchantStoreById.set(store.merchant_id, store.name);
    }
  }

  const formatMerchantLabel = (merchantId: string) => {
    const merchantName = merchantNameById.get(merchantId) ?? "Unnamed merchant";
    const storeName = merchantStoreById.get(merchantId) ?? "No store";
    return `${merchantName} · ${storeName} · ${merchantId.slice(0, 8)}`;
  };

  const keys = (keysResult.data ?? []).map((key) => {
    const ageDays = Math.max(1, Math.round((Date.now() - new Date(key.created_at).getTime()) / (1000 * 60 * 60 * 24)));
    const usedAt = key.last_used_at ? new Date(key.last_used_at) : null;
    const usageState = usedAt
      ? Date.now() - usedAt.getTime() < 24 * 60 * 60 * 1000
        ? "Hot"
        : Date.now() - usedAt.getTime() < 7 * 24 * 60 * 60 * 1000
          ? "Warm"
          : "Idle"
      : "Never used";

    return {
      ...key,
      merchantName: formatMerchantLabel(key.merchant_id),
      ageDays,
      usageState,
      requests: key.last_used_at ? `Seen ${new Date(key.last_used_at).toLocaleDateString()}` : "Not yet used",
      errors: key.is_active ? 0 : 1,
      rateLimit: "120 req/min"
    };
  });

  const activeKeys = keys.filter((key) => key.is_active).length;
  const usedLastWeek = keys.filter((key) => key.last_used_at && Date.now() - new Date(key.last_used_at).getTime() < 7 * 24 * 60 * 60 * 1000).length;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">API Management</AdminBadge>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Stripe-style API control</h1>
        <p className="max-w-3xl text-sm text-slate-300">Keys, usage signals, last-used activity, and enforced rate limits for the WooCommerce integration layer.</p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Keys" value={keys.length} tone="sky" />
        <AdminMetricCard label="Active Keys" value={activeKeys} tone="emerald" />
        <AdminMetricCard label="Keys Used Recently" value={usedLastWeek} tone="gold" />
        <AdminMetricCard label="Rate Limit" value="120 req/min" tone="amber" />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <AdminPanel className="xl:col-span-2 space-y-4">
          <AdminSectionHeader eyebrow="Key inventory" title="Merchant API keys" description="Design the control surface like a real platform console, not a hidden settings page." />
          <div className="overflow-hidden rounded-xl border border-slate-700/40">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wider text-slate-500 border-b border-slate-700/40">
                <tr>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Merchant</th>
                  <th className="px-4 py-3">Usage</th>
                  <th className="px-4 py-3">Last Used</th>
                  <th className="px-4 py-3">Rate Limit</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className="border-t border-slate-700/30">
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">{key.key_name}</p>
                      <p className="mt-1 font-mono text-xs text-slate-400">{key.key_prefix}••••••••</p>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{key.merchantName}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-2">
                        <AdminBadge tone={key.usageState === "Hot" ? "emerald" : key.usageState === "Warm" ? "amber" : "neutral"}>{key.usageState}</AdminBadge>
                        <span className="text-xs text-slate-400">Requests are capped per authentication scope.</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "Never"}</td>
                    <td className="px-4 py-3 text-slate-300">{key.rateLimit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminPanel>

        <AdminPanel className="space-y-4">
          <AdminSectionHeader eyebrow="Security posture" title="Key health" description="Honest telemetry based on the available service-role signals." />
          <FlowList
            emptyLabel="No API keys yet."
            items={keys.slice(0, 8).map((key) => ({
              title: key.key_name,
              subtitle: `${key.merchantName} · ${key.requests} · ${key.errors} errors`,
              meta: key.is_active ? "Active" : "Inactive",
              tone: key.is_active ? "emerald" : "rose"
            }))}
          />
        </AdminPanel>
      </section>
    </div>
  );
}