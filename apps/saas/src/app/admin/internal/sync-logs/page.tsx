import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminSyncLogsPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from("delivery_sync_logs")
    .select("id, provider, merchant_id, status, synced_orders, imported_count, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = data ?? [];

  const statusColor = (status: string) => {
    if (status === "success" || status === "completed") return "text-emerald-400";
    if (status === "failed" || status === "error") return "text-rose-400";
    return "text-amber-400";
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">Internal</AdminBadge>
        <h1 className="text-2xl font-semibold text-white">Sync Logs</h1>
        <p className="text-sm text-slate-400">
          All provider sync activity across all merchants, most recent first.
        </p>
      </div>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          title="Latest provider sync activity"
          description={`${rows.length} most recent sync events`}
        />
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No sync logs found.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-700/40">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-700/40 bg-slate-800/40">
                <tr>
                  {["Timestamp", "Merchant", "Provider", "Status", "Synced", "Imported"].map(
                    (col) => (
                      <th
                        key={col}
                        className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500"
                      >
                        {col}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {rows.map((row) => (
                  <tr key={row.id} className="transition hover:bg-slate-800/30">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {row.merchant_id?.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-300">{row.provider}</td>
                    <td className={`px-4 py-3 font-semibold ${statusColor(row.status ?? "")}`}>
                      {row.status ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{row.synced_orders ?? 0}</td>
                    <td className="px-4 py-3 text-slate-300">{row.imported_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminPanel>
    </div>
  );
}
