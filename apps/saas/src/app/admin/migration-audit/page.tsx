import path from "node:path";
import { promises as fs } from "node:fs";
import { createClient } from "@/lib/supabase/server";
import { AlertIcon, CheckIcon, XIcon } from "@/components/ui/icons";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

type AuditResult = {
  localMigrations: string[];
  remoteMigrations: string[];
  remoteMetadataAccessible: boolean;
  remoteMetadataError: string | null;
  localOnly: string[];
  remoteOnly: string[];
  schemaChecks: Array<{ label: string; ok: boolean; message: string }>;
};

const REQUIRED_TABLES = [
  "delivery_orders",
  "merchant_shipments",
  "merchant_notifications",
  "merchant_push_subscriptions",
  "delivery_webhook_events",
  "customer_reputation",
  "delivery_accounts",
  "merchant_shipping_profiles",
  "network_sync_reports",
  "order_checks",
] as const;

async function getLocalMigrationFiles() {
  const root = process.cwd();
  const migrationsDir = path.join(root, "..", "..", "supabase", "migrations");
  const names = await fs.readdir(migrationsDir);
  return names.filter((name) => name.endsWith(".sql")).sort();
}

async function getRemoteMigrationNames() {
  const supabase = createClient();
  const publicTry = await supabase
    .from("_supabase_migrations")
    .select("name")
    .order("name", { ascending: true })
    .limit(2000);

  if (!publicTry.error && publicTry.data) {
    return {
      names: publicTry.data
        .map((row) => String((row as { name?: string }).name ?? ""))
        .filter(Boolean),
      accessible: true,
      error: null,
    };
  }

  return {
    names: [] as string[],
    accessible: false,
    error: publicTry.error?.message ?? "Remote migration metadata not accessible",
  };
}

async function checkSchemaTables() {
  const supabase = createClient();
  const checks: Array<{ label: string; ok: boolean; message: string }> = [];
  for (const table of REQUIRED_TABLES) {
    const { error } = await supabase.from(table).select("id").limit(1);
    checks.push({ label: table, ok: !error, message: error ? error.message : "OK" });
  }
  return checks;
}

async function runAudit(): Promise<AuditResult> {
  const [localMigrations, remoteResult, schemaChecks] = await Promise.all([
    getLocalMigrationFiles(),
    getRemoteMigrationNames(),
    checkSchemaTables(),
  ]);

  const remoteMigrations = remoteResult.names;
  const localSet = new Set(localMigrations);
  const remoteSet = new Set(remoteMigrations);

  return {
    localMigrations,
    remoteMigrations,
    remoteMetadataAccessible: remoteResult.accessible,
    remoteMetadataError: remoteResult.error,
    localOnly: localMigrations.filter((name) => !remoteSet.has(name)),
    remoteOnly: remoteMigrations.filter((name) => !localSet.has(name)),
    schemaChecks,
  };
}

export default async function MigrationAuditPage() {
  const audit = await runAudit();
  const schemaPassCount = audit.schemaChecks.filter((item) => item.ok).length;
  const schemaHealthy = schemaPassCount === audit.schemaChecks.length;
  const driftDetected = audit.localOnly.length > 0 || audit.remoteOnly.length > 0;
  const fullyHealthy = schemaHealthy && !driftDetected && audit.remoteMetadataAccessible;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="sky">Database</AdminBadge>
          <h1 className="text-2xl font-semibold text-white">Migration Safety Audit</h1>
          <p className="text-sm text-slate-400">
            Audit migration history, detect local/remote drift, verify applied schema, and follow a
            non-destructive rollback plan.
          </p>
        </div>
      </div>

      {/* Summary banner */}
      <div
        className={`rounded-2xl border p-5 ${
          fullyHealthy
            ? "border-emerald-700/40 bg-emerald-900/20"
            : "border-amber-700/40 bg-amber-900/20"
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p
              className={`text-xl font-bold ${
                fullyHealthy ? "text-emerald-300" : "text-amber-300"
              }`}
            >
              {fullyHealthy ? "PASS" : "ATTENTION"}
            </p>
            <p
              className={`mt-1 text-sm ${
                fullyHealthy ? "text-emerald-400" : "text-amber-400"
              }`}
            >
              Local migrations: {audit.localMigrations.length} · Remote:{" "}
              {audit.remoteMigrations.length} · Schema checks: {schemaPassCount}/
              {audit.schemaChecks.length}
            </p>
          </div>
          <AdminBadge tone={fullyHealthy ? "emerald" : "amber"}>
            {fullyHealthy ? "Healthy" : "Needs review"}
          </AdminBadge>
        </div>
      </div>

      {/* Remote metadata warning */}
      {!audit.remoteMetadataAccessible ? (
        <div className="rounded-2xl border border-amber-700/40 bg-amber-900/20 p-4 text-sm text-amber-300">
          <div className="flex items-start gap-2">
            <AlertIcon size={15} className="mt-0.5 shrink-0 text-amber-400" />
            <span>
              Remote migration metadata is not accessible from the app runtime:{" "}
              {audit.remoteMetadataError}. Use the Supabase SQL editor with
              reports/launch/migration-repair.sql for manual non-destructive reconciliation.
            </span>
          </div>
        </div>
      ) : null}

      {/* Migration history */}
      <AdminPanel className="space-y-4">
        <AdminSectionHeader eyebrow="1 / 4" title="Migration History" />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Local files ({audit.localMigrations.length})
            </p>
            <ul className="max-h-64 space-y-1 overflow-auto rounded-xl border border-slate-700/40 bg-slate-900/40 p-3 text-xs font-mono text-slate-400">
              {audit.localMigrations.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Remote applied ({audit.remoteMigrations.length})
            </p>
            <ul className="max-h-64 space-y-1 overflow-auto rounded-xl border border-slate-700/40 bg-slate-900/40 p-3 text-xs font-mono text-slate-400">
              {audit.remoteMigrations.length > 0 ? (
                audit.remoteMigrations.map((name) => <li key={name}>{name}</li>)
              ) : (
                <li className="text-slate-600">Remote migration metadata unavailable.</li>
              )}
            </ul>
          </div>
        </div>
      </AdminPanel>

      {/* Drift detection */}
      <AdminPanel className="space-y-4">
        <AdminSectionHeader eyebrow="2 / 4" title="Drift Detection" />
        <div className="space-y-2">
          <DriftCard
            title="Local but not remote"
            values={audit.localOnly}
            tone={audit.localOnly.length === 0 ? "ok" : "warn"}
          />
          <DriftCard
            title="Remote but not local"
            values={audit.remoteOnly}
            tone={audit.remoteOnly.length === 0 ? "ok" : "warn"}
          />
        </div>
      </AdminPanel>

      {/* Schema verification */}
      <AdminPanel className="space-y-4">
        <AdminSectionHeader eyebrow="3 / 4" title="Applied Schema Verification" />
        <div className="space-y-2">
          {audit.schemaChecks.map((item) => (
            <div
              key={item.label}
              className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
                item.ok
                  ? "border-emerald-700/30 bg-emerald-900/20"
                  : "border-rose-700/30 bg-rose-900/20"
              }`}
            >
              <div className="flex items-center gap-2.5">
                {item.ok ? (
                  <CheckIcon size={15} className="shrink-0 text-emerald-400" />
                ) : (
                  <XIcon size={15} className="shrink-0 text-rose-400" />
                )}
                <div>
                  <p
                    className={`text-sm font-semibold font-mono ${
                      item.ok ? "text-emerald-300" : "text-rose-300"
                    }`}
                  >
                    {item.label}
                  </p>
                  {!item.ok ? (
                    <p className="mt-0.5 text-xs text-rose-400">{item.message}</p>
                  ) : null}
                </div>
              </div>
              <AdminBadge tone={item.ok ? "emerald" : "rose"}>
                {item.ok ? "OK" : "FAIL"}
              </AdminBadge>
            </div>
          ))}
        </div>
      </AdminPanel>

      {/* Rollback plan */}
      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          eyebrow="4 / 4"
          title="Rollback Plan (Non-Destructive)"
          description="Follow these steps if schema repairs are needed. Never execute destructive SQL during launch phase."
        />
        <ol className="space-y-3 text-sm text-slate-300">
          {[
            "Take a full database backup and export affected table slices before any migration action.",
            "If drift exists, repair history first by aligning migration metadata — do not drop tables or columns.",
            "Apply forward-only corrective migration files to restore expected schema shape.",
            "Re-run this audit and launch checklist pages after each corrective step.",
            "Never execute destructive SQL (drop/truncate) during launch phase.",
          ].map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-700/60 text-[11px] font-bold text-slate-300">
                {i + 1}
              </span>
              <span className="leading-5">{step}</span>
            </li>
          ))}
        </ol>
        <div className="rounded-xl border border-amber-700/30 bg-amber-900/20 px-4 py-3 text-xs text-amber-400">
          <div className="flex items-center gap-2">
            <AlertIcon size={13} />
            Safety rule: merchant decision authority remains manual and unaffected by migration
            repair work.
          </div>
        </div>
      </AdminPanel>
    </div>
  );
}

function DriftCard({
  title,
  values,
  tone,
}: {
  title: string;
  values: string[];
  tone: "ok" | "warn";
}) {
  const ok = tone === "ok";
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        ok ? "border-emerald-700/30 bg-emerald-900/15" : "border-amber-700/30 bg-amber-900/15"
      }`}
    >
      <div className="flex items-center gap-2.5">
        {ok ? (
          <CheckIcon size={14} className="shrink-0 text-emerald-400" />
        ) : (
          <AlertIcon size={14} className="shrink-0 text-amber-400" />
        )}
        <p className={`text-sm font-semibold ${ok ? "text-emerald-300" : "text-amber-300"}`}>
          {title}: {values.length === 0 ? "none" : `${values.length} item(s)`}
        </p>
      </div>
      {values.length > 0 ? (
        <ul
          className={`mt-2 space-y-0.5 text-xs font-mono ${ok ? "text-emerald-400" : "text-amber-400"}`}
        >
          {values.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
