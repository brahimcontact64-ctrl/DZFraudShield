import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const JOB_TYPES = [
  "yalidine_history_full_sync",
  "yalidine_history_incremental_sync",
  "yalidine_history_targeted_sync",
  "yalidine_history_reputation_recompute",
  "marketing_product_stats_recompute",
  "marketing_delivery_outcome_enrich",
  "marketing_intelligence_backfill",
] as const;

function toneForJobType(type: string): "sky" | "emerald" | "amber" | "violet" | "neutral" {
  if (type.includes("full_sync"))        return "sky";
  if (type.includes("incremental_sync")) return "emerald";
  if (type.includes("targeted_sync"))    return "amber";
  if (type.includes("reputation"))       return "violet";
  if (type.startsWith("marketing_"))     return "amber";
  return "neutral";
}

function labelForJobType(type: string): string {
  return type
    .replace("yalidine_history_", "")
    .replace("marketing_", "mkt: ")
    .replaceAll("_", " ");
}

type JobRow = {
  id: string;
  type: string;
  merchant_id: string | null;
  attempts: number;
  last_error?: string | null;
  updated_at: string;
};

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams?: { type?: string };
}) {
  const supabase = createClient();
  const filterType = searchParams?.type && searchParams.type !== "all" ? searchParams.type : null;

  const [
    { count: pendingCount },
    { count: processingCount },
    { count: failedCount },
    { data: runningJobs },
    { data: failedJobs },
    { data: pendingSample },
  ] = await Promise.all([
    supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
    supabase.from("background_jobs").select("id", { count: "exact", head: true })
      .eq("status", "failed")
      .gte("updated_at", new Date(Date.now() - 86_400_000).toISOString()),
    supabase.from("background_jobs")
      .select("id, type, merchant_id, attempts, updated_at")
      .eq("status", "processing")
      .order("updated_at", { ascending: true })
      .limit(25),
    supabase.from("background_jobs")
      .select("id, type, merchant_id, attempts, last_error, updated_at")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(25),
    supabase.from("background_jobs")
      .select("type, id")
      .eq("status", "pending")
      .limit(300),
  ]);

  const pendingByType = new Map<string, number>();
  for (const job of (pendingSample ?? []) as { type: string; id: string }[]) {
    pendingByType.set(job.type, (pendingByType.get(job.type) ?? 0) + 1);
  }

  const filteredFailed = filterType
    ? (failedJobs ?? []).filter((j: { type: string }) => j.type === filterType)
    : (failedJobs ?? []);

  const stuckCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const stuckJobs = (runningJobs ?? []).filter(
    (j: { updated_at: string }) => j.updated_at < stuckCutoff,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="sky">System</AdminBadge>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Background jobs</h1>
          <p className="max-w-3xl text-sm text-slate-300">
            Live view of the MDI background job queue — pending, processing, and recently failed jobs across all merchants.
          </p>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard label="Pending jobs" value={pendingCount ?? 0} delta="Waiting to be claimed" tone="sky" />
        <AdminMetricCard label="Processing" value={processingCount ?? 0} delta="Currently running" tone="emerald" />
        <AdminMetricCard label="Failed (24 h)" value={failedCount ?? 0} delta="Exhausted retry budget" tone="rose" />
        <AdminMetricCard label="Stuck (>10 min)" value={stuckJobs.length} delta="Processing without progress" tone={stuckJobs.length > 0 ? "rose" : "emerald"} />
      </section>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          eyebrow="Breakdown"
          title="Pending jobs by type"
          description="Counts from the first 300 pending rows — may undercount large queues."
        />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
          {JOB_TYPES.map((type) => {
            const count = pendingByType.get(type) ?? 0;
            return (
              <div key={type} className="rounded-2xl border border-slate-700/40 bg-slate-800/40 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  {labelForJobType(type)}
                </p>
                <p className="mt-2 text-3xl font-semibold text-white">{count}</p>
                <AdminBadge tone={toneForJobType(type)} >{type.replace("yalidine_history_", "")}</AdminBadge>
              </div>
            );
          })}
        </div>
      </AdminPanel>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          eyebrow="Running"
          title="Currently processing jobs"
          description="Jobs claimed by the processor and not yet completed. Oldest first — long-running jobs at the top."
          action={
            stuckJobs.length > 0 ? (
              <AdminBadge tone="rose">{stuckJobs.length} stuck</AdminBadge>
            ) : (
              <AdminBadge tone="emerald">No stuck jobs</AdminBadge>
            )
          }
        />
        {runningJobs && runningJobs.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-slate-700/40">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                <tr>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Merchant ID</th>
                  <th className="px-3 py-3">Attempts</th>
                  <th className="px-3 py-3">Last updated</th>
                  <th className="px-3 py-3">Age</th>
                </tr>
              </thead>
              <tbody>
                {(runningJobs as JobRow[]).map((job) => {
                  const ageMs = Date.now() - new Date(job.updated_at).getTime();
                  const ageMin = Math.round(ageMs / 60_000);
                  const isStuck = job.updated_at < stuckCutoff;
                  return (
                    <tr key={job.id} className={`border-t border-slate-700/30 ${isStuck ? "bg-rose-500/5" : ""}`}>
                      <td className="px-3 py-3">
                        <AdminBadge tone={toneForJobType(job.type)}>{labelForJobType(job.type)}</AdminBadge>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-300">{job.merchant_id?.slice(0, 8) ?? "N/A"}…</td>
                      <td className="px-3 py-3 text-slate-200">{job.attempts}</td>
                      <td className="px-3 py-3 text-slate-300">{new Date(job.updated_at).toLocaleString()}</td>
                      <td className="px-3 py-3">
                        <span className={`text-xs font-semibold ${isStuck ? "text-rose-300" : "text-slate-400"}`}>
                          {ageMin}m{isStuck ? " ⚠ stuck" : ""}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No jobs currently processing.</p>
        )}
      </AdminPanel>

      <AdminPanel className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <AdminSectionHeader
            eyebrow="Failures"
            title="Recent failed jobs (24 h)"
            description="Jobs that exhausted their retry budget. Check last_error for the root cause."
          />
          <form method="get" action="/admin/jobs" className="flex items-center gap-2">
            <select
              name="type"
              defaultValue={filterType ?? "all"}
              className="rounded-xl border border-slate-700/40 bg-[#07111B] px-3 py-2 text-sm text-slate-100 outline-none"
            >
              <option value="all">All types</option>
              {JOB_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button className="rounded-xl border border-slate-700/40 bg-slate-700/30 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700/50">
              Filter
            </button>
          </form>
        </div>

        {filteredFailed.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-slate-700/40">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-[0.16em] text-slate-500 border-b border-slate-700/40">
                <tr>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Merchant ID</th>
                  <th className="px-3 py-3">Attempts</th>
                  <th className="px-3 py-3">Last error</th>
                  <th className="px-3 py-3">Failed at</th>
                </tr>
              </thead>
              <tbody>
                {(filteredFailed as JobRow[]).map((job) => (
                  <tr key={job.id} className="border-t border-slate-700/30">
                    <td className="px-3 py-3">
                      <AdminBadge tone={toneForJobType(job.type)}>{labelForJobType(job.type)}</AdminBadge>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-300">{job.merchant_id?.slice(0, 8) ?? "N/A"}…</td>
                    <td className="px-3 py-3 text-slate-200">{job.attempts}</td>
                    <td className="max-w-sm px-3 py-3">
                      <span className="block truncate text-xs text-rose-300" title={job.last_error ?? ""}>
                        {job.last_error ? job.last_error.slice(0, 120) : "—"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-300">
                      {new Date(job.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            {filterType ? `No failed jobs of type "${labelForJobType(filterType)}".` : "No failed jobs in the last 24 hours."}
          </p>
        )}
      </AdminPanel>
    </div>
  );
}
