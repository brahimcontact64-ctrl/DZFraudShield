/**
 * provider-health.ts
 *
 * Aggregates health data for all delivery providers from existing database tables.
 * Pure read-only: no mutations, no side effects.
 *
 * Called by:
 *   - GET /api/v1/admin/delivery-intelligence/health  (external consumers)
 *   - Admin Delivery Intelligence page                 (server-side render)
 */

import { createClient } from "@/lib/supabase/server";

const STALE_HEARTBEAT_MS = 5 * 60_000;
const FAILED_STREAK_THRESHOLD = 3;

export type AccountHealth = {
  total:        number;
  active:       number;
  connected:    number;
  disconnected: number;
  failing:      number;
};

export type JobHealth = {
  pending:       number;
  processing:    number;
  failedLast24h: number;
};

export type SyncHealth = {
  merchantsSynced: number;
  runningSyncs:    number;
  staleSyncs:      number;
  lastHeartbeatAt: string | null;
  lastError:       string | null;
};

export type ProviderOverallHealth = "healthy" | "degraded" | "down" | "unknown";

export type ProviderHealth = {
  provider:      string;
  accounts:      AccountHealth;
  jobs:          JobHealth;
  sync:          SyncHealth;
  overallHealth: ProviderOverallHealth;
};

export type HealthSummary = {
  providers:   ProviderHealth[];
  totals: {
    pendingJobs:       number;
    processingJobs:    number;
    failedJobsLast24h: number;
    activeAccounts:    number;
  };
  generatedAt: string;
};

type AccountRow = {
  provider:           string;
  active:             boolean | null;
  connection_status:  string | null;
  failure_streak:     number | null;
};

type SyncStatusRow = {
  provider:          string;
  full_parcels_status:   string | null;
  full_histories_status: string | null;
  last_heartbeat_at:     string | null;
  last_error:            string | null;
};

type JobRow = {
  type:       string;
  status:     string;
  updated_at: string;
};

// Known providers with an MDI-specific job family.
const MDI_JOB_PREFIXES: Record<string, string[]> = {
  yalidine: ["yalidine_history_", "yalidine_bootstrap_sync"],
};

function deriveProvider(jobType: string): string | null {
  for (const [provider, prefixes] of Object.entries(MDI_JOB_PREFIXES)) {
    if (prefixes.some((p) => jobType.startsWith(p))) return provider;
  }
  return null;
}

function computeOverallHealth(
  accounts: AccountHealth,
  jobs:     JobHealth,
  sync:     SyncHealth,
): ProviderOverallHealth {
  if (accounts.total === 0) return "unknown";
  if (accounts.active === 0 || accounts.connected === 0) return "down";
  if (accounts.failing > 0) return "degraded";
  if (jobs.failedLast24h > 0) return "degraded";
  if (sync.staleSyncs > 0) return "degraded";
  return "healthy";
}

export async function fetchProviderHealthSummary(): Promise<HealthSummary> {
  const supabase = createClient();
  const cutoff24h = new Date(Date.now() - 86_400_000).toISOString();

  const [
    { data: accountData },
    { data: syncData },
    { data: jobData },
  ] = await Promise.all([
    supabase
      .from("merchant_delivery_accounts")
      .select("provider, active, connection_status, failure_streak"),
    supabase
      .from("merchant_history_sync_status")
      .select("provider, full_parcels_status, full_histories_status, last_heartbeat_at, last_error"),
    supabase
      .from("background_jobs")
      .select("type, status, updated_at")
      .or(`status.eq.pending,status.eq.processing,and(status.eq.failed,updated_at.gte.${cutoff24h})`),
  ]);

  const accounts   = (accountData ?? []) as AccountRow[];
  const syncs      = (syncData ?? []) as SyncStatusRow[];
  const jobs       = (jobData ?? []) as JobRow[];

  // ── Aggregate by provider ─────────────────────────────────────────────────
  const providerSet = new Set<string>([
    ...accounts.map((a) => a.provider),
    ...syncs.map((s) => s.provider),
  ]);

  const now = Date.now();

  const providers: ProviderHealth[] = Array.from(providerSet).map((provider) => {
    const pAccounts = accounts.filter((a) => a.provider === provider);
    const pSyncs    = syncs.filter((s) => s.provider === provider);

    // ── Account health ────────────────────────────────────────────────────
    const acctHealth: AccountHealth = {
      total:        pAccounts.length,
      active:       pAccounts.filter((a) => a.active).length,
      connected:    pAccounts.filter((a) => a.connection_status === "connected").length,
      disconnected: pAccounts.filter((a) => a.connection_status !== "connected").length,
      failing:      pAccounts.filter(
        (a) => (a.failure_streak ?? 0) >= FAILED_STREAK_THRESHOLD
      ).length,
    };

    // ── Job health (provider-specific job types only) ─────────────────────
    const prefixes = MDI_JOB_PREFIXES[provider] ?? [];
    const pJobs = prefixes.length > 0
      ? jobs.filter((j) => deriveProvider(j.type) === provider)
      : [];

    const jobHealth: JobHealth = {
      pending:       pJobs.filter((j) => j.status === "pending").length,
      processing:    pJobs.filter((j) => j.status === "processing").length,
      failedLast24h: pJobs.filter(
        (j) => j.status === "failed" && new Date(j.updated_at).getTime() >= now - 86_400_000
      ).length,
    };

    // ── Sync health ───────────────────────────────────────────────────────
    const runningSyncs = pSyncs.filter(
      (s) =>
        s.full_parcels_status === "running" ||
        s.full_histories_status === "running",
    );

    const staleSyncs = runningSyncs.filter((s) => {
      if (!s.last_heartbeat_at) return true;
      return now - new Date(s.last_heartbeat_at).getTime() > STALE_HEARTBEAT_MS;
    });

    const mostRecentHb = pSyncs
      .map((s) => s.last_heartbeat_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

    const lastErr = pSyncs
      .filter((s) => s.last_error)
      .sort((a, b) =>
        (b.last_heartbeat_at ?? "").localeCompare(a.last_heartbeat_at ?? ""),
      )
      .at(0)?.last_error ?? null;

    const syncHealth: SyncHealth = {
      merchantsSynced: pSyncs.length,
      runningSyncs:    runningSyncs.length,
      staleSyncs:      staleSyncs.length,
      lastHeartbeatAt: mostRecentHb,
      lastError:       lastErr,
    };

    return {
      provider,
      accounts:      acctHealth,
      jobs:          jobHealth,
      sync:          syncHealth,
      overallHealth: computeOverallHealth(acctHealth, jobHealth, syncHealth),
    };
  });

  // Sort: unhealthy providers first, then alphabetically.
  const healthOrder: Record<ProviderOverallHealth, number> = {
    down: 0, degraded: 1, unknown: 2, healthy: 3,
  };
  providers.sort(
    (a, b) =>
      healthOrder[a.overallHealth] - healthOrder[b.overallHealth] ||
      a.provider.localeCompare(b.provider),
  );

  // ── Global totals ─────────────────────────────────────────────────────────
  const totals = {
    pendingJobs:       jobs.filter((j) => j.status === "pending").length,
    processingJobs:    jobs.filter((j) => j.status === "processing").length,
    failedJobsLast24h: jobs.filter(
      (j) => j.status === "failed" && new Date(j.updated_at).getTime() >= now - 86_400_000,
    ).length,
    activeAccounts: accounts.filter((a) => a.active).length,
  };

  return { providers, totals, generatedAt: new Date().toISOString() };
}
