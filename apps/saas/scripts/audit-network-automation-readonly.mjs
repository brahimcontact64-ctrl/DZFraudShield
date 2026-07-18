import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function yesNo(value) {
  return value ? "PASS" : "FAIL";
}

function toIso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function scanBlockedTokens(input, blockedTokens) {
  const haystack = JSON.stringify(input ?? {}).toLowerCase();
  const found = [];
  for (const token of blockedTokens) {
    if (haystack.includes(token.toLowerCase())) {
      found.push(token);
    }
  }
  return found;
}

async function main() {
  const root = process.cwd();
  const workspaceRoot = path.resolve(root, "..", "..");
  loadDotEnv(path.resolve(root, ".env.local"));

  const supabaseUrl = assertEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = assertEnv("SUPABASE_SERVICE_ROLE_KEY");
  const restBase = `${supabaseUrl}/rest/v1`;

  async function rest(pathname, init = {}) {
    const response = await fetch(`${restBase}${pathname}`, {
      ...init,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PostgREST ${response.status} ${response.statusText}: ${pathname} :: ${body}`);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function paged(pathPrefix, pageSize = 1000, maxPages = 20) {
    const rows = [];
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const separator = pathPrefix.includes("?") ? "&" : "?";
      const chunk = await rest(`${pathPrefix}${separator}limit=${pageSize}&offset=${offset}`);
      const data = Array.isArray(chunk) ? chunk : [];
      rows.push(...data);
      if (data.length < pageSize) {
        break;
      }
    }
    return rows;
  }

  const vercelConfig = JSON.parse(fs.readFileSync(path.resolve(root, "vercel.json"), "utf8"));
  const cronEntry = (vercelConfig.crons ?? []).find((item) => item.path === "/api/v1/jobs/delivery-sync");

  const providerTemplatesText = fs.readFileSync(path.resolve(root, "src/lib/delivery-intelligence/provider-templates.ts"), "utf8");
  const adaptersRegistryText = fs.readFileSync(path.resolve(root, "src/lib/delivery-intelligence/adapters/index.ts"), "utf8");
  const checkOrderRouteText = fs.readFileSync(path.resolve(root, "src/app/api/v1/check-order/route.ts"), "utf8");
  const privacyDtoText = fs.readFileSync(path.resolve(root, "src/lib/risk/merchant-facing-dto.ts"), "utf8");
  const scheduledRouteText = fs.readFileSync(path.resolve(root, "src/app/api/v1/jobs/delivery-sync/route.ts"), "utf8");
  const statsMigrationText = fs.readFileSync(path.resolve(workspaceRoot, "supabase/migrations/20260605_013_customer_network_profile_views.sql"), "utf8");

  const requiredProviders = ["yalidine", "zr_express", "noest", "ecotrans", "guepex"];
  const templatesCovered = requiredProviders.every((provider) => providerTemplatesText.includes(`${provider}:`));
  const adaptersCovered = ["yalidine", "zr_express", "noest", "guepex"].every((provider) => adaptersRegistryText.includes(`${provider}:`))
    && adaptersRegistryText.includes("ecotrans: ecotrackAdapter");

  const activeAccounts = await paged("/merchant_delivery_accounts?select=id,provider,merchant_id,active&active=eq.true", 1000, 50);
  const syncLogs12h = await paged(`/delivery_sync_logs?select=id,status,provider,created_at&created_at=gte.${encodeURIComponent(toIso(12))}&order=created_at.desc`, 1000, 30);
  const networkSyncReports12h = await paged(`/network_sync_reports?select=id,provider,completed_at,dry_run&dry_run=eq.false&completed_at=gte.${encodeURIComponent(toIso(12))}&order=completed_at.desc`, 1000, 30);

  const activeAccountsByProvider = {};
  for (const row of activeAccounts) {
    const provider = String(row.provider ?? "unknown");
    activeAccountsByProvider[provider] = Number(activeAccountsByProvider[provider] ?? 0) + 1;
  }

  const links = await paged("/identity_links?select=id,merge_reason,confidence_level,confidence_score,created_at&order=created_at.desc", 1000, 20);
  const linksMissingReason = links.filter((row) => !row.merge_reason).length;
  const linksMissingLevel = links.filter((row) => !row.confidence_level).length;

  let reputationRows = [];
  let reputationColumnsOk = true;
  try {
    reputationRows = await paged("/customer_reputation?select=identity_id,total_orders,merchant_count,provider_count,reputation_score&order=updated_at.desc", 1000, 20);
  } catch {
    reputationColumnsOk = false;
    reputationRows = await paged("/customer_reputation?select=identity_id,total_orders,merchant_count,reputation_score&order=updated_at.desc", 1000, 20);
  }

  const crossMerchantCount = reputationRows.filter((row) => Number(row.merchant_count ?? 0) >= 2).length;
  const crossProviderCount = reputationRows.filter((row) => Number(row.provider_count ?? 0) >= 2).length;

  const recentRiskEvents = await paged("/risk_events?select=id,created_at,payload&order=created_at.desc", 200, 2);
  const riskEventsWithNetworkProfile = recentRiskEvents.filter((event) => {
    const profile = event?.payload?.intelligence?.customerNetworkProfile;
    return profile && typeof profile.totalOrders === "number";
  }).length;

  const recentOrderChecks = await paged("/order_checks?select=id,created_at,risk_reasons,recommended_action,risk_level&order=created_at.desc", 200, 2);
  const blockedTokens = ["yalidine", "zr_express", "zr-express", "provider", "merchant", "store"]; 
  const leakedOrderChecks = recentOrderChecks
    .map((row) => ({ id: row.id, leaks: scanBlockedTokens({ risk_reasons: row.risk_reasons, recommended_action: row.recommended_action }, blockedTokens) }))
    .filter((row) => row.leaks.length > 0);

  const statsRows = await paged("/customer_delivery_stats?select=identity_id,merchant_count,provider_count,total_delivery_orders&order=total_delivery_orders.desc", 1000, 20);
  const maxMerchantCount = statsRows.reduce((max, row) => Math.max(max, Number(row.merchant_count ?? 0)), 0);
  const maxProviderCount = statsRows.reduce((max, row) => Math.max(max, Number(row.provider_count ?? 0)), 0);

  const cronSupportsGet = scheduledRouteText.includes("export async function GET");
  const cronSupportsVercelSecret = scheduledRouteText.includes("process.env.CRON_SECRET");
  const cronSupportsLegacySecret = scheduledRouteText.includes("process.env.DELIVERY_SYNC_CRON_SECRET");

  const phase1Pass = Boolean(
    cronEntry?.schedule === "0 */6 * * *"
    && templatesCovered
    && adaptersCovered
    && cronSupportsGet
    && cronSupportsVercelSecret
    && cronSupportsLegacySecret
    && syncLogs12h.length > 0
    && networkSyncReports12h.length > 0
  );
  const phase2Pass = links.length > 0 && linksMissingReason === 0 && linksMissingLevel === 0;
  const phase3Pass = reputationColumnsOk && crossMerchantCount > 0;
  const phase4Pass = checkOrderRouteText.includes("localHistory") && checkOrderRouteText.includes("customerType") && riskEventsWithNetworkProfile > 0;
  const phase5Pass = privacyDtoText.includes("BLOCKED_PROVIDER_TOKENS") && leakedOrderChecks.length === 0;
  const phase6Pass = statsMigrationText.includes("merchant_count") && statsMigrationText.includes("provider_count") && statsRows.length > 0;
  const phase7Pass = activeAccounts.length > 0 && recentOrderChecks.length > 0 && links.length > 0;

  const phases = [
    { phase: 1, name: "Full Sync Automation", pass: phase1Pass, evidence: `cron=${cronEntry?.schedule ?? "none"}, templates=${yesNo(templatesCovered)}, adapters=${yesNo(adaptersCovered)}, routeGET=${yesNo(cronSupportsGet)}, cronSecret=${yesNo(cronSupportsVercelSecret)}, deliverySyncSecret=${yesNo(cronSupportsLegacySecret)}, syncLogs12h=${syncLogs12h.length}, networkSyncReports12h=${networkSyncReports12h.length}` },
    { phase: 2, name: "Identity Engine Integrity", pass: phase2Pass, evidence: `links=${links.length}, missingReason=${linksMissingReason}, missingLevel=${linksMissingLevel}` },
    { phase: 3, name: "Network Reputation Integrity", pass: phase3Pass, evidence: `crossMerchant=${crossMerchantCount}, crossProvider=${crossProviderCount}, providerCountColumn=${yesNo(reputationColumnsOk)}` },
    { phase: 4, name: "Returning Customer Intelligence", pass: phase4Pass, evidence: `routeLocalHistory=${yesNo(checkOrderRouteText.includes("localHistory"))}, riskEventsWithProfile=${riskEventsWithNetworkProfile}` },
    { phase: 5, name: "Privacy Enforcement", pass: phase5Pass, evidence: `orderCheckLeaks=${leakedOrderChecks.length}` },
    { phase: 6, name: "Continuous Growth Metrics", pass: phase6Pass, evidence: `statsRows=${statsRows.length}, maxMerchantCount=${maxMerchantCount}, maxProviderCount=${maxProviderCount}` },
    { phase: 7, name: "Production Read-Only Audit", pass: phase7Pass, evidence: `activeAccounts=${activeAccounts.length}, recentChecks=${recentOrderChecks.length}, identityLinks=${links.length}` }
  ];

  const phase8Pass = phases.every((item) => item.pass);

  console.log("\n=== DZ FRAUD SHIELD AUTOMATION AUDIT (READ-ONLY) ===\n");
  for (const item of phases) {
    console.log(`Phase ${item.phase} - ${item.name}: ${item.pass ? "PASS" : "FAIL"}`);
    console.log(`  Evidence: ${item.evidence}`);
  }

  console.log(`Phase 8 - Production Readiness: ${phase8Pass ? "PASS" : "FAIL"}`);
  console.log(`  Evidence: phasesPassed=${phases.filter((item) => item.pass).length}/${phases.length}`);

  console.log("\n--- Supporting Metrics ---");
  console.log(`Active accounts: ${activeAccounts.length}`);
  console.log(`Active accounts by provider: ${JSON.stringify(activeAccountsByProvider)}`);
  console.log(`Sync logs in last 12h: ${syncLogs12h.length}`);
  console.log(`Scheduled network reports in last 12h: ${networkSyncReports12h.length}`);
  console.log(`Recent risk events sampled: ${recentRiskEvents.length}`);
  console.log(`Recent order checks sampled: ${recentOrderChecks.length}`);
  if (leakedOrderChecks.length > 0) {
    console.log(`Privacy leaks detected in sampled order_checks: ${JSON.stringify(leakedOrderChecks.slice(0, 10))}`);
  }

  console.log("\n--- JSON Summary ---");
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    phases: [...phases, { phase: 8, name: "Production Readiness", pass: phase8Pass, evidence: `phasesPassed=${phases.filter((item) => item.pass).length}/${phases.length}` }],
    metrics: {
      activeAccounts: activeAccounts.length,
      activeAccountsByProvider,
      syncLogs12h: syncLogs12h.length,
      networkSyncReports12h: networkSyncReports12h.length,
      identityLinks: links.length,
      riskEventsWithNetworkProfile,
      maxMerchantCount,
      maxProviderCount,
      leakedOrderChecks: leakedOrderChecks.length
    }
  }, null, 2));
}

main().catch((error) => {
  console.error("Audit failed:", error);
  process.exit(1);
});
