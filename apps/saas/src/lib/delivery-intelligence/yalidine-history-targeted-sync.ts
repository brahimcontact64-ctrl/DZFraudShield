import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { YalidineRateLimiter } from "@/lib/delivery-intelligence/delivery-sync-engine";
import { YALIDINE_DEFAULT_BASE_URL } from "@/lib/delivery-intelligence/provider-templates";
import {
  upsertParcelSnapshot,
  upsertShipmentEvents,
  resolveShipmentIdentity,
  enqueueReputationRecompute,
  enqueueMarketingDeliveryEnrichIfTracking,
} from "@/lib/delivery-intelligence/merchant-history-writer";
import {
  fetchYalidineParcel,
  fetchYalidineHistories,
  normalizeParcelToSnapshot,
  normalizeHistoriesToEvents,
} from "@/lib/delivery-intelligence/yalidine-history-adapter";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";
import { incrementMdiCounter, recordMdiExecutionTime } from "@/lib/delivery-intelligence/mdi-metrics";

// ── Shared rate-limiter registry ──────────────────────────────────────────────
//
// One YalidineRateLimiter per delivery account (keyed by merchant_delivery_accounts.id).
// Within a single worker process, all targeted sync jobs for the same account share
// this instance — they accumulate quota state from each other's responses and avoid
// collectively blasting the provider quota.
//
// Limitation: in a multi-process deployment each process maintains its own copy.
// This is the same constraint that the existing delivery sync engine accepts, and
// the per-request quota headers from Yalidine's API correct any drift quickly.

const rateLimiterRegistry = new Map<string, YalidineRateLimiter>();

function getAccountRateLimiter(accountId: string): YalidineRateLimiter {
  const existing = rateLimiterRegistry.get(accountId);
  if (existing) return existing;
  const limiter = new YalidineRateLimiter(() => false);
  rateLimiterRegistry.set(accountId, limiter);
  return limiter;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export type TargetedSyncMetrics = {
  durationMs: number;
  /** true if GET /v1/parcels/{tracking} returned a parcel (not 404) */
  parcelFetched: boolean;
  /** number of events returned by GET /v1/histories/{tracking} */
  historiesFetched: number;
  /** true if the parcel row was created (INSERT), false if updated */
  snapshotIsNew: boolean;
  /** number of events passed to upsertShipmentEvents (upper bound on rows inserted) */
  eventsAttempted: number;
  /** true if a customer identity was resolved for this tracking */
  identityResolved: boolean;
  /** true if a reputation recompute job was enqueued */
  reputationQueued: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractStr(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Fetches a single Yalidine parcel + its history, persists both through the
 * shared writer layer, resolves the customer identity, and enqueues a
 * reputation recompute if an identity was found.
 *
 * Idempotency: all four writer calls are idempotent — re-running this function
 * for the same tracking is safe and converges to the same final state.
 *
 * Failure boundaries:
 *   Phase 1 (parcel fetch + snapshot write) and Phase 2 (histories fetch +
 *   events write) are fully fatal: any error propagates up and the background
 *   job retries from scratch. Because both writes are idempotent, a retry
 *   safely re-runs Phase 1 before continuing to Phase 2.
 *
 *   Phase 3 (identity resolution + Phase 4 reputation enqueue) is non-fatal:
 *   errors are caught and logged. The snapshot and events committed in Phase 1
 *   and Phase 2 remain intact. The background job is still marked as completed.
 *   Identity resolution will be retried the next time a targeted or incremental
 *   sync runs for this tracking.
 *
 * Two-write pattern:
 *   The parcel snapshot is written first (Phase 1) with identity fields set to
 *   null. Identity is then resolved in Phase 3, which updates those fields on
 *   the same row. This second write is required by the writer architecture:
 *   resolveShipmentIdentity writes identity_id + phone_hash back via an UPDATE,
 *   which requires the row to already exist. Resolving identity before the
 *   snapshot INSERT would require merging the resolution result into the initial
 *   INSERT — that would change the writer's public contract.
 */
export async function runYalidineTargetedSync(params: {
  merchantId: string;
  tracking: string;
  provider: string;
}): Promise<TargetedSyncMetrics> {
  const startMs = Date.now();
  const { merchantId, tracking, provider } = params;

  const metrics: TargetedSyncMetrics = {
    durationMs: 0,
    parcelFetched: false,
    historiesFetched: 0,
    snapshotIsNew: false,
    eventsAttempted: 0,
    identityResolved: false,
    reputationQueued: false,
  };

  mdiLog({ level: "info", component: "targeted-sync", event: "sync.started", merchantId, provider, tracking });

  const supabase = createClient();

  const accounts = await getSyncableDeliveryAccounts(merchantId);
  const account = accounts.find((a) => a.provider === provider);
  if (!account) {
    mdiLog({ level: "warn", component: "targeted-sync", event: "sync.no_account", merchantId, provider, tracking, result: "skipped" });
    metrics.durationMs = Date.now() - startMs;
    return metrics;
  }

  const credentials = account.credentials as Record<string, string>;
  const tenantId = credentials.tenantId ?? "";
  const apiKey = credentials.apiKey ?? "";
  if (!tenantId || !apiKey) {
    mdiLog({ level: "warn", component: "targeted-sync", event: "sync.missing_credentials", merchantId, provider, tracking, result: "skipped" });
    metrics.durationMs = Date.now() - startMs;
    return metrics;
  }

  const baseUrl = (account.base_url as string | null) ?? YALIDINE_DEFAULT_BASE_URL;
  // One rate limiter per delivery account, shared across jobs in this process.
  const rateLimiter = getAccountRateLimiter(account.id as string);

  // ── Phase 1: Fetch and persist parcel snapshot ────────────────────────────
  const rawParcel = await fetchYalidineParcel({
    baseUrl,
    tracking,
    tenantId,
    apiKey,
    rateLimiter,
  });

  if (rawParcel) {
    metrics.parcelFetched = true;
    const snapshot = normalizeParcelToSnapshot(rawParcel, tracking);
    const result = await upsertParcelSnapshot({ supabase, merchantId, provider, snapshot });
    metrics.snapshotIsNew = result.isNew;
  }

  // ── Phase 2: Fetch and persist history events ─────────────────────────────
  // Runs regardless of Phase 1 outcome — events can exist for a tracking even
  // when the parcel snapshot returns 404 (e.g., archived parcels).
  const rawEvents = await fetchYalidineHistories({
    baseUrl,
    tracking,
    tenantId,
    apiKey,
    rateLimiter,
  });

  if (rawEvents.length > 0) {
    metrics.historiesFetched = rawEvents.length;
    const events = normalizeHistoriesToEvents(rawEvents, tracking);
    metrics.eventsAttempted = events.length;
    await upsertShipmentEvents({ supabase, merchantId, provider, events });
  }

  // ── Phase 3 + 4: Identity resolution and reputation enqueue (non-fatal) ───
  if (rawParcel) {
    try {
      const orderId = extractStr(rawParcel, ["order_id", "reference", "id"]);
      const phoneMasked = extractStr(rawParcel, [
        "customer_phone",
        "phone",
        "mobile",
        "to_mobile",
      ]);
      const wilayaName = extractStr(rawParcel, ["to_wilaya_name", "wilaya_name"]);
      const communeName = extractStr(rawParcel, ["to_commune_name", "commune_name"]);

      const identity = await resolveShipmentIdentity({
        supabase,
        merchantId,
        provider,
        tracking,
        orderId,
        phoneMasked,
        wilayaName,
        communeName,
      });

      if (identity.identityId) {
        metrics.identityResolved = true;
        const recompute = await enqueueReputationRecompute({
          merchantId,
          identityId: identity.identityId,
        });
        metrics.reputationQueued = recompute.enqueued;
      }
      // Non-fatal companion: enrich marketing order lines with delivery outcome
      await enqueueMarketingDeliveryEnrichIfTracking(merchantId, tracking);
    } catch (identityErr) {
      mdiLog({
        level: "warn", component: "targeted-sync", event: "identity.error",
        merchantId, provider, tracking,
        errorCode: identityErr instanceof Error ? identityErr.message.slice(0, 200) : String(identityErr),
      });
    }
  }

  metrics.durationMs = Date.now() - startMs;
  incrementMdiCounter("targetedSyncRuns");
  incrementMdiCounter("eventsWritten",      metrics.eventsAttempted);
  incrementMdiCounter("identitiesResolved", metrics.identityResolved ? 1 : 0);
  recordMdiExecutionTime(metrics.durationMs);

  mdiLog({
    level: "info", component: "targeted-sync", event: "sync.completed",
    merchantId, provider, tracking, result: "ok",
    durationMs:       metrics.durationMs,
    parcelFetched:    metrics.parcelFetched,
    historiesFetched: metrics.historiesFetched,
    snapshotIsNew:    metrics.snapshotIsNew,
    identityResolved: metrics.identityResolved,
    reputationQueued: metrics.reputationQueued,
  });

  return metrics;
}
