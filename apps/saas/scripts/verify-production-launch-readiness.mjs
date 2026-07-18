/**
 * Production Launch Readiness Verification
 *
 * Safe, read-only checks:
 *   - Required environment variable presence (names only, no values printed)
 *   - Supabase REST table probes (service role, HEAD requests — no data written)
 *   - Cron route auth guard (sends wrong token, expects 401 — no side effects)
 *   - Route existence probes (push, webhook, monitoring, launch-checklist)
 *
 * Usage:
 *   npm run launch:verify:production
 *   # or with explicit base URL override:
 *   VERIFY_BASE_URL=https://your-production-domain.com npm run launch:verify:production
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "DELIVERY_SYNC_CRON_SECRET",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
];

const REQUIRED_TABLES = [
  "delivery_webhook_events",
  "merchant_push_subscriptions",
  "merchant_notifications",
  "merchant_shipping_profiles",
  "network_sync_reports",
];

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function parseEnvFile(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    out[key] = raw.replace(/^["']|["']$/g, "");
  }
  return out;
}

async function loadEnv() {
  const envPath = path.resolve(process.cwd(), "apps/saas/.env.local");
  let fileEnv = {};
  try {
    const content = await fs.readFile(envPath, "utf8");
    fileEnv = parseEnvFile(content);
  } catch {
    // .env.local may not exist in CI — fall back to process.env only
  }
  return { ...fileEnv, ...process.env };
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";
const SKIP = "SKIP";

function fmt(status, label, detail = "") {
  const icons = { PASS: "✓", FAIL: "✗", WARN: "!", SKIP: "-" };
  const icon = icons[status] ?? "?";
  const line = `  [${icon}] ${label}`;
  return detail ? `${line} — ${detail}` : line;
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ---------------------------------------------------------------------------
// Phase 1 — Environment variable presence
// ---------------------------------------------------------------------------

function checkEnvPresence(env) {
  section("Phase 1: Environment Variables");
  const results = [];
  for (const key of REQUIRED_ENV_VARS) {
    const present = Boolean(env[key] && env[key].trim().length > 0);
    const status = present ? PASS : FAIL;
    console.log(fmt(status, key, present ? "PRESENT" : "MISSING"));
    results.push({ key, status, present });
  }
  const missing = results.filter((r) => !r.present).map((r) => r.key);
  return { results, missing };
}

// ---------------------------------------------------------------------------
// Phase 2 — Supabase REST table probes
// ---------------------------------------------------------------------------

async function probeTable(supabaseUrl, serviceRoleKey, table) {
  const url = `${supabaseUrl}/rest/v1/${table}?limit=1`;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    return { table, status: res.status, ok: res.status === 200 };
  } catch (err) {
    return { table, status: null, ok: false, error: err.message };
  }
}

async function checkTableProbes(env) {
  section("Phase 2: Supabase REST Table Probes (service role, HEAD, read-only)");

  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.log(fmt(SKIP, "All table probes", "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — skipping"));
    return { results: [], skipped: true };
  }

  const results = [];
  for (const table of REQUIRED_TABLES) {
    const probe = await probeTable(supabaseUrl, serviceRoleKey, table);
    const statusStr = probe.status !== null ? String(probe.status) : "network_error";
    const label = probe.ok ? PASS : FAIL;
    console.log(fmt(label, table, `HTTP ${statusStr}`));
    results.push(probe);
  }
  return { results, skipped: false };
}

// ---------------------------------------------------------------------------
// Phase 3 — Cron route auth guard
// ---------------------------------------------------------------------------

async function checkCronAuth(baseUrl) {
  section("Phase 3: Cron Route Auth Guard");

  const url = `${baseUrl}/api/v1/jobs/delivery-sync`;
  const wrongToken = "verify-script-intentional-wrong-token-" + Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${wrongToken}`,
        "Content-Type": "application/json",
      },
    });

    // Expect 401 (unauthorized) when wrong token is sent
    // 500 means CRON_SECRET env var is missing on the server
    if (res.status === 401) {
      console.log(fmt(PASS, "delivery-sync cron auth", "401 returned for wrong token — guard active"));
      return { ok: true, status: res.status };
    } else if (res.status === 500) {
      console.log(fmt(FAIL, "delivery-sync cron auth", "500 returned — CRON_SECRET likely missing on server"));
      return { ok: false, status: res.status };
    } else {
      console.log(fmt(WARN, "delivery-sync cron auth", `Unexpected HTTP ${res.status} — expected 401`));
      return { ok: false, status: res.status };
    }
  } catch (err) {
    console.log(fmt(WARN, "delivery-sync cron route", `Network error: ${err.message}`));
    return { ok: false, status: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Route existence probes
// ---------------------------------------------------------------------------

async function probeRoute(baseUrl, path, method = "GET", description = "") {
  const url = `${baseUrl}${path}`;
  const label = description || path;
  try {
    const res = await fetch(url, { method });
    // Routes that require auth should return 401/403/405, not 404
    // A 404 means the route does not exist
    const exists = res.status !== 404;
    const status = res.status;
    const mark = exists ? PASS : FAIL;
    const detail = `HTTP ${status}`;
    const note = !exists ? " (route not found)" : status === 200 ? "" : " (exists, requires auth or has restrictions)";
    console.log(fmt(mark, label, `${detail}${note}`));
    return { path, status, exists };
  } catch (err) {
    console.log(fmt(WARN, label, `Network error: ${err.message}`));
    return { path, status: null, exists: false, error: err.message };
  }
}

async function checkRoutes(baseUrl) {
  section("Phase 4: Route Existence Probes");

  const routes = [
    { path: "/api/v1/pwa/push/subscribe", method: "POST", description: "push subscribe route" },
    { path: "/api/v1/pwa/push/unsubscribe", method: "POST", description: "push unsubscribe route" },
    { path: "/api/v1/delivery/webhooks/zr-express", method: "POST", description: "webhook route (zr-express)" },
    { path: "/api/v1/jobs/delivery-sync", method: "POST", description: "delivery sync cron route" },
    { path: "/admin/network/monitoring", method: "GET", description: "monitoring page" },
    { path: "/admin/launch-checklist", method: "GET", description: "launch checklist page" },
    { path: "/api/v1/plugin/ping", method: "GET", description: "plugin ping route" },
  ];

  const results = [];
  for (const r of routes) {
    const result = await probeRoute(baseUrl, r.path, r.method, r.description);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary({ envMissing, tableResults, tableSkipped, cronOk, routeResults, baseUrl }) {
  section("Summary");

  const envStatus = envMissing.length === 0 ? PASS : FAIL;
  console.log(fmt(envStatus, "Environment variables", envMissing.length === 0 ? "all PRESENT" : `MISSING: ${envMissing.join(", ")}`));

  if (tableSkipped) {
    console.log(fmt(SKIP, "Table probes", "skipped (credentials missing)"));
  } else {
    const failedTables = tableResults.filter((r) => !r.ok).map((r) => r.table);
    const tableStatus = failedTables.length === 0 ? PASS : FAIL;
    console.log(fmt(tableStatus, "Table probes", failedTables.length === 0 ? "all 200" : `FAILED: ${failedTables.join(", ")}`));
  }

  const cronStatus = cronOk ? PASS : FAIL;
  console.log(fmt(cronStatus, "Cron route auth guard", cronOk ? "401 guard active" : "guard not active or env missing"));

  const failedRoutes = routeResults.filter((r) => !r.exists).map((r) => r.path);
  const routeStatus = failedRoutes.length === 0 ? PASS : FAIL;
  console.log(fmt(routeStatus, "Route existence", failedRoutes.length === 0 ? "all present" : `MISSING: ${failedRoutes.join(", ")}`));

  const blockers = [];
  if (envMissing.length > 0) blockers.push(`env vars missing: ${envMissing.join(", ")}`);
  if (!tableSkipped && tableResults.some((r) => !r.ok)) blockers.push("one or more table probes failed");
  if (!cronOk) blockers.push("cron auth guard not active");
  if (failedRoutes.length > 0) blockers.push(`routes not found: ${failedRoutes.join(", ")}`);

  console.log("");
  if (blockers.length === 0) {
    console.log("  RESULT: GO — all checks passed");
  } else {
    console.log("  RESULT: NO-GO — blockers remain:");
    for (const b of blockers) console.log(`    • ${b}`);
  }

  return { blockers };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("DZ Fraud Shield — Production Launch Readiness Verification");
  console.log(`Date: ${new Date().toISOString()}`);

  const env = await loadEnv();

  // Determine base URL for route probes
  // Override with VERIFY_BASE_URL env var for production runs
  const baseUrl =
    (env.VERIFY_BASE_URL || "").replace(/\/$/, "") ||
    (env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "") ||
    "http://localhost:3000";

  console.log(`Base URL for route probes: ${baseUrl}`);

  // Phase 1
  const { results: envResults, missing: envMissing } = checkEnvPresence(env);

  // Phase 2
  const { results: tableResults, skipped: tableSkipped } = await checkTableProbes(env);

  // Phase 3
  const { ok: cronOk } = await checkCronAuth(baseUrl);

  // Phase 4
  const routeResults = await checkRoutes(baseUrl);

  // Summary
  const { blockers } = printSummary({ envMissing, tableResults, tableSkipped, cronOk, routeResults, baseUrl });

  console.log("");

  // Exit with non-zero if blockers exist (useful in CI)
  if (blockers.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verification script error:", err.message);
  process.exit(2);
});
