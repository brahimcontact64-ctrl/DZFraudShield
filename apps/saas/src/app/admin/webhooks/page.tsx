import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type WebhookRow = {
  id: string;
  merchant_id: string | null;
  provider: string | null;
  event_type: string | null;
  tracking: string | null;
  processed: boolean | null;
  processed_at: string | null;
  skip_reason: string | null;
  error: string | null;
  received_at: string;
  signature_valid: boolean | null;
};

export default async function AdminWebhooksPage({
  searchParams,
}: {
  searchParams?: { provider?: string; status?: string; page?: string };
}) {
  const supabase = createClient();

  const filterProvider = searchParams?.provider && searchParams.provider !== "all" ? searchParams.provider : null;
  const filterStatus   = searchParams?.status   && searchParams.status   !== "all" ? searchParams.status   : null;
  const page = Math.max(1, parseInt(searchParams?.page ?? "1", 10));
  const pageSize = 30;
  const offset = (page - 1) * pageSize;

  const yesterday = new Date(Date.now() - 86_400_000).toISOString();

  let query = supabase
    .from("webhook_event_log")
    .select("id, merchant_id, provider, event_type, tracking, processed, processed_at, skip_reason, error, received_at, signature_valid", { count: "exact" })
    .order("received_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filterProvider) query = query.eq("provider", filterProvider);
  if (filterStatus === "processed")   query = query.eq("processed", true).is("skip_reason", null);
  if (filterStatus === "skipped")     query = query.not("skip_reason", "is", null);
  if (filterStatus === "failed")      query = query.not("error", "is", null);
  if (filterStatus === "unprocessed") query = query.eq("processed", false).is("skip_reason", null).is("error", null);

  const [
    { data: events, count: totalCount },
    { count: totalLast24h },
    { count: processedLast24h },
    { count: failedLast24h },
    { count: skippedLast24h },
  ] = await Promise.all([
    query,
    supabase.from("webhook_event_log").select("id", { count: "exact", head: true }).gte("received_at", yesterday),
    supabase.from("webhook_event_log").select("id", { count: "exact", head: true }).gte("received_at", yesterday).eq("processed", true),
    supabase.from("webhook_event_log").select("id", { count: "exact", head: true }).gte("received_at", yesterday).not("error", "is", null),
    supabase.from("webhook_event_log").select("id", { count: "exact", head: true }).gte("received_at", yesterday).not("skip_reason", "is", null),
  ]);

  const totalPages = Math.max(1, Math.ceil((totalCount ?? 0) / pageSize));

  const providers = Array.from(
    new Set((events ?? []).map((e: { provider: string | null }) => e.provider).filter(Boolean))
  ) as string[];

  function rowStatusBadge(row: WebhookRow) {
    if (row.error)        return <AdminBadge tone="rose">failed</AdminBadge>;
    if (row.skip_reason)  return <AdminBadge tone="amber">skipped</AdminBadge>;
    if (row.processed)    return <AdminBadge tone="emerald">processed</AdminBadge>;
    return <AdminBadge tone="neutral">pending</AdminBadge>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">System</AdminBadge>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Webhook events</h1>
        <p className="max-w-3xl text-sm text-slate-300">
          Delivery provider webhook event log. Shows received, processed, skipped, and failed events across all merchants.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Received (24 h)" value={totalLast24h ?? 0} delta="All webhook events" tone="sky" />
        <AdminMetricCard label="Processed (24 h)" value={processedLast24h ?? 0} delta="Successfully handled" tone="emerald" />
        <AdminMetricCard label="Skipped (24 h)" value={skippedLast24h ?? 0} delta="Duplicate or irrelevant" tone="amber" />
        <AdminMetricCard label="Failed (24 h)" value={failedLast24h ?? 0} delta="Processing error" tone={failedLast24h && failedLast24h > 0 ? "rose" : "emerald"} />
      </section>

      <AdminPanel className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <AdminSectionHeader
            eyebrow="Event log"
            title="Recent webhook events"
            description={`Showing ${pageSize} events per page. Total: ${(totalCount ?? 0).toLocaleString()} across all time.`}
          />
          <form method="get" action="/admin/webhooks" className="flex flex-wrap items-center gap-2">
            <select
              name="provider"
              defaultValue={filterProvider ?? "all"}
              className="rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none"
            >
              <option value="all">All providers</option>
              {providers.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value="yalidine">Yalidine</option>
            </select>
            <select
              name="status"
              defaultValue={filterStatus ?? "all"}
              className="rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none"
            >
              <option value="all">All statuses</option>
              <option value="processed">Processed</option>
              <option value="skipped">Skipped</option>
              <option value="failed">Failed</option>
              <option value="unprocessed">Unprocessed</option>
            </select>
            <button className="rounded-xl border border-slate-700/40 bg-slate-700/30 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700/50">
              Filter
            </button>
            {(filterProvider || filterStatus) ? (
              <a href="/admin/webhooks" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-700/40">
                Reset
              </a>
            ) : null}
          </form>
        </div>

        {events && events.length > 0 ? (
          <>
            <div className="overflow-x-auto rounded-xl border border-slate-700/40">
              <table className="min-w-[960px] w-full text-sm">
                <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wider text-slate-500 border-b border-slate-700/40">
                  <tr>
                    <th className="px-3 py-3">Received</th>
                    <th className="px-3 py-3">Provider</th>
                    <th className="px-3 py-3">Event type</th>
                    <th className="px-3 py-3">Tracking</th>
                    <th className="px-3 py-3">Merchant</th>
                    <th className="px-3 py-3">Sig</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(events as WebhookRow[]).map((row) => (
                    <tr key={row.id} className="border-t border-slate-700/30 hover:bg-slate-800/30">
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-300">
                        {new Date(row.received_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-3">
                        {row.provider ? <AdminBadge tone="sky">{row.provider}</AdminBadge> : <span className="text-slate-500">—</span>}
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-200">{row.event_type ?? "—"}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-300">{row.tracking ?? "—"}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-400">
                        {row.merchant_id ? `${row.merchant_id.slice(0, 8)}…` : "—"}
                      </td>
                      <td className="px-3 py-3">
                        {row.signature_valid === true  ? <span className="text-emerald-400 text-xs">✓</span>
                          : row.signature_valid === false ? <span className="text-rose-400 text-xs">✗</span>
                          : <span className="text-slate-500 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-3">{rowStatusBadge(row)}</td>
                      <td className="max-w-[200px] px-3 py-3">
                        <span className="block truncate text-xs text-slate-400" title={row.skip_reason ?? row.error ?? ""}>
                          {row.skip_reason ?? row.error ?? "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 ? (
              <div className="flex items-center justify-between gap-4 pt-1">
                <p className="text-xs text-slate-400">
                  Page {page} of {totalPages} ({(totalCount ?? 0).toLocaleString()} total)
                </p>
                <div className="flex gap-2">
                  {page > 1 ? (
                    <a
                      href={`/admin/webhooks?${new URLSearchParams({ ...(filterProvider ? { provider: filterProvider } : {}), ...(filterStatus ? { status: filterStatus } : {}), page: String(page - 1) }).toString()}`}
                      className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/40"
                    >
                      ← Previous
                    </a>
                  ) : null}
                  {page < totalPages ? (
                    <a
                      href={`/admin/webhooks?${new URLSearchParams({ ...(filterProvider ? { provider: filterProvider } : {}), ...(filterStatus ? { status: filterStatus } : {}), page: String(page + 1) }).toString()}`}
                      className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700/40"
                    >
                      Next →
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-400">No webhook events match the current filters.</p>
        )}
      </AdminPanel>
    </div>
  );
}
