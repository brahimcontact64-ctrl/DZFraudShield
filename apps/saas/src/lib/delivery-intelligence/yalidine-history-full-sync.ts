/**
 * yalidine-history-full-sync.ts
 *
 * Full Historical Sync Engine for the Merchant Delivery Intelligence (MDI) pipeline.
 *
 * Runs ONCE per merchant as the bootstrap step before the incremental sync begins.
 * Imports the complete Yalidine shipment history through two sequential phases:
 *
 *   Phase A — Parcels:
 *     Paginates GET /v1/parcels/ to fetch all parcel snapshots. For each parcel:
 *     writes the snapshot, resolves customer identity, enqueues reputation recompute.
 *
 *   Phase B — Histories:
 *     Paginates GET /v1/histories/ to fetch all history events for all parcels.
 *     Groups events by tracking on each page, then writes via upsertShipmentEvents.
 *
 * ── Cursor / checkpoint design ─────────────────────────────────────────────────
 *
 *   Two independent cursors in merchant_history_sync_status:
 *     full_parcels_cursor    — URL of the NEXT parcels page to fetch (null = start or done)
 *     full_histories_cursor  — URL of the NEXT histories page to fetch (null = start or done)
 *
 *   Each cursor is advanced AFTER the page's writes have committed:
 *
 *     1. Fetch page from Yalidine API.
 *     2. Write all items (idempotent: ON CONFLICT UPDATE / DO NOTHING).
 *     3. Compute next page URL from response.
 *     4. UPDATE merchant_history_sync_status: cursor = nextUrl, heartbeat = now().
 *     5. Goto 1 with nextUrl.
 *
 *   Crash between step 2 and 4:
 *     Cursor still points to the CURRENT page. Next run re-fetches the same page
 *     and re-writes the same data — idempotent, no duplicates.
 *
 *   Crash between step 4 and the next step 1:
 *     Cursor correctly points to the NEXT page. Next run starts from there.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────────
 *
 *   - upsertParcelSnapshot:  ON CONFLICT (merchant_id, provider, tracking) UPDATE
 *   - upsertShipmentEvents:  ON CONFLICT DO NOTHING
 *   - enqueueReputationRecompute: deduplication gate
 *
 *   Running the full sync twice produces exactly the same final database state.
 *
 * ── Phase sequencing ───────────────────────────────────────────────────────────
 *
 *   Phase A and Phase B are independent. Phase B does not require Phase A to
 *   complete first (events are matched to their parcel rows by tracking, which is
 *   a unique constraint, not by foreign key). However, identity resolution in
 *   Phase A may produce better results once the full parcel set is available, so
 *   the normal order is A → B.
 *
 *   If Phase A is already completed (full_parcels_status = 'completed'), it is
 *   skipped entirely. Same for Phase B. This makes resume trivial.
 *
 * ── On completion ──────────────────────────────────────────────────────────────
 *
 *   Phase A sets:
 *     full_parcels_status = 'completed'
 *     full_parcels_completed_at = now()
 *     last_parcels_synced_at = now()   ← enables incremental sync to start
 *     full_parcels_cursor = null       ← cleared (no more pages)
 *
 *   Phase B sets:
 *     full_histories_status = 'completed'
 *     full_histories_completed_at = now()
 *     last_histories_synced_at = now()
 *     full_histories_cursor = null
 *
 * ── Rate limiting ──────────────────────────────────────────────────────────────
 *
 *   Reuses YalidineRateLimiter from delivery-sync-engine.ts. Per-account registry
 *   within this module prevents duplicate instance creation. Same contract as the
 *   incremental and targeted sync engines.
 *
 * ── Failure handling ───────────────────────────────────────────────────────────
 *
 *   Auth errors (401/403): propagate as-is from fetchYalidine. Background job
 *   fails after 3 attempts (the handler exhausts retries; credentials must be fixed).
 *
 *   Network/server errors: propagate from fetchYalidine, which already performs
 *   up to 3 retries with backoff. The background job handler retries the full job.
 *
 *   Identity/reputation errors (Phase 3+4 of Phase A): non-fatal. Parcel snapshot
 *   and history events are preserved. Identity resolution is retried on the next
 *   incremental sync.
 *
 *   On any unhandled error: last_error is written, cursor is NOT advanced (safe
 *   retry point), and the exception propagates.
 */

import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import {
  YalidineRateLimiter,
  buildHeaders,
  fetchYalidine,
  firstStr,
  firstNum,
  resolveCollection,
} from "@/lib/delivery-intelligence/delivery-sync-engine";
import { YALIDINE_DEFAULT_BASE_URL } from "@/lib/delivery-intelligence/provider-templates";
import {
  normalizeParcelToSnapshot,
  normalizeHistoriesToEvents,
} from "@/lib/delivery-intelligence/yalidine-history-adapter";
import {
  upsertParcelSnapshot,
  upsertShipmentEvents,
  resolveShipmentIdentity,
  enqueueReputationRecompute,
} from "@/lib/delivery-intelligence/merchant-history-writer";
import { mdiLog } from "@/lib/delivery-intelligence/mdi-logger";
import { incrementMdiCounter, recordMdiExecutionTime } from "@/lib/delivery-intelligence/mdi-metrics";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER = "yalidine";

// Log progress every N pages. The heartbeat is written on every page via
// savePhaseACheckpoint / savePhaseBCheckpoint — N only controls console.info.
const HEARTBEAT_EVERY_N_PAGES = 10;

// ── Rate-limiter registry ─────────────────────────────────────────────────────

const _rateLimiterRegistry = new Map<string, YalidineRateLimiter>();

function getAccountRateLimiter(accountId: string): YalidineRateLimiter {
  const existing = _rateLimiterRegistry.get(accountId);
  if (existing) return existing;
  const limiter = new YalidineRateLimiter(() => false);
  _rateLimiterRegistry.set(accountId, limiter);
  return limiter;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

type HistorySyncStatusRow = {
  full_parcels_status:   string | null;
  full_parcels_cursor:   string | null;
  full_parcels_total:    number | null;
  full_histories_status: string | null;
  full_histories_cursor: string | null;
  full_histories_total:  number | null;
};

export type FullSyncMetrics = {
  durationMs:             number;
  phaseASkipped:          boolean;
  phaseBSkipped:          boolean;
  phaseACompleted:        boolean;
  phaseBCompleted:        boolean;
  phaseAPagesProcessed:   number;
  phaseBPagesProcessed:   number;
  parcelsProcessed:       number;
  historyEventsProcessed: number;
  identitiesResolved:     number;
  reputationJobsQueued:   number;
};

// ── Pagination helpers ────────────────────────────────────────────────────────

function resolveAbsoluteUrl(baseUrl: string, link: string): string {
  if (link.startsWith("http://") || link.startsWith("https://")) return link;
  const base = baseUrl.replace(/\/$/, "");
  return link.startsWith("/") ? `${base}${link}` : `${base}/${link}`;
}

function parsePageFromUrl(url: string): number {
  try {
    const parsed = new URL(url);
    const page   = parseInt(parsed.searchParams.get("page") ?? "", 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

/**
 * Extracts items and the next-page URL from a Yalidine paginated response.
 * Returns nextUrl = null when the page is the last one.
 */
function extractPageResult(
  payload:      RawRecord,
  baseUrl:      string,
  baseEndpoint: string,
  currentPage:  number,
): { items: RawRecord[]; nextUrl: string | null } {
  const items = resolveCollection(payload);

  // Option 1: explicit next-page link in response body.
  const nextLink = firstStr(payload, ["links.next", "pagination.next", "next", "next_page_url"]);
  if (nextLink) {
    return { items, nextUrl: resolveAbsoluteUrl(baseUrl, nextLink) };
  }

  // Option 2: has_more flag → compute page+1 URL.
  const paginationObj = (
    payload.pagination && typeof payload.pagination === "object"
      ? payload.pagination as RawRecord
      : {}
  );
  const hasMore  = Boolean(payload.has_more ?? paginationObj.has_more);
  const pageSize = firstNum(payload, ["page_size", "pagination.page_size", "per_page"])
    ?? firstNum(paginationObj, ["page_size", "per_page"]);

  if (items.length > 0 && (hasMore || (pageSize !== null && items.length >= pageSize))) {
    const nextPage = currentPage + 1;
    const base     = `${baseUrl.replace(/\/$/, "")}${baseEndpoint}`;
    const sep      = baseEndpoint.includes("?") ? "&" : "?";
    return { items, nextUrl: `${base}${sep}page=${nextPage}` };
  }

  return { items, nextUrl: null };
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

type CheckpointUpdate = {
  merchantId: string;
  provider:   string;
  supabase:   ReturnType<typeof createClient>;
};

async function savePhaseACheckpoint(
  ctx:     CheckpointUpdate,
  update:  {
    cursor:    string | null;
    total:     number;
    completed: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const patch: RawRecord = {
    full_parcels_cursor:  update.cursor,
    full_parcels_total:   update.total,
    last_heartbeat_at:    now,
    last_error:           null,
  };
  if (update.completed) {
    patch.full_parcels_status         = "completed";
    patch.full_parcels_completed_at   = now;
    patch.last_parcels_synced_at      = now;
  }
  await ctx.supabase
    .from("merchant_history_sync_status")
    .update(patch)
    .eq("merchant_id", ctx.merchantId)
    .eq("provider", ctx.provider);
}

async function savePhaseBCheckpoint(
  ctx:    CheckpointUpdate,
  update: {
    cursor:    string | null;
    total:     number;
    completed: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const patch: RawRecord = {
    full_histories_cursor: update.cursor,
    full_histories_total:  update.total,
    last_heartbeat_at:     now,
    last_error:            null,
  };
  if (update.completed) {
    patch.full_histories_status        = "completed";
    patch.full_histories_completed_at  = now;
    patch.last_histories_synced_at     = now;
  }
  await ctx.supabase
    .from("merchant_history_sync_status")
    .update(patch)
    .eq("merchant_id", ctx.merchantId)
    .eq("provider", ctx.provider);
}

async function writePhaseError(
  ctx:     CheckpointUpdate,
  phase:   "parcels" | "histories",
  message: string,
): Promise<void> {
  await ctx.supabase
    .from("merchant_history_sync_status")
    .update({
      [`full_${phase}_status`]: "failed",
      last_error:               message.slice(0, 1_000),
      last_heartbeat_at:        new Date().toISOString(),
    })
    .eq("merchant_id", ctx.merchantId)
    .eq("provider", ctx.provider);
}

// ── Phase A — parcels list ────────────────────────────────────────────────────

type PhaseAParams = {
  ctx:           CheckpointUpdate;
  baseUrl:       string;
  headers:       Record<string, string>;
  rateLimiter:   YalidineRateLimiter;
  statusRow:     HistorySyncStatusRow;
  merchantId:    string;
  provider:      string;
};

type PhaseAResult = {
  pagesProcessed:      number;
  parcelsProcessed:    number;
  identitiesResolved:  number;
  reputationJobsQueued: number;
};

async function runParcelsPhase(p: PhaseAParams): Promise<PhaseAResult> {
  const { ctx, baseUrl, headers, rateLimiter, statusRow, merchantId, provider } = p;

  // Mark running (preserves started_at if already set from a previous run).
  await ctx.supabase
    .from("merchant_history_sync_status")
    .update({
      full_parcels_status:      "running",
      full_parcels_started_at:  statusRow.full_parcels_status === "pending" || statusRow.full_parcels_status === null
        ? new Date().toISOString()
        : undefined,  // don't overwrite if resuming
      last_heartbeat_at:        new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("provider", provider);

  const BASE_ENDPOINT = "/v1/parcels/";

  // Resume from cursor or start at page 1.
  let currentUrl   = statusRow.full_parcels_cursor
    ? resolveAbsoluteUrl(baseUrl, statusRow.full_parcels_cursor)
    : `${baseUrl.replace(/\/$/, "")}${BASE_ENDPOINT}?page=1`;
  let currentPage  = statusRow.full_parcels_cursor
    ? parsePageFromUrl(statusRow.full_parcels_cursor)
    : 1;
  let totalWritten = statusRow.full_parcels_total ?? 0;  // preserve count across resumes

  const result: PhaseAResult = {
    pagesProcessed:       0,
    parcelsProcessed:     0,
    identitiesResolved:   0,
    reputationJobsQueued: 0,
  };

  const supabase = ctx.supabase;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Fetch one page ────────────────────────────────────────────────────────
    // eslint-disable-next-line no-await-in-loop
    const payload = await fetchYalidine(currentUrl, headers, rateLimiter, () => false);
    const { items, nextUrl } = extractPageResult(payload, baseUrl, BASE_ENDPOINT, currentPage);

    // ── Write items on this page ──────────────────────────────────────────────
    for (const rawParcel of items) {
      const tracking = firstStr(rawParcel, ["tracking", "id", "tracking_number"]);
      if (!tracking) continue;

      const snapshot = normalizeParcelToSnapshot(rawParcel, tracking);
      // eslint-disable-next-line no-await-in-loop
      await upsertParcelSnapshot({ supabase, merchantId, provider, snapshot });
      result.parcelsProcessed++;
      totalWritten++;

      // Phase 3+4: identity + reputation (non-fatal, same as targeted sync).
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
          result.identitiesResolved++;
          // eslint-disable-next-line no-await-in-loop
          const enqueued = await enqueueReputationRecompute({
            merchantId,
            identityId: identity.identityId,
          });
          if (enqueued.enqueued) result.reputationJobsQueued++;
        }
      } catch (identityErr) {
        mdiLog({
          level: "warn", component: "full-sync", event: "identity.error",
          merchantId, provider, tracking,
          errorCode: identityErr instanceof Error ? identityErr.message.slice(0, 200) : String(identityErr),
        });
      }
    }

    result.pagesProcessed++;

    // ── Save checkpoint AFTER writes commit ───────────────────────────────────
    // Cursor points to the NEXT page. On resume, this page is not re-fetched.
    // If the process crashes between the write loop and here, cursor still
    // points to the current page — same data is re-written (idempotent).
    // eslint-disable-next-line no-await-in-loop
    await savePhaseACheckpoint(ctx, {
      cursor:    nextUrl,
      total:     totalWritten,
      completed: !nextUrl,
    });

    if (!nextUrl) break;   // last page processed — Phase A done

    // Heartbeat is embedded in savePhaseACheckpoint (last_heartbeat_at = now).
    // No extra heartbeat update needed.

    currentUrl  = nextUrl;
    currentPage++;

    if (result.pagesProcessed % HEARTBEAT_EVERY_N_PAGES === 0) {
      mdiLog({
        level: "info", component: "full-sync", event: "phase_a.progress",
        merchantId, provider, page: currentPage,
        parcelsThisRun: result.parcelsProcessed, totalWritten,
      });
    }
  }

  return result;
}

// ── Phase B — histories bulk list ─────────────────────────────────────────────

type PhaseBParams = {
  ctx:         CheckpointUpdate;
  baseUrl:     string;
  headers:     Record<string, string>;
  rateLimiter: YalidineRateLimiter;
  statusRow:   HistorySyncStatusRow;
  merchantId:  string;
  provider:    string;
};

type PhaseBResult = {
  pagesProcessed:       number;
  historyEventsProcessed: number;
};

async function runHistoriesPhase(p: PhaseBParams): Promise<PhaseBResult> {
  const { ctx, baseUrl, headers, rateLimiter, statusRow, merchantId, provider } = p;

  await ctx.supabase
    .from("merchant_history_sync_status")
    .update({
      full_histories_status:      "running",
      full_histories_started_at:  statusRow.full_histories_status === "pending" || statusRow.full_histories_status === null
        ? new Date().toISOString()
        : undefined,
      last_heartbeat_at:          new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("provider", provider);

  const BASE_ENDPOINT = "/v1/histories/";

  let currentUrl   = statusRow.full_histories_cursor
    ? resolveAbsoluteUrl(baseUrl, statusRow.full_histories_cursor)
    : `${baseUrl.replace(/\/$/, "")}${BASE_ENDPOINT}?page=1`;
  let currentPage  = statusRow.full_histories_cursor
    ? parsePageFromUrl(statusRow.full_histories_cursor)
    : 1;
  let totalWritten = statusRow.full_histories_total ?? 0;

  const result: PhaseBResult = {
    pagesProcessed:         0,
    historyEventsProcessed: 0,
  };

  const supabase = ctx.supabase;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Fetch one page of history events ──────────────────────────────────────
    // eslint-disable-next-line no-await-in-loop
    const payload = await fetchYalidine(currentUrl, headers, rateLimiter, () => false);
    const { items, nextUrl } = extractPageResult(payload, baseUrl, BASE_ENDPOINT, currentPage);

    // ── Group events by tracking, then write per tracking ─────────────────────
    // The bulk histories endpoint returns events from all parcels on the same page.
    // normalizeHistoriesToEvents expects a single-tracking input (it sets the
    // tracking field on each event). We group first so we can call it correctly.
    const byTracking = new Map<string, RawRecord[]>();
    for (const event of items) {
      const tracking = firstStr(event, ["tracking", "tracking_number", "parcel_tracking"]);
      if (!tracking) continue;
      const existing = byTracking.get(tracking);
      if (existing) {
        existing.push(event);
      } else {
        byTracking.set(tracking, [event]);
      }
    }

    if (byTracking.size > 0) {
      // Collect all normalized events across all trackings on this page.
      const allNormalized = [];
      for (const [tracking, rawEvents] of byTracking) {
        const normalized = normalizeHistoriesToEvents(rawEvents, tracking).map((e) => ({
          ...e,
          source: "history_api_bulk" as const,
        }));
        allNormalized.push(...normalized);
      }

      if (allNormalized.length > 0) {
        // Single write for all events on this page (idempotent via ON CONFLICT DO NOTHING).
        // eslint-disable-next-line no-await-in-loop
        await upsertShipmentEvents({ supabase, merchantId, provider, events: allNormalized });
        result.historyEventsProcessed += allNormalized.length;
        totalWritten += allNormalized.length;
      }
    }

    result.pagesProcessed++;

    // ── Save checkpoint AFTER writes commit ───────────────────────────────────
    // eslint-disable-next-line no-await-in-loop
    await savePhaseBCheckpoint(ctx, {
      cursor:    nextUrl,
      total:     totalWritten,
      completed: !nextUrl,
    });

    if (!nextUrl) break;

    currentUrl  = nextUrl;
    currentPage++;

    if (result.pagesProcessed % HEARTBEAT_EVERY_N_PAGES === 0) {
      mdiLog({
        level: "info", component: "full-sync", event: "phase_b.progress",
        merchantId, provider, page: currentPage,
        eventsThisRun: result.historyEventsProcessed, totalWritten,
      });
    }
  }

  return result;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Runs the full historical sync for one merchant.
 *
 * Idempotent: safe to call multiple times. Already-completed phases are skipped.
 * Resumes from the last saved cursor on restart after interruption.
 *
 * Called by the background job handler for yalidine_history_full_sync jobs.
 *
 * Throws on:
 *   - Auth errors (401/403) from Yalidine — caller does not retry.
 *   - Network/server errors that exhaust fetchYalidine's internal retries.
 *
 * Does NOT throw on:
 *   - Identity resolution failures for individual parcels.
 *   - Reputation enqueue failures for individual parcels.
 */
export async function runFullSync(params: {
  merchantId: string;
  provider?:  string;
}): Promise<FullSyncMetrics> {
  const { merchantId } = params;
  const provider       = params.provider ?? PROVIDER;
  const startMs        = Date.now();

  const metrics: FullSyncMetrics = {
    durationMs:             0,
    phaseASkipped:          false,
    phaseBSkipped:          false,
    phaseACompleted:        false,
    phaseBCompleted:        false,
    phaseAPagesProcessed:   0,
    phaseBPagesProcessed:   0,
    parcelsProcessed:       0,
    historyEventsProcessed: 0,
    identitiesResolved:     0,
    reputationJobsQueued:   0,
  };

  const supabase = createClient();

  // ── Load account credentials ────────────────────────────────────────────────
  mdiLog({ level: "info", component: "full-sync", event: "sync.started", merchantId, provider });

  const accounts = await getSyncableDeliveryAccounts(merchantId);
  const account  = accounts.find((a) => a.provider === provider);
  if (!account) {
    mdiLog({ level: "warn", component: "full-sync", event: "sync.no_account", merchantId, provider, result: "skipped" });
    metrics.durationMs = Date.now() - startMs;
    return metrics;
  }

  const credentials = account.credentials as Record<string, string>;
  const baseUrl     = (account.base_url as string | null) ?? YALIDINE_DEFAULT_BASE_URL;
  const accountId   = account.id as string;
  const rateLimiter = getAccountRateLimiter(accountId);
  const headers     = buildHeaders(credentials);

  // ── Ensure sync status row exists ───────────────────────────────────────────
  // INSERT ... ON CONFLICT DO NOTHING so we never overwrite a row from a previous run.
  await supabase
    .from("merchant_history_sync_status")
    .upsert(
      { merchant_id: merchantId, provider },
      { onConflict: "merchant_id,provider", ignoreDuplicates: true },
    );

  const { data: rawStatus } = await supabase
    .from("merchant_history_sync_status")
    .select(
      "full_parcels_status, full_parcels_cursor, full_parcels_total," +
      "full_histories_status, full_histories_cursor, full_histories_total",
    )
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .maybeSingle();

  const statusRow = (rawStatus as HistorySyncStatusRow | null) ?? {
    full_parcels_status:   null,
    full_parcels_cursor:   null,
    full_parcels_total:    0,
    full_histories_status: null,
    full_histories_cursor: null,
    full_histories_total:  0,
  };

  const ctx: CheckpointUpdate = { merchantId, provider, supabase };

  // ── Phase A: parcels ────────────────────────────────────────────────────────
  if (statusRow.full_parcels_status === "completed") {
    mdiLog({ level: "info", component: "full-sync", event: "phase_a.skipped", merchantId, provider, result: "already_completed" });
    metrics.phaseASkipped = true;
    metrics.phaseACompleted = true;
  } else {
    mdiLog({ level: "info", component: "full-sync", event: "phase_a.started", merchantId, provider });
    try {
      const phaseA = await runParcelsPhase({
        ctx, baseUrl, headers, rateLimiter, statusRow, merchantId, provider,
      });
      metrics.phaseAPagesProcessed   = phaseA.pagesProcessed;
      metrics.parcelsProcessed       = phaseA.parcelsProcessed;
      metrics.identitiesResolved     = phaseA.identitiesResolved;
      metrics.reputationJobsQueued   = phaseA.reputationJobsQueued;
      metrics.phaseACompleted        = true;
      incrementMdiCounter("shipmentsProcessed", phaseA.parcelsProcessed);
      incrementMdiCounter("identitiesResolved", phaseA.identitiesResolved);
      incrementMdiCounter("reputationJobsCreated", phaseA.reputationJobsQueued);
      mdiLog({
        level: "info", component: "full-sync", event: "phase_a.completed",
        merchantId, provider, result: "ok",
        pages: phaseA.pagesProcessed, parcels: phaseA.parcelsProcessed,
        identities: phaseA.identitiesResolved, reputationJobs: phaseA.reputationJobsQueued,
      });
    } catch (err) {
      const phaseAErr = err instanceof Error ? err : new Error(String(err));
      await writePhaseError(ctx, "parcels", phaseAErr.message);
      mdiLog({ level: "error", component: "full-sync", event: "phase_a.failed", merchantId, provider, result: "error", errorCode: phaseAErr.message.slice(0, 200) });
      metrics.durationMs = Date.now() - startMs;
      throw phaseAErr;
    }
  }

  // ── Phase B: histories bulk ─────────────────────────────────────────────────
  if (statusRow.full_histories_status === "completed") {
    mdiLog({ level: "info", component: "full-sync", event: "phase_b.skipped", merchantId, provider, result: "already_completed" });
    metrics.phaseBSkipped = true;
    metrics.phaseBCompleted = true;
  } else {
    mdiLog({ level: "info", component: "full-sync", event: "phase_b.started", merchantId, provider });
    try {
      const phaseB = await runHistoriesPhase({
        ctx, baseUrl, headers, rateLimiter, statusRow, merchantId, provider,
      });
      metrics.phaseBPagesProcessed    = phaseB.pagesProcessed;
      metrics.historyEventsProcessed  = phaseB.historyEventsProcessed;
      metrics.phaseBCompleted         = true;
      incrementMdiCounter("eventsWritten", phaseB.historyEventsProcessed);
      mdiLog({
        level: "info", component: "full-sync", event: "phase_b.completed",
        merchantId, provider, result: "ok",
        pages: phaseB.pagesProcessed, events: phaseB.historyEventsProcessed,
      });
    } catch (err) {
      const phaseBErr = err instanceof Error ? err : new Error(String(err));
      await writePhaseError(ctx, "histories", phaseBErr.message);
      mdiLog({ level: "error", component: "full-sync", event: "phase_b.failed", merchantId, provider, result: "error", errorCode: phaseBErr.message.slice(0, 200) });
      metrics.durationMs = Date.now() - startMs;
      throw phaseBErr;
    }
  }

  metrics.durationMs = Date.now() - startMs;
  incrementMdiCounter("fullSyncRuns");
  recordMdiExecutionTime(metrics.durationMs);

  mdiLog({
    level: "info", component: "full-sync", event: "sync.completed",
    merchantId, provider, result: "ok", durationMs: metrics.durationMs,
    phaseASkipped: metrics.phaseASkipped, phaseBSkipped: metrics.phaseBSkipped,
    parcelsProcessed: metrics.parcelsProcessed,
    historyEventsProcessed: metrics.historyEventsProcessed,
    identitiesResolved: metrics.identitiesResolved,
    reputationJobsQueued: metrics.reputationJobsQueued,
  });

  return metrics;
}
