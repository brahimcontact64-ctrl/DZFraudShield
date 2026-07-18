import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "degraded" | "error";

function HealthCard({
  name,
  status,
  value,
  detail,
}: {
  name: string;
  status: CheckStatus;
  value: string;
  detail: string;
}) {
  const ring = {
    ok:       "border-emerald-400/25 bg-emerald-500/8",
    degraded: "border-amber-400/25 bg-amber-500/8",
    error:    "border-rose-400/25 bg-rose-500/8",
  }[status];

  const dot = {
    ok:       "bg-emerald-400",
    degraded: "bg-amber-400",
    error:    "bg-rose-400",
  }[status];

  const label = { ok: "OK", degraded: "DEGRADED", error: "ERROR" }[status];

  const labelColor = {
    ok:       "text-emerald-300",
    degraded: "text-amber-300",
    error:    "text-rose-300",
  }[status];

  return (
    <div className={`rounded-2xl border p-4 ${ring}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">{name}</p>
        <span className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] ${labelColor}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {label}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </div>
  );
}

function GateRow({ label, ready, details }: { label: string; ready: boolean; details: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border p-4 ${
      ready ? "border-emerald-700/30 bg-emerald-900/15" : "border-rose-700/30 bg-rose-900/15"
    }`}>
      <div className="mt-0.5 shrink-0">
        {ready ? (
          <CheckIcon size={16} className="text-emerald-400" />
        ) : (
          <XIcon size={16} className="text-rose-400" />
        )}
      </div>
      <div>
        <p className={`text-sm font-semibold ${ready ? "text-emerald-300" : "text-rose-300"}`}>
          {label} <span className="font-normal opacity-70">— {ready ? "PASS" : "FAIL"}</span>
        </p>
        <p className={`mt-0.5 text-xs ${ready ? "text-emerald-400/80" : "text-rose-400/80"}`}>
          {details}
        </p>
      </div>
    </div>
  );
}

type Tab = "health" | "readiness" | "deployment";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "health",     label: "System Health" },
  { key: "readiness",  label: "Launch Readiness" },
  { key: "deployment", label: "Deployment Gates" },
];

export default async function AdminHealthPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  const tab = (searchParams?.tab as Tab) ?? "health";
  const supabase = createClient();
  const now = Date.now();
  const yesterday = new Date(now - 86_400_000).toISOString();

  // ── System Health checks ────────────────────────────────────────────────────
  const checks: Record<string, CheckStatus> = {};
  const details: Record<string, { value: string; detail: string }> = {};

  try {
    const { error } = await supabase.from("background_jobs").select("id").limit(1);
    checks.supabase = error ? "error" : "ok";
    details.supabase = error
      ? { value: "Unreachable", detail: error.message.slice(0, 80) }
      : { value: "Connected", detail: "Service role query succeeded" };
  } catch (e) {
    checks.supabase = "error";
    details.supabase = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  try {
    const [{ count: pending }, { count: processing }, { count: failed }] = await Promise.all([
      supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
      supabase.from("background_jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("updated_at", yesterday),
    ]);
    const p = pending ?? 0; const pr = processing ?? 0; const f = failed ?? 0;
    checks.queue = f > 10 ? "degraded" : "ok";
    details.queue = { value: `${p} pending · ${pr} processing · ${f} failed`, detail: "Jobs in the last 24 hours" };
  } catch (e) {
    checks.queue = "error";
    details.queue = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  try {
    const stuckCutoff = new Date(now - 10 * 60_000).toISOString();
    const { count: stuck } = await supabase
      .from("background_jobs").select("id", { count: "exact", head: true })
      .eq("status", "processing").lt("updated_at", stuckCutoff);
    const s = stuck ?? 0;
    checks.stuck_jobs = s > 0 ? "degraded" : "ok";
    details.stuck_jobs = { value: s > 0 ? `${s} stuck` : "None", detail: "Processing jobs unchanged for >10 minutes" };
  } catch (e) {
    checks.stuck_jobs = "error";
    details.stuck_jobs = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  try {
    const { data, error } = await supabase
      .from("merchant_history_sync_status").select("last_parcels_synced_at")
      .not("last_parcels_synced_at", "is", null)
      .order("last_parcels_synced_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      checks.last_sync = "error";
      details.last_sync = { value: "Error", detail: error.message.slice(0, 80) };
    } else if (!data) {
      checks.last_sync = "degraded";
      details.last_sync = { value: "Never", detail: "No completed sync found across all merchants" };
    } else {
      const row = data as { last_parcels_synced_at: string };
      const ageMs = now - new Date(row.last_parcels_synced_at).getTime();
      const ageH = Math.round(ageMs / 3_600_000);
      checks.last_sync = ageMs > 48 * 3_600_000 ? "degraded" : "ok";
      details.last_sync = { value: `${ageH}h ago`, detail: new Date(row.last_parcels_synced_at).toLocaleString() };
    }
  } catch (e) {
    checks.last_sync = "error";
    details.last_sync = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  try {
    const { data, error } = await supabase
      .from("webhook_event_log").select("received_at, processed")
      .order("received_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      checks.webhook = "error";
      details.webhook = { value: "Error", detail: error.message.slice(0, 80) };
    } else if (!data) {
      checks.webhook = "degraded";
      details.webhook = { value: "No events", detail: "No webhook events ever received" };
    } else {
      const row = data as { received_at: string; processed: boolean | null };
      const ageH = Math.round((now - new Date(row.received_at).getTime()) / 3_600_000);
      checks.webhook = "ok";
      details.webhook = { value: `${ageH}h ago`, detail: `Last event received ${new Date(row.received_at).toLocaleString()}` };
    }
  } catch (e) {
    checks.webhook = "error";
    details.webhook = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  try {
    const { count, error } = await supabase
      .from("merchant_delivery_accounts").select("id", { count: "exact", head: true }).eq("active", true);
    checks.providers = error ? "error" : (count ?? 0) === 0 ? "degraded" : "ok";
    details.providers = error
      ? { value: "Error", detail: error.message.slice(0, 80) }
      : { value: `${count ?? 0} active`, detail: "Delivery accounts with active=true" };
  } catch (e) {
    checks.providers = "error";
    details.providers = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  try {
    const { data, error } = await supabase
      .from("merchant_history_sync_status").select("merchant_id, last_error")
      .order("last_heartbeat_at", { ascending: false }).limit(20);
    if (error) {
      checks.checkpoint = "error";
      details.checkpoint = { value: "Error", detail: error.message.slice(0, 80) };
    } else {
      const rows = (data ?? []) as { merchant_id: string; last_error: string | null }[];
      const withError = rows.filter((r) => r.last_error).length;
      checks.checkpoint = withError > 0 ? "degraded" : "ok";
      details.checkpoint = { value: withError > 0 ? `${withError} with errors` : "Clean", detail: `Sampled ${rows.length} most-recent merchant sync rows` };
    }
  } catch (e) {
    checks.checkpoint = "error";
    details.checkpoint = { value: "Error", detail: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }

  const values = Object.values(checks);
  const hasError    = values.includes("error");
  const hasDegraded = values.includes("degraded");
  const overallStatus: "healthy" | "degraded" | "unhealthy" = hasError ? "unhealthy" : hasDegraded ? "degraded" : "healthy";
  const overallTone = hasError ? "rose" : hasDegraded ? "amber" : "emerald";
  const overallLabel = {
    healthy:   "All systems operational",
    degraded:  "Degraded — review warnings below",
    unhealthy: "Unhealthy — immediate attention required",
  }[overallStatus];

  const checkEntries = [
    { key: "supabase",   name: "Database connection" },
    { key: "queue",      name: "Background queue" },
    { key: "stuck_jobs", name: "Stuck job detection" },
    { key: "last_sync",  name: "Last successful sync" },
    { key: "webhook",    name: "Webhook receiver" },
    { key: "providers",  name: "Delivery accounts" },
    { key: "checkpoint", name: "Checkpoint consistency" },
  ];

  // ── Launch Readiness checks ─────────────────────────────────────────────────
  async function tableExists(table: string) {
    const { error } = await supabase.from(table).select("id").limit(1);
    return !error;
  }

  const [
    databaseReady, webhookTable, webhookRecent,
    syncLogsTable, syncLogsRecent, pushSubscriptions,
    pushNotifications, providerAccounts, syncReportsTable, syncReports,
  ] = await Promise.all([
    (async () => { const { error } = await supabase.from("merchants").select("id").limit(1); return !error; })(),
    tableExists("delivery_webhook_events"),
    supabase.from("delivery_webhook_events").select("id", { count: "exact", head: true })
      .gte("received_at", new Date(now - 1000 * 60 * 60 * 24 * 14).toISOString()),
    tableExists("delivery_sync_logs"),
    supabase.from("delivery_sync_logs").select("id", { count: "exact", head: true })
      .gte("created_at", new Date(now - 1000 * 60 * 60 * 24 * 14).toISOString()),
    tableExists("merchant_push_subscriptions"),
    tableExists("merchant_notifications"),
    tableExists("merchant_delivery_accounts"),
    tableExists("network_sync_reports"),
    supabase.from("network_sync_reports").select("id", { count: "exact", head: true })
      .gte("created_at", new Date(now - 1000 * 60 * 60 * 24 * 14).toISOString()),
  ]);

  const launchChecks = [
    { label: "Database", ready: databaseReady, details: databaseReady ? "Primary database connectivity verified" : "Unable to query merchants table" },
    { label: "Webhooks", ready: webhookTable, details: webhookTable ? `${webhookRecent.count ?? 0} webhook events in last 14 days` : "Webhook events table unavailable" },
    { label: "Sync jobs", ready: syncLogsTable, details: syncLogsTable ? `${syncLogsRecent.count ?? 0} sync job logs in last 14 days` : "Delivery sync logs table unavailable" },
    { label: "Push notifications", ready: pushSubscriptions && pushNotifications, details: pushSubscriptions && pushNotifications ? "Push subscriptions and notifications available" : "Push tables unavailable" },
    { label: "Providers", ready: providerAccounts, details: providerAccounts ? "Provider accounts table is reachable" : "Provider accounts table unavailable" },
    { label: "Cron jobs", ready: syncReportsTable, details: syncReportsTable ? `${syncReports.count ?? 0} sync report entries in last 14 days` : "Cannot validate cron heartbeat" },
  ];
  const launchPassed = launchChecks.filter((c) => c.ready).length;
  const launchScore = Math.round((launchPassed / launchChecks.length) * 100);
  const launchReady = launchPassed === launchChecks.length;

  // ── Deployment Gate checks ──────────────────────────────────────────────────
  const [dbCheck, webhookCheck2, pushCheck, syncJobCheck, providerCheck, cronCheck] = await Promise.all([
    supabase.from("merchants").select("id", { count: "exact", head: true }),
    supabase.from("delivery_webhook_events").select("id", { count: "exact", head: true })
      .gte("received_at", new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("merchant_push_subscriptions").select("id", { count: "exact", head: true }).is("disabled_at", null),
    supabase.from("delivery_sync_logs").select("id", { count: "exact", head: true })
      .gte("created_at", new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("merchant_delivery_accounts").select("id", { count: "exact", head: true }).eq("connection_status", "connected"),
    supabase.from("network_sync_reports").select("id", { count: "exact", head: true })
      .gte("created_at", new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const deploymentChecks = [
    { label: "Database",           ready: !dbCheck.error,       details: dbCheck.error ? dbCheck.error.message : `Merchants visible: ${dbCheck.count ?? 0}` },
    { label: "Webhooks",           ready: !webhookCheck2.error, details: webhookCheck2.error ? webhookCheck2.error.message : `Events (14d): ${webhookCheck2.count ?? 0}` },
    { label: "Push notifications", ready: !pushCheck.error,     details: pushCheck.error ? pushCheck.error.message : `Active subscriptions: ${pushCheck.count ?? 0}` },
    { label: "Sync jobs",          ready: !syncJobCheck.error,  details: syncJobCheck.error ? syncJobCheck.error.message : `Sync logs (7d): ${syncJobCheck.count ?? 0}` },
    { label: "Providers",          ready: !providerCheck.error, details: providerCheck.error ? providerCheck.error.message : `Connected provider accounts: ${providerCheck.count ?? 0}` },
    { label: "Cron jobs",          ready: !cronCheck.error,     details: cronCheck.error ? cronCheck.error.message : `Network sync reports (14d): ${cronCheck.count ?? 0}` },
  ];
  const deployPassed = deploymentChecks.filter((c) => c.ready).length;
  const deployScore = Math.round((deployPassed / deploymentChecks.length) * 100);
  const deployReady = deployPassed === deploymentChecks.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="sky">Platform</AdminBadge>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Platform Monitoring</h1>
          <p className="max-w-3xl text-sm text-slate-300">
            Live system health, launch readiness gates, and deployment checks. Refreshes on every page load.
          </p>
        </div>
        <div className={`flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-semibold ${
          overallStatus === "healthy"  ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200" :
          overallStatus === "degraded" ? "border-amber-400/25 bg-amber-500/10 text-amber-200" :
                                          "border-rose-400/25 bg-rose-500/10 text-rose-200"
        }`}>
          <span className={`h-2.5 w-2.5 rounded-full animate-pulse ${
            overallStatus === "healthy" ? "bg-emerald-400" : overallStatus === "degraded" ? "bg-amber-400" : "bg-rose-400"
          }`} />
          {overallLabel}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-2xl border border-slate-700/40 bg-slate-800/30 p-1">
        {TABS.map(({ key, label }) => (
          <a
            key={key}
            href={`/admin/health?tab=${key}`}
            className={`flex-1 rounded-xl px-4 py-2 text-center text-sm font-medium transition-colors ${
              tab === key
                ? "bg-slate-700/60 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </a>
        ))}
      </div>

      {/* ── System Health tab ─────────────────────────────────────────────── */}
      {tab === "health" && (
        <>
          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              eyebrow="Health checks"
              title="Subsystem status"
              description={`Checked at ${new Date().toLocaleString()} — ${checkEntries.length} checks total.`}
              action={<AdminBadge tone={overallTone}>{overallStatus}</AdminBadge>}
            />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {checkEntries.map(({ key, name }) => (
                <HealthCard
                  key={key}
                  name={name}
                  status={checks[key] ?? "error"}
                  value={details[key]?.value ?? "Unknown"}
                  detail={details[key]?.detail ?? ""}
                />
              ))}
            </div>
          </AdminPanel>

          <div className="grid gap-4 lg:grid-cols-2">
            <AdminPanel className="space-y-3">
              <AdminSectionHeader
                eyebrow="Quick links"
                title="Related tools"
                description="Jump to deeper investigation pages."
              />
              <div className="grid gap-2">
                {[
                  { href: "/admin/jobs",                     label: "Background jobs viewer" },
                  { href: "/admin/webhooks",                 label: "Webhook event log" },
                  { href: "/admin/internal/sync-logs",       label: "Sync logs" },
                  { href: "/admin/internal/delivery-cache",  label: "Delivery cache" },
                  { href: "/admin/migration-audit",          label: "Migration audit" },
                ].map(({ href, label }) => (
                  <a
                    key={href}
                    href={href}
                    className="flex items-center justify-between rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-slate-700/40"
                  >
                    {label}
                    <span className="text-slate-500">→</span>
                  </a>
                ))}
              </div>
            </AdminPanel>

            <AdminPanel className="space-y-3">
              <AdminSectionHeader
                eyebrow="Thresholds"
                title="Check definitions"
                description="How each check determines its status."
              />
              <ul className="space-y-3 text-xs text-slate-300">
                {[
                  { name: "Database connection", ok: "Query returns without error", degraded: "—", error: "Query throws or returns error" },
                  { name: "Background queue", ok: "≤10 failed jobs in 24 h", degraded: ">10 failed jobs in 24 h", error: "Query fails" },
                  { name: "Stuck job detection", ok: "No processing jobs >10 min", degraded: "≥1 processing job >10 min", error: "Query fails" },
                  { name: "Last successful sync", ok: "Last sync <48 h ago", degraded: "Last sync >48 h ago or no sync", error: "Query fails" },
                  { name: "Webhook receiver", ok: "At least 1 event exists", degraded: "No events ever received", error: "Query fails" },
                  { name: "Delivery accounts", ok: "≥1 active account", degraded: "0 active accounts", error: "Query fails" },
                  { name: "Checkpoint consistency", ok: "No recent sync errors", degraded: "≥1 merchant with last_error set", error: "Query fails" },
                ].map(({ name, ok, degraded, error: err }) => (
                  <li key={name} className="rounded-xl border border-slate-700/40 bg-slate-800/30 p-3">
                    <p className="mb-1.5 font-semibold text-slate-100">{name}</p>
                    <p className="text-emerald-400">OK: {ok}</p>
                    {degraded !== "—" ? <p className="text-amber-400">Degraded: {degraded}</p> : null}
                    <p className="text-rose-400">Error: {err}</p>
                  </li>
                ))}
              </ul>
            </AdminPanel>
          </div>
        </>
      )}

      {/* ── Launch Readiness tab ──────────────────────────────────────────── */}
      {tab === "readiness" && (
        <>
          <div className={`rounded-2xl border p-5 ${
            launchReady ? "border-emerald-700/40 bg-emerald-900/20" : "border-amber-700/40 bg-amber-900/20"
          }`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className={`text-xl font-bold ${launchReady ? "text-emerald-300" : "text-amber-300"}`}>
                  {launchReady ? "PASS — Ready to launch" : "NOT READY"}
                </p>
                <p className={`mt-1 text-sm ${launchReady ? "text-emerald-400" : "text-amber-400"}`}>
                  {launchPassed} of {launchChecks.length} checks passed
                </p>
              </div>
              <div className={`flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-black ${
                launchReady ? "bg-emerald-900/40 text-emerald-300" : "bg-amber-900/40 text-amber-300"
              }`}>
                {launchScore}%
              </div>
            </div>
          </div>

          <AdminPanel className="space-y-2">
            <AdminSectionHeader
              title="System Checks"
              description="All systems must pass before launch."
            />
            <div className="space-y-2 pt-2">
              {launchChecks.map((item) => (
                <GateRow key={item.label} label={item.label} ready={item.ready} details={item.details} />
              ))}
            </div>
          </AdminPanel>

          {!launchReady && (
            <div className="rounded-2xl border border-amber-700/40 bg-amber-900/20 px-5 py-4 text-sm text-amber-400">
              Resolve FAIL checks before launch. Merchant decisions stay manual and no automatic blocking is performed by this checklist.
            </div>
          )}
        </>
      )}

      {/* ── Deployment Gates tab ─────────────────────────────────────────── */}
      {tab === "deployment" && (
        <>
          <div className={`rounded-2xl border p-5 ${
            deployReady ? "border-emerald-700/40 bg-emerald-900/20" : "border-amber-700/40 bg-amber-900/20"
          }`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className={`text-xl font-bold ${deployReady ? "text-emerald-300" : "text-amber-300"}`}>
                  {deployReady ? "READY" : "NOT READY"}
                </p>
                <p className={`mt-1 text-sm ${deployReady ? "text-emerald-400" : "text-amber-400"}`}>
                  {deployPassed} of {deploymentChecks.length} gates passed ({deployScore}%)
                </p>
              </div>
              <div className={`flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-black ${
                deployReady ? "bg-emerald-900/40 text-emerald-300" : "bg-amber-900/40 text-amber-300"
              }`}>
                {deployScore}%
              </div>
            </div>
          </div>

          <AdminPanel className="space-y-2">
            <AdminSectionHeader
              title="Deployment Gates"
              description="Every gate must pass before production rollout."
            />
            <div className="space-y-2 pt-2">
              {deploymentChecks.map((item) => (
                <GateRow key={item.label} label={item.label} ready={item.ready} details={item.details} />
              ))}
            </div>
          </AdminPanel>

          <AdminPanel className="space-y-4">
            <AdminSectionHeader
              title="Pilot Rollout Plan"
              description="Follow this sequence for safe initial merchant onboarding."
            />
            <ol className="space-y-3 text-sm text-slate-300">
              {[
                "Onboard merchant 1 and verify first successful import.",
                "Observe webhook and push behavior for 24 hours.",
                "Repeat for merchants 2 through 5 with the same checklist.",
                "Capture incidents and feedback before broader rollout.",
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-700/60 text-[11px] font-bold text-slate-300">
                    {i + 1}
                  </span>
                  <span className="leading-5">{step}</span>
                </li>
              ))}
            </ol>
          </AdminPanel>
        </>
      )}
    </div>
  );
}
