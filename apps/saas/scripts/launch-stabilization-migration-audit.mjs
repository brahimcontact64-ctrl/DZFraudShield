import fs from "node:fs/promises";
import path from "node:path";

function parseEnv(content) {
  const out = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    const value = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    out[key] = value;
  }
  return out;
}

async function loadEnv() {
  const envPath = path.resolve(process.cwd(), "apps/saas/.env.local");
  const content = await fs.readFile(envPath, "utf8");
  const fileEnv = parseEnv(content);
  return {
    ...fileEnv,
    ...process.env,
  };
}

function listToSection(title, rows) {
  if (!rows.length) {
    return `## ${title}\n- none\n`;
  }
  const items = rows.map((row) => `- ${row}`).join("\n");
  return `## ${title}\n${items}\n`;
}

function toSqlInsert(names) {
  if (!names.length) {
    return "-- no inserts required\n";
  }
  const values = names.map((name) => `('${name.replace(/'/g, "''")}')`).join(",\n");
  return `insert into _supabase_migrations (name) values\n${values}\non conflict (name) do nothing;\n`;
}

async function run() {
  const repair = process.argv.includes("--repair");
  const env = await loadEnv();

  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const authHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
  const localMigrations = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const fetchRemote = async () => {
    const response = await fetch(`${supabaseUrl}/rest/v1/_supabase_migrations?select=name&order=name.asc&limit=5000`, {
      headers: authHeaders,
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404) {
        return { names: [], unavailableReason: `Remote migration metadata table is not exposed via PostgREST: ${text}` };
      }
      throw new Error(`Unable to fetch remote migrations: ${response.status} ${text}`);
    }

    const data = await response.json();
    return {
      names: (Array.isArray(data) ? data : []).map((row) => String(row.name ?? "")).filter(Boolean),
      unavailableReason: null,
    };
  };

  let remoteResult = await fetchRemote();
  let remoteMigrations = remoteResult.names;
  let remoteUnavailableReason = remoteResult.unavailableReason;

  const computeDiff = () => {
    const localSet = new Set(localMigrations);
    const remoteSet = new Set(remoteMigrations);
    return {
      localOnly: localMigrations.filter((name) => !remoteSet.has(name)),
      remoteOnly: remoteMigrations.filter((name) => !localSet.has(name)),
    };
  };

  let { localOnly, remoteOnly } = computeDiff();
  const repaired = [];
  const repairFailed = [];

  if (repair && localOnly.length && !remoteUnavailableReason) {
    for (const name of localOnly) {
      const response = await fetch(`${supabaseUrl}/rest/v1/_supabase_migrations?on_conflict=name`, {
        method: "POST",
        headers: {
          ...authHeaders,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify([{ name }]),
      });

      if (!response.ok) {
        const text = await response.text();
        repairFailed.push(`${name} :: ${response.status} ${text}`);
      } else {
        repaired.push(name);
      }
    }

    remoteResult = await fetchRemote();
    remoteMigrations = remoteResult.names;
    remoteUnavailableReason = remoteResult.unavailableReason;
    ({ localOnly, remoteOnly } = computeDiff());
  }

  const exactMatch = !remoteUnavailableReason && localOnly.length === 0 && remoteOnly.length === 0;

  const now = new Date().toISOString();
  const reportDir = path.resolve(process.cwd(), "reports/launch");
  await fs.mkdir(reportDir, { recursive: true });

  const report = [
    "# Migration Audit Report",
    `- Generated at: ${now}`,
    `- Repair mode: ${repair ? "enabled" : "disabled"}`,
    `- Local migration count: ${localMigrations.length}`,
    `- Remote migration count: ${remoteMigrations.length}`,
    `- Exact match: ${remoteUnavailableReason ? "UNKNOWN" : (exactMatch ? "PASS" : "FAIL")}`,
    `- Remote metadata accessibility: ${remoteUnavailableReason ? "BLOCKED" : "OK"}`,
    "",
    ...(remoteUnavailableReason ? ["## Remote Metadata Blocker", `- ${remoteUnavailableReason}`, ""] : []),
    listToSection("Local Migrations", localMigrations),
    listToSection("Remote Migrations", remoteMigrations),
    listToSection("Local Only (Drift)", localOnly),
    listToSection("Remote Only (Drift)", remoteOnly),
    listToSection("Repaired Entries", repaired),
    listToSection("Repair Failures", repairFailed),
    "## Non-Destructive Repair SQL",
    "```sql",
    toSqlInsert(localOnly),
    "```",
  ].join("\n");

  const rollback = [
    "# Rollback Instructions",
    "1. Take a full database backup before any migration metadata change.",
    "2. Export rows from _supabase_migrations and affected business tables.",
    "3. If drift persists, only insert missing migration names; do not delete remote history during launch stabilization.",
    "4. If a migration script failed partially, create a forward-only corrective migration instead of rollback drops.",
    "5. Re-run migration audit and full verification suite after each corrective step.",
    "6. Never run destructive operations (drop/truncate) in launch stabilization mode.",
  ].join("\n");

  const deploymentChecklist = [
    "# Production Deployment Checklist",
    "## Pre-Deployment",
    "- [ ] Environment variables set in production",
    "- [ ] Supabase service role key rotated and stored securely",
    "- [ ] Migration audit exact match PASS",
    "- [ ] Launch health checks PASS (database, webhooks, push, sync, providers, cron)",
    "## Deployment",
    "- [ ] Deploy application build artifact",
    "- [ ] Confirm /admin/migration-audit PASS",
    "- [ ] Confirm /admin/launch-checklist PASS",
    "## Merchant Pilot (First 5)",
    "- [ ] Merchant account provisioned",
    "- [ ] Provider account connected and validated",
    "- [ ] Initial sync executed successfully",
    "- [ ] First import contains orders",
    "- [ ] Push notifications received",
    "- [ ] Webhook event processed end-to-end",
    "## Post-Deployment",
    "- [ ] npm run typecheck PASS",
    "- [ ] npm run test PASS",
    "- [ ] npm run build PASS",
    "- [ ] Collect feedback and incident notes for pilot merchants",
  ].join("\n");

  await fs.writeFile(path.join(reportDir, "migration-audit-report.md"), report, "utf8");
  await fs.writeFile(path.join(reportDir, "rollback-instructions.md"), rollback, "utf8");
  await fs.writeFile(path.join(reportDir, "production-deployment-checklist.md"), deploymentChecklist, "utf8");

  const summary = {
    exactMatch,
    remoteMetadataAccessible: !remoteUnavailableReason,
    localCount: localMigrations.length,
    remoteCount: remoteMigrations.length,
    localOnly: localOnly.length,
    remoteOnly: remoteOnly.length,
    repaired: repaired.length,
    repairFailed: repairFailed.length,
  };

  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
