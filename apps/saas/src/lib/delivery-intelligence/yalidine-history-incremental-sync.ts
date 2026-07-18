/**
 * yalidine-history-incremental-sync.ts
 *
 * Incremental Synchronization Engine for the Merchant Delivery Intelligence
 * (MDI) pipeline. This is the ONLY scheduler responsible for keeping
 * merchant_shipment_history in sync after the initial full historical sync.
 * The system never needs another full re-sync unless an administrator
 * explicitly requests one.
 *
 * ── Scheduler lifecycle ────────────────────────────────────────────────────────
 *
 *   enqueueIncrementalSyncForAllMerchants()
 *     Called by a cron endpoint (recommended every 4–6 hours).
 *     For every active Yalidine account whose full historical sync is complete:
 *       - Verifies the checkpoint exists (last_parcels_synced_at IS NOT NULL).
 *       - Skips if a job is already pending/processing for this merchant.
 *       - Skips if the last sync ran less than MIN_SYNC_INTERVAL_MS ago.
 *       - Enqueues one yalidine_history_incremental_sync background job.
 *
 *   runIncrementalSync({ merchantId, provider })
 *     Called by the background job processor for each enqueued job.
 *     Delegates to runYalidineIncrementalSync, which is provider-agnostic
 *     at the scheduler level (calls MdiIncrementalAdapter only).
 *
 * ── Checkpoint lifecycle ───────────────────────────────────────────────────────
 *
 *   Source of truth: merchant_history_sync_status.last_parcels_synced_at
 *     (per merchant_id + provider).
 *
 *   At the start of each run:
 *     anchor = last_parcels_synced_at - OVERLAP_MS (24 h)
 *
 *   The 24-hour overlap ensures no gap due to clock drift, provider batch
 *   delays, or parcels updated while the previous sync was running.
 *
 *   On success:
 *     last_parcels_synced_at = syncStartedAt (the moment the run began)
 *     last_histories_synced_at = syncStartedAt
 *
 *   On failure:
 *     Checkpoint is NOT updated. The next retry re-fetches the same window.
 *     All writes are idempotent — re-processing is safe and produces the same
 *     final state.
 *
 * ── Idempotency guarantees ─────────────────────────────────────────────────────
 *
 *   Running incremental sync twice produces exactly the same final DB state:
 *   - upsertParcelSnapshot:     ON CONFLICT (merchant_id, provider, tracking) UPDATE
 *   - upsertShipmentEvents:     ON CONFLICT DO NOTHING
 *   - resolveShipmentIdentity:  UPDATE is always the same canonical identity
 *   - enqueueReputationRecompute: deduplication gate (pending/processing check)
 *
 * ── Interaction with other components ─────────────────────────────────────────
 *
 *   Webhook receiver → targeted sync:
 *     May write the same tables concurrently for individual parcels.
 *     Safe: same writer layer, same ON CONFLICT semantics. No coordination needed.
 *
 *   Targeted sync:
 *     May run during an incremental sync for the same parcel (webhook triggered).
 *     Safe: both paths are idempotent and converge to the same final state.
 *
 *   Reputation engine:
 *     enqueueReputationRecompute deduplicates by identity before enqueuing.
 *     Re-enqueuing for the same identity is silently skipped.
 *
 *   Full sync:
 *     Must complete before incremental sync runs. Guard: if
 *     last_parcels_synced_at IS NULL, the incremental sync skips with a warning.
 *
 * ── Failure recovery ───────────────────────────────────────────────────────────
 *
 *   YalidineAuthError (401/403):
 *     Fatal. Re-thrown immediately. Background job handler stops retries.
 *
 *   Network / server errors (5xx, timeout):
 *     Propagate from fetchParcelsSince or fetchHistoriesFor.
 *     Background job handler retries up to its MAX_ATTEMPTS limit with backoff.
 *     Checkpoint not updated — next retry re-fetches the same window.
 *
 *   History fetch failure for one tracking:
 *     Non-fatal: logged, parcel snapshot is still committed, identity/reputation
 *     is still attempted. The missing history events will be re-fetched on the
 *     next incremental sync when the parcel still appears in the window.
 *
 * ── Provider abstraction ───────────────────────────────────────────────────────
 *
 *   The scheduler (runYalidineIncrementalSync) calls only two methods on the
 *   provider adapter:
 *     adapter.fetchParcelsSince(...)
 *     adapter.fetchHistoriesFor(...)
 *
 *   No provider-specific logic appears in the scheduler body. Future providers
 *   implement MdiIncrementalAdapter and register in ADAPTERS.
 *
 * ── Rate limiting ──────────────────────────────────────────────────────────────
 *
 *   Reuses YalidineRateLimiter from delivery-sync-engine.ts (the existing
 *   rate limiter for this project). One instance per delivery account per
 *   process, shared across concurrent sync operations for the same account.
 *   Never creates a custom or secondary rate-limiting mechanism.
 */

import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import {
  YalidineRateLimiter,
  buildHeaders,
  fetchAllPages,
  firstStr,
} from "@/lib/delivery-intelligence/delivery-sync-engine";
import { YALIDINE_DEFAULT_BASE_URL } from "@/lib/delivery-intelligence/provider-templates";
import {
  fetchYalidineHistories,
  normalizeParcelToSnapshot,
  normalizeHistoriesToEvents,
  YalidineAuthError,
} from "@/lib/delivery-intelligence/yalidine-history-adapter";
import {
  upsertParcelSnapshot,
  upsertShipmentEvents,
  resolveShipmentIdentity,
  enqueueReputationRecompute,
  enqueueMarketingDeliveryEnrichIfTracking,
} from "@/lib/delivery-intelligence/merchant-history-writer";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";
import { incrementMdiCounter, recordMdiExecutionTime } from "@/lib/delivery-intelligence/mdi-metrics";
import { MDI_CONFIG } from "@/lib/delivery-intelligence/mdi-config";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER = "yalidine";

// Values read from MDI_CONFIG (env-overridable); defaults match previous hardcoded values.
const OVERLAP_MS          = MDI_CONFIG.OVERLAP_MS;
const MAX_PARCELS_PER_RUN = MDI_CONFIG.MAX_PARCELS_PER_RUN;
const MIN_SYNC_INTERVAL_MS = MDI_CONFIG.MIN_SYNC_INTERVAL_MS;

// ── Rate-limiter registry ─────────────────────────────────────────────────────
//
// One YalidineRateLimiter per delivery account (keyed by merchant_delivery_accounts.id).
// Shared across all incremental sync operations for the same account within the
// same process — avoids multiple instances independently exhausting quota.

const _rateLimiterRegistry = new Map<string, YalidineRateLimiter>();

function getAccountRateLimiter(accountId: string): YalidineRateLimiter {
  const existing = _rateLimiterRegistry.get(accountId);
  if (existing) return existing;
  const limiter = new YalidineRateLimiter(() => false);
  _rateLimiterRegistry.set(accountId, limiter);
  return limiter;
}

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Metrics returned by runIncrementalSync for every completed run.
 * Logged by the background job processor. Never exposed to the user.
 */
export type IncrementalSyncMetrics = {
  durationMs:           number;
  /** The anchor timestamp used for this sync (last checkpoint - 24 h). */
  anchor:               string | null;
  /** Total parcels returned by the provider for the anchor window. */
  shipmentsFetched:     number;
  /** Parcels processed through the writer layer (new or updated). */
  shipmentsUpdated:     number;
  /** Parcels skipped (no tracking number in the raw payload). */
  shipmentsSkipped:     number;
  /** Raw history event records fetched across all tracking numbers. */
  historyEventsFetched: number;
  /** History event records passed to upsertShipmentEvents (upper bound; duplicates silently ignored). */
  historyEventsWritten: number;
  /** Tracking numbers for which a customer identity was successfully resolved. */
  identitiesResolved:   number;
  /** Reputation recompute jobs newly enqueued (already-queued jobs deduplicated). */
  reputationJobsQueued: number;
  /** true when the checkpoint (last_parcels_synced_at) was updated after this run. */
  checkpointUpdated:    boolean;
  /** The new checkpoint value written on success, null on failure or skip. */
  newCheckpoint:        string | null;
};

/**
 * Result of enqueueIncrementalSyncForAllMerchants.
 */
export type EnqueueIncrementalResult = {
  merchantsFound: number;
  jobsEnqueued:   number;
  jobsSkipped:    number;
};

// ── Provider interface ────────────────────────────────────────────────────────

type RawParcel = Record<string, unknown>;

/**
 * Provider abstraction for the incremental sync scheduler.
 *
 * The scheduler calls only these two methods. No provider-specific logic
 * appears in the orchestrator body. Future providers (Guepex, ZR Express MDI
 * support, etc.) implement this interface and register themselves in ADAPTERS.
 *
 * Invariant: both methods must be idempotent — calling twice with the same
 * parameters must produce no additional side-effects on the caller's DB state.
 * This is achieved by the writer layer, not by the adapter.
 */
interface MdiIncrementalAdapter {
  /**
   * Returns all parcels whose last_status_date >= since.
   * The provider handles pagination internally; the caller receives a flat list.
   * May throw YalidineAuthError (fatal), network errors (retryable), or
   * YalidineRateLimitError (retryable with Retry-After).
   */
  fetchParcelsSince(params: {
    credentials: Record<string, string>;
    baseUrl:     string;
    since:       string;     // ISO-8601 anchor timestamp
    rateLimiter: YalidineRateLimiter;
  }): Promise<Array<{ tracking: string; rawParcel: RawParcel }>>;

  /**
   * Returns raw history events for one tracking number.
   * Returns [] if the tracking is not found (404).
   * May throw YalidineAuthError (fatal) or network errors (retryable).
   */
  fetchHistoriesFor(params: {
    tracking:    string;
    credentials: Record<string, string>;
    baseUrl:     string;
    rateLimiter: YalidineRateLimiter;
  }): Promise<RawParcel[]>;
}

// ── Yalidine adapter ──────────────────────────────────────────────────────────

const yalidineAdapter: MdiIncrementalAdapter = {
  async fetchParcelsSince({ credentials, baseUrl, since, rateLimiter }) {
    const headers = buildHeaders(credentials);

    // Yalidine does not support server-side date filtering on GET /v1/parcels/.
    // Fetch all pages and filter client-side by date_last_status >= anchor date.
    // The 24-hour overlap window in OVERLAP_MS ensures no gap at the boundary.
    const dateFilter = since.slice(0, 10); // YYYY-MM-DD cutoff for client-side filter
    const endpoint   = "/v1/parcels/";

    const rawItems = await fetchAllPages(baseUrl, endpoint, headers, rateLimiter, () => false);

    const results: Array<{ tracking: string; rawParcel: RawParcel }> = [];
    for (const item of rawItems) {
      const tracking = firstStr(item, ["tracking", "id", "tracking_number"]);
      if (!tracking) continue;

      // Client-side date filter: skip parcels not updated since the anchor.
      const dateLastStatus = firstStr(item, ["date_last_status", "last_state_update_at", "updated_at"]);
      if (dateLastStatus && dateLastStatus.slice(0, 10) < dateFilter) continue;

      results.push({ tracking, rawParcel: item });
    }
    return results;
  },

  async fetchHistoriesFor({ tracking, credentials, baseUrl, rateLimiter }) {
    return fetchYalidineHistories({
      baseUrl,
      tracking,
      tenantId:    credentials.tenantId ?? "",
      apiKey:      credentials.apiKey   ?? "",
      rateLimiter,
    });
  },
};

// Registry: maps provider code → adapter.
// Future providers register here; no other code needs to change.
const ADAPTERS: Partial<Record<string, MdiIncrementalAdapter>> = {
  yalidine: yalidineAdapter,
};

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Enqueues one yalidine_history_incremental_sync job per active merchant whose
 * full historical sync has completed.
 *
 * Called by a cron endpoint or admin trigger. Safe to call more frequently
 * than needed — the MIN_SYNC_INTERVAL guard and the pending-job gate prevent
 * redundant work.
 *
 * Deduplication gates (a job is skipped if ANY applies):
 *   1. No checkpoint (last_parcels_synced_at IS NULL) — full sync not complete.
 *   2. Last sync ran less than MIN_SYNC_INTERVAL_MS ago.
 *   3. A yalidine_history_incremental_sync job is already pending/processing
 *      for this merchant.
 */
export async function enqueueIncrementalSyncForAllMerchants(params?: {
  provider?: string;
}): Promise<EnqueueIncrementalResult> {
  const targetProvider = params?.provider ?? PROVIDER;
  const supabase = createClient();

  const accounts = await getSyncableDeliveryAccounts();
  const targetAccounts = accounts.filter((a) => a.provider === targetProvider);

  let jobsEnqueued = 0;
  let jobsSkipped  = 0;

  for (const account of targetAccounts) {
    const merchantId = account.merchant_id as string;

    // Gate 1: full sync must have completed (checkpoint must exist).
    // eslint-disable-next-line no-await-in-loop
    const { data: statusRow } = await supabase
      .from("merchant_history_sync_status")
      .select("last_parcels_synced_at")
      .eq("merchant_id", merchantId)
      .eq("provider", targetProvider)
      .maybeSingle();

    const lastSync = (statusRow as { last_parcels_synced_at: string | null } | null)
      ?.last_parcels_synced_at ?? null;

    if (!lastSync) {
      mdiLog({ level: "warn", component: "incremental-sync", event: "scheduler.skipped", merchantId, provider: targetProvider, result: "no_checkpoint" });
      jobsSkipped++;
      continue;
    }

    // Gate 2: minimum interval between syncs.
    const lastSyncMs = new Date(lastSync).getTime();
    if (Date.now() - lastSyncMs < MIN_SYNC_INTERVAL_MS) {
      mdiLog({ level: "info", component: "incremental-sync", event: "scheduler.skipped", merchantId, provider: targetProvider, result: "too_recent" });
      jobsSkipped++;
      continue;
    }

    // Gate 3: no duplicate jobs.
    // eslint-disable-next-line no-await-in-loop
    const { count } = await supabase
      .from("background_jobs")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("type", "yalidine_history_incremental_sync")
      .in("status", ["pending", "processing"]);

    if ((count ?? 0) > 0) {
      mdiLog({ level: "info", component: "incremental-sync", event: "scheduler.skipped", merchantId, provider: targetProvider, result: "job_already_queued" });
      jobsSkipped++;
      continue;
    }

    // All gates passed — enqueue.
    // eslint-disable-next-line no-await-in-loop
    await enqueueBackgroundJob({
      type:       "yalidine_history_incremental_sync",
      merchantId,
      payload:    { provider: targetProvider },
    });
    jobsEnqueued++;
    mdiLog({ level: "info", component: "incremental-sync", event: "scheduler.enqueued", merchantId, provider: targetProvider, result: "ok" });
  }

  mdiLog({
    level: "info", component: "incremental-sync", event: "scheduler.complete",
    provider: targetProvider, result: "ok",
    merchantsFound: targetAccounts.length, jobsEnqueued, jobsSkipped,
  });

  return { merchantsFound: targetAccounts.length, jobsEnqueued, jobsSkipped };
}

// ── Incremental sync orchestrator ─────────────────────────────────────────────

/**
 * Runs one incremental sync pass for a single merchant + provider.
 *
 * Fetches all parcels updated since the checkpoint anchor, processes them
 * through the shared writer layer, and updates the checkpoint on success.
 *
 * Called by the background job handler for each yalidine_history_incremental_sync job.
 *
 * Throws on:
 *   - YalidineAuthError: credentials invalid — caller should not retry.
 *   - Any unrecovered network/server error from fetchParcelsSince.
 *
 * Does NOT throw on:
 *   - History fetch failures for individual tracking numbers (logged, skipped).
 *   - Identity resolution failures (logged, skipped — next sync will retry).
 */
export async function runIncrementalSync(params: {
  merchantId: string;
  provider?:  string;
}): Promise<IncrementalSyncMetrics> {
  const { merchantId } = params;
  const provider       = params.provider ?? PROVIDER;
  const startMs        = Date.now();
  const syncStartedAt  = new Date().toISOString();

  const metrics: IncrementalSyncMetrics = {
    durationMs:           0,
    anchor:               null,
    shipmentsFetched:     0,
    shipmentsUpdated:     0,
    shipmentsSkipped:     0,
    historyEventsFetched: 0,
    historyEventsWritten: 0,
    identitiesResolved:   0,
    reputationJobsQueued: 0,
    checkpointUpdated:    false,
    newCheckpoint:        null,
  };

  mdiLog({ level: "info", component: "incremental-sync", event: "sync.started", merchantId, provider });

  // ── Resolve adapter ─────────────────────────────────────────────────────────
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    mdiLog({ level: "warn", component: "incremental-sync", event: "sync.no_adapter", merchantId, provider, result: "skipped" });
    metrics.durationMs = Date.now() - startMs;
    return metrics;
  }

  const supabase = createClient();

  // ── Load credentials ────────────────────────────────────────────────────────
  const accounts = await getSyncableDeliveryAccounts(merchantId);
  const account  = accounts.find((a) => a.provider === provider);
  if (!account) {
    mdiLog({ level: "warn", component: "incremental-sync", event: "sync.no_account", merchantId, provider, result: "skipped" });
    metrics.durationMs = Date.now() - startMs;
    return metrics;
  }

  const credentials = account.credentials as Record<string, string>;
  const baseUrl     = (account.base_url as string | null) ?? YALIDINE_DEFAULT_BASE_URL;
  const accountId   = account.id as string;
  const rateLimiter = getAccountRateLimiter(accountId);

  // ── Read checkpoint ─────────────────────────────────────────────────────────
  const { data: statusRow } = await supabase
    .from("merchant_history_sync_status")
    .select("last_parcels_synced_at, last_histories_synced_at")
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .maybeSingle();

  const checkpoint = (statusRow as {
    last_parcels_synced_at:   string | null;
    last_histories_synced_at: string | null;
  } | null);

  if (!checkpoint?.last_parcels_synced_at) {
    mdiLog({ level: "warn", component: "incremental-sync", event: "sync.no_checkpoint", merchantId, provider, result: "skipped" });
    metrics.durationMs = Date.now() - startMs;
    return metrics;
  }

  // ── Compute anchor ──────────────────────────────────────────────────────────
  const anchorMs = new Date(checkpoint.last_parcels_synced_at).getTime() - OVERLAP_MS;
  const anchor   = new Date(anchorMs).toISOString();
  metrics.anchor = anchor;

  mdiLog({ level: "info", component: "incremental-sync", event: "sync.anchor_set", merchantId, provider, anchor, previousCheckpoint: checkpoint.last_parcels_synced_at });

  // ── Fetch changed parcels (provider-agnostic call) ──────────────────────────
  // May throw YalidineAuthError (fatal) or network errors (retryable).
  // Checkpoint is NOT updated until after the full run succeeds.
  const changedParcels = await adapter.fetchParcelsSince({
    credentials,
    baseUrl,
    since: anchor,
    rateLimiter,
  });

  metrics.shipmentsFetched = changedParcels.length;

  if (changedParcels.length > MAX_PARCELS_PER_RUN) {
    mdiLog({
      level: "warn", component: "incremental-sync", event: "sync.truncated",
      merchantId, provider, fetched: changedParcels.length, cap: MAX_PARCELS_PER_RUN,
      result: "partial",
    });
  }

  const batch = changedParcels.slice(0, MAX_PARCELS_PER_RUN);

  // ── Process each parcel ─────────────────────────────────────────────────────
  for (const { tracking, rawParcel } of batch) {
    if (!tracking) {
      metrics.shipmentsSkipped++;
      continue;
    }

    // ── Phase 1: Parcel snapshot ──────────────────────────────────────────────
    const snapshot = normalizeParcelToSnapshot(rawParcel, tracking);
    // eslint-disable-next-line no-await-in-loop
    await upsertParcelSnapshot({ supabase, merchantId, provider, snapshot });
    metrics.shipmentsUpdated++;

    // ── Phase 2: History events ───────────────────────────────────────────────
    // History fetch failures are non-fatal for individual tracking numbers.
    // The snapshot is committed regardless. Missing events will be re-fetched
    // on the next run when the parcel still appears in the anchor window.
    let rawHistories: RawParcel[] = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      rawHistories = await adapter.fetchHistoriesFor({
        tracking,
        credentials,
        baseUrl,
        rateLimiter,
      });
    } catch (histErr) {
      if (histErr instanceof YalidineAuthError) throw histErr;
      mdiLog({
        level: "warn", component: "incremental-sync", event: "history_fetch.failed",
        merchantId, provider, tracking,
        errorCode: histErr instanceof Error ? histErr.message.slice(0, 200) : String(histErr),
      });
    }

    if (rawHistories.length > 0) {
      metrics.historyEventsFetched += rawHistories.length;

      // Source is history_api_bulk for incremental (not targeted) sync.
      const events = normalizeHistoriesToEvents(rawHistories, tracking).map((e) => ({
        ...e,
        source: "history_api_bulk" as const,
      }));

      if (events.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await upsertShipmentEvents({ supabase, merchantId, provider, events });
        metrics.historyEventsWritten += events.length;
      }
    }

    // ── Phase 3 + 4: Identity resolution and reputation (non-fatal) ──────────
    try {
      const orderId     = firstStr(rawParcel, ["order_id", "reference", "id"]);
      const phoneMasked = firstStr(rawParcel, ["customer_phone", "phone", "mobile", "to_mobile"]);
      const wilayaName  = firstStr(rawParcel, ["to_wilaya_name", "wilaya_name"]);
      const communeName = firstStr(rawParcel, ["to_commune_name", "commune_name"]);

      // eslint-disable-next-line no-await-in-loop
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
        metrics.identitiesResolved++;
        // eslint-disable-next-line no-await-in-loop
        const enqueued = await enqueueReputationRecompute({
          merchantId,
          identityId: identity.identityId,
        });
        if (enqueued.enqueued) metrics.reputationJobsQueued++;
      }
      // Non-fatal companion: enrich marketing order lines with delivery outcome
      // eslint-disable-next-line no-await-in-loop
      await enqueueMarketingDeliveryEnrichIfTracking(merchantId, tracking);
    } catch (identityErr) {
      mdiLog({
        level: "warn", component: "incremental-sync", event: "identity.error",
        merchantId, provider, tracking,
        errorCode: identityErr instanceof Error ? identityErr.message.slice(0, 200) : String(identityErr),
      });
    }
  }

  // ── Update checkpoint — only after full successful run ──────────────────────
  // Setting both anchors to syncStartedAt (not syncEndedAt) ensures the next
  // run's anchor = syncStartedAt - 24h, which covers any parcels updated
  // between the moment this run started and the moment it ended.
  await supabase
    .from("merchant_history_sync_status")
    .update({
      last_parcels_synced_at:   syncStartedAt,
      last_histories_synced_at: syncStartedAt,
      last_heartbeat_at:        new Date().toISOString(),
      last_error:               null,
    })
    .eq("merchant_id", merchantId)
    .eq("provider", provider);

  metrics.checkpointUpdated = true;
  metrics.newCheckpoint     = syncStartedAt;
  metrics.durationMs        = Date.now() - startMs;

  incrementMdiCounter("incrementalSyncRuns");
  incrementMdiCounter("shipmentsUpdated", metrics.shipmentsUpdated);
  incrementMdiCounter("eventsWritten",    metrics.historyEventsWritten);
  incrementMdiCounter("identitiesResolved", metrics.identitiesResolved);
  incrementMdiCounter("reputationJobsCreated", metrics.reputationJobsQueued);
  recordMdiExecutionTime(metrics.durationMs);

  mdiLog({
    level: "info", component: "incremental-sync", event: "sync.completed",
    merchantId, provider, result: "ok", durationMs: metrics.durationMs,
    anchor: metrics.anchor, shipmentsFetched: metrics.shipmentsFetched,
    shipmentsUpdated: metrics.shipmentsUpdated, eventsWritten: metrics.historyEventsWritten,
    identitiesResolved: metrics.identitiesResolved,
    reputationJobsQueued: metrics.reputationJobsQueued,
    newCheckpoint: metrics.newCheckpoint,
  });

  return metrics;
}
