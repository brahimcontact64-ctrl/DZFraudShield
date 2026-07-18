/**
 * global-delivery-cache.ts
 *
 * Manages the single shared Yalidine delivery cache (geo + prices) stored in
 * Supabase global_delivery_* tables. Only the SaaS admin triggers writes.
 * Merchants and the checkout flow only ever read from these tables.
 *
 * Sync primitives (rate limiter, fetch, normalizers) are shared with the
 * merchant-delivery-sync.ts via delivery-sync-engine.ts.
 */

import { createClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/security/crypto";
import { normalizeYalidineCredentialsForStorage } from "@/lib/delivery-intelligence/credentials-guard";
import {
  YalidineRateLimiter,
  CancellationError,
  STALE_LOCK_MS as _STALE_LOCK_MS,
  HEARTBEAT_INTERVAL_MS,
  TOTAL_WILAYAS,
  buildHeaders,
  tokenFingerprint,
  fetchYalidine as engineFetch,
  fetchAllPages as engineFetchAll,
  normalizeGeoWilayas,
  normalizeGeoCommunes,
  normalizeGeoOffices,
  normalizeFeesPayload,
  asObject,
  type FeeRow,
} from "@/lib/delivery-intelligence/delivery-sync-engine";

// ── Constants ──────────────────────────────────────────────────────────────────

const PROVIDER  = "yalidine";
const BASE_URL  = "https://api.yalidine.app";

// Re-export so the admin UI and API routes can import from here directly.
export const STALE_LOCK_MS = _STALE_LOCK_MS;

// In-process guard: prevents re-entrant syncGlobalDeliveryCache calls.
let _syncInProgress  = false;

// In-process cancellation flag. Set by requestCancellation(); reset at sync start.
let _cancelRequested = false;

function isCancelled(): boolean { return _cancelRequested; }

// Module-level rate limiter — bound to the module-level cancel flag.
const _rateLimiter = new YalidineRateLimiter(isCancelled);

// Bound wrappers that forward to the shared engine with module-level state.
function fetchYalidine(url: string, headers: Record<string, string>) {
  return engineFetch(url, headers, _rateLimiter, isCancelled);
}
function fetchAllPages(baseUrl: string, endpoint: string, headers: Record<string, string>) {
  return engineFetchAll(baseUrl, endpoint, headers, _rateLimiter, isCancelled);
}

/** Call from the stop-sync route to immediately signal the running sync to stop. */
export function requestCancellation(): void {
  console.log("[SYNC] Cancellation requested (in-memory flag set)");
  _cancelRequested = true;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type Creds = Record<string, string>;

// Raw price data stored in global_delivery_prices — includes provider field.
type GlobalFeeRow = FeeRow & { provider: string };

// Price columns as read back from the DB for comparison during incremental sync.
type StoredFeeRow = {
  destination_wilaya_id:  string;
  destination_commune_id: string;
  express_home:           number | null;
  express_desk:           number | null;
  economic_home:          number | null;
  economic_desk:          number | null;
  retour_fee:             number | null;
  cod_percentage:         number | null;
  insurance_percentage:   number | null;
  oversize_fee:           number | null;
};

// Written to global_delivery_price_history when actual price fields change.
type PriceHistoryRow = {
  provider:                  string;
  origin_wilaya_id:          string;
  destination_wilaya_id:     string;
  destination_commune_id:    string;
  prev_express_home:         number | null;
  prev_express_desk:         number | null;
  prev_economic_home:        number | null;
  prev_economic_desk:        number | null;
  prev_retour_fee:           number | null;
  prev_cod_percentage:       number | null;
  prev_insurance_percentage: number | null;
  prev_oversize_fee:         number | null;
  new_express_home:          number | null;
  new_express_desk:          number | null;
  new_economic_home:         number | null;
  new_economic_desk:         number | null;
  new_retour_fee:            number | null;
  new_cod_percentage:        number | null;
  new_insurance_percentage:  number | null;
  new_oversize_fee:          number | null;
  changed_at:                string;
};

function parseDecryptedCredentials(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Local helper that adds the provider field required by global_delivery_prices.
function normalizeFeesGlobal(
  payload: Record<string, unknown>,
  originWilayaId: string,
  destWilayaId: string,
): GlobalFeeRow[] {
  return normalizeFeesPayload(payload, PROVIDER, originWilayaId, destWilayaId).map((r) => ({
    ...r,
    provider: PROVIDER,
  }));
}

// ── Account resolution ─────────────────────────────────────────────────────────

async function pickYalidineCredentials(): Promise<{ creds: Creds; baseUrl: string }> {
  const envTenantId = process.env.YALIDINE_SYSTEM_TENANT_ID?.trim() ?? "";
  const envApiKey   = process.env.YALIDINE_SYSTEM_API_KEY?.trim() ?? "";

  if (envTenantId && envApiKey) {
    const creds: Creds = { headerName: "X-API-TOKEN", apiKey: envApiKey, tenantId: envTenantId };
    console.log(
      `[global-delivery-cache] using system env credentials` +
      ` X-API-ID="${envTenantId}" X-API-TOKEN=${tokenFingerprint(envApiKey)}`,
    );
    return { creds, baseUrl: BASE_URL };
  }

  const supabase = createClient();
  const { data: row, error } = await supabase
    .from("merchant_delivery_accounts")
    .select("credentials,base_url,endpoints")
    .eq("provider", PROVIDER)
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !row) {
    throw new Error("No active Yalidine account found for global delivery cache sync.");
  }

  const rawCreds   = row.credentials ? decryptSecret(row.credentials as string) : "";
  const parsed     = parseDecryptedCredentials(rawCreds);
  const normalized = normalizeYalidineCredentialsForStorage(PROVIDER, parsed) as Creds;
  const baseUrl    = String((row as { base_url?: string }).base_url ?? BASE_URL).trim() || BASE_URL;

  console.log(
    `[global-delivery-cache] using merchant account credentials` +
    ` X-API-ID="${normalized.tenantId ?? ""}" X-API-TOKEN=${tokenFingerprint(normalized.apiKey ?? "")}`,
  );
  return { creds: normalized, baseUrl };
}

// ── Status helpers ─────────────────────────────────────────────────────────────
// These are unchanged from the pre-redesign version. The quota limiter lives
// entirely inside fetchYalidine; the DB schema and heartbeat logic are untouched.

async function markSyncRunning(supabase: ReturnType<typeof createClient>): Promise<void> {
  const now = new Date().toISOString();
  console.log("[sync] marking status=running, acquiring DB lock");
  await supabase
    .from("global_delivery_sync_status")
    .upsert(
      {
        provider:             PROVIDER,
        status:               "running",
        sync_stage:           "syncing_geo",
        current_origin_id:    null,
        last_sync_started_at: now,
        last_heartbeat_at:    now,
        cancel_requested:     false,
        origins_synced:       [],
        origins_failed:       [],
        prices_count:         0,
        wilayas_count:        0,
        communes_count:       0,
        offices_count:        0,
        error_message:        null,
        updated_at:           now,
      },
      { onConflict: "provider" },
    );
  console.log("[sync] DB lock acquired (status=running, cancel_requested=false)");
}

async function updateHeartbeat(supabase: ReturnType<typeof createClient>): Promise<void> {
  const { data, error } = await supabase
    .from("global_delivery_sync_status")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("provider", PROVIDER)
    .select("cancel_requested")
    .maybeSingle();

  if (error) {
    console.error(`[sync] heartbeat write failed: ${error.message}`);
    return;
  }

  const row = data as { cancel_requested?: boolean } | null;
  if (row?.cancel_requested && !_cancelRequested) {
    console.log("[SYNC] Cancellation requested (detected via heartbeat DB poll)");
    _cancelRequested = true;
  }
  console.log("[sync] heartbeat written");
}

async function markSyncStageGeo(
  supabase: ReturnType<typeof createClient>,
  geo: { wilayas: number; communes: number; offices: number },
): Promise<void> {
  await supabase
    .from("global_delivery_sync_status")
    .update({
      sync_stage:    "syncing_prices",
      wilayas_count: geo.wilayas,
      communes_count: geo.communes,
      offices_count: geo.offices,
      updated_at:    new Date().toISOString(),
    })
    .eq("provider", PROVIDER);
}

async function markCurrentOrigin(
  supabase:  ReturnType<typeof createClient>,
  originId:  string,
): Promise<void> {
  await supabase
    .from("global_delivery_sync_status")
    .update({ current_origin_id: originId, updated_at: new Date().toISOString() })
    .eq("provider", PROVIDER);
}

async function markOriginProgress(
  supabase:      ReturnType<typeof createClient>,
  syncedOrigins: string[],
  failedOrigins: string[],
  totalPrices:   number,
): Promise<void> {
  const t0 = Date.now();
  const { error } = await supabase
    .from("global_delivery_sync_status")
    .update({
      origins_synced: syncedOrigins,
      origins_failed: failedOrigins,
      prices_count:   totalPrices,
      updated_at:     new Date().toISOString(),
    })
    .eq("provider", PROVIDER);
  if (error) {
    console.error(`[sync] markOriginProgress failed in ${Date.now() - t0}ms: ${error.message}`);
  } else {
    console.log(
      `[sync] progress written in ${Date.now() - t0}ms` +
      ` synced=${syncedOrigins.length} failed=${failedOrigins.length} prices=${totalPrices}`,
    );
  }
}

async function markSyncDone(
  supabase: ReturnType<typeof createClient>,
  counts: {
    wilayas: number; communes: number; offices: number;
    prices: number; origins: string[]; failed: string[];
  },
): Promise<void> {
  const now        = new Date().toISOString();
  const allFailed  = counts.failed.length > 0 && counts.origins.length === 0;
  const someFailed = counts.failed.length > 0 && counts.origins.length > 0;
  const status     = allFailed ? "failed" : someFailed ? "partial" : "success";
  const summary    = someFailed
    ? `Completed with ${counts.failed.length} failed origin(s): ${counts.failed.join(", ")}`
    : null;

  console.log(
    `[sync] marking status=${status}` +
    ` synced=${counts.origins.length} failed=${counts.failed.length} prices=${counts.prices}`,
  );

  const t0 = Date.now();
  const { error } = await supabase
    .from("global_delivery_sync_status")
    .upsert(
      {
        provider:               PROVIDER,
        status,
        sync_stage:             null,
        current_origin_id:      null,
        last_sync_completed_at: now,
        last_sync_success_at:   status !== "failed" ? now : undefined,
        wilayas_count:          counts.wilayas,
        communes_count:         counts.communes,
        offices_count:          counts.offices,
        prices_count:           counts.prices,
        origins_synced:         counts.origins,
        origins_failed:         counts.failed,
        error_message:          summary,
        updated_at:             now,
      },
      { onConflict: "provider" },
    );
  if (error) {
    console.error(`[sync] markSyncDone DB write failed in ${Date.now() - t0}ms: ${error.message}`);
  } else {
    console.log(`[sync] markSyncDone written in ${Date.now() - t0}ms`);
  }
}

async function markSyncFailed(
  supabase:     ReturnType<typeof createClient>,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[sync] marking status=failed: ${errorMessage.slice(0, 200)}`);
  await supabase
    .from("global_delivery_sync_status")
    .upsert(
      {
        provider:               PROVIDER,
        status:                 "failed",
        sync_stage:             null,
        current_origin_id:      null,
        last_sync_completed_at: now,
        error_message:          errorMessage.slice(0, 1000),
        updated_at:             now,
      },
      { onConflict: "provider" },
    );
}

async function markSyncCancelled(supabase: ReturnType<typeof createClient>): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("global_delivery_sync_status")
    .update({
      status:            "cancelled",
      sync_stage:        null,
      current_origin_id: null,
      last_heartbeat_at: null,
      cancel_requested:  false,
      updated_at:        now,
    })
    .eq("provider", PROVIDER);
  if (error) {
    console.error(`[sync] markSyncCancelled DB write failed: ${error.message}`);
  } else {
    console.log("[SYNC] Sync cancelled safely.");
  }
}

// Marks the status row as running for a retry run WITHOUT resetting accumulated
// counts (wilayas, communes, offices, prices, origins_synced). The origins_failed
// list is cleared to [] here and repopulated as the retry run progresses.
async function markRetryRunning(
  supabase: ReturnType<typeof createClient>,
  current: {
    synced:   string[];
    prices:   number;
    wilayas:  number;
    communes: number;
    offices:  number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  console.log("[sync] markRetryRunning: preserving existing counts, clearing origins_failed");
  await supabase
    .from("global_delivery_sync_status")
    .upsert(
      {
        provider:          PROVIDER,
        status:            "running",
        sync_stage:        "syncing_prices",
        current_origin_id: null,
        last_sync_started_at: now,
        last_heartbeat_at:    now,
        cancel_requested:     false,
        origins_synced:       current.synced,
        origins_failed:       [],
        prices_count:         current.prices,
        wilayas_count:        current.wilayas,
        communes_count:       current.communes,
        offices_count:        current.offices,
        error_message:        null,
        updated_at:           now,
      },
      { onConflict: "provider" },
    );
}

// ── Geo sync ───────────────────────────────────────────────────────────────────

async function syncGlobalGeo(
  baseUrl:  string,
  headers:  Record<string, string>,
  supabase: ReturnType<typeof createClient>,
): Promise<{ wilayas: number; communes: number; offices: number }> {
  const now = new Date().toISOString();

  console.log("[global-delivery-cache] fetching geo: wilayas …");
  const wilayaItems = await fetchAllPages(baseUrl, "/v1/wilayas/", headers);
  if (isCancelled()) throw new CancellationError("cancelled after wilaya fetch");

  console.log("[global-delivery-cache] fetching geo: communes …");
  const communeItems = await fetchAllPages(baseUrl, "/v1/communes/", headers);
  if (isCancelled()) throw new CancellationError("cancelled after commune fetch");

  console.log("[global-delivery-cache] fetching geo: centers …");
  const officeItems = await fetchAllPages(baseUrl, "/v1/centers/", headers);
  if (isCancelled()) throw new CancellationError("cancelled after centers fetch");

  const wilayas  = normalizeGeoWilayas(wilayaItems, PROVIDER, now);
  const communes = normalizeGeoCommunes(communeItems, PROVIDER, now);
  const offices  = normalizeGeoOffices(officeItems, PROVIDER, now);

  if (wilayas.length > 0) {
    const { error } = await supabase
      .from("global_delivery_wilayas")
      .upsert(wilayas, { onConflict: "provider,wilaya_id" });
    if (error) throw new Error(`global_delivery_wilayas upsert: ${error.message}`);
  }

  if (communes.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < communes.length; i += CHUNK) {
      const { error } = await supabase
        .from("global_delivery_communes")
        .upsert(communes.slice(i, i + CHUNK), { onConflict: "provider,commune_id" });
      if (error) throw new Error(`global_delivery_communes upsert: ${error.message}`);
    }
  }

  if (offices.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < offices.length; i += CHUNK) {
      const { error } = await supabase
        .from("global_delivery_offices")
        .upsert(offices.slice(i, i + CHUNK), { onConflict: "provider,office_id" });
      if (error) throw new Error(`global_delivery_offices upsert: ${error.message}`);
    }
  }

  console.log(
    `[global-delivery-cache] geo synced: wilayas=${wilayas.length}` +
    ` communes=${communes.length} offices=${offices.length}`,
  );

  if (isCancelled()) throw new CancellationError("cancelled after geo upsert");
  return { wilayas: wilayas.length, communes: communes.length, offices: offices.length };
}

// ── Incremental price-sync helpers ────────────────────────────────────────────

async function loadExistingRows(
  supabase:       ReturnType<typeof createClient>,
  originWilayaId: string,
): Promise<Map<string, StoredFeeRow>> {
  const { data, error } = await supabase
    .from("global_delivery_prices")
    .select(
      "destination_wilaya_id,destination_commune_id," +
      "express_home,express_desk,economic_home,economic_desk," +
      "retour_fee,cod_percentage,insurance_percentage,oversize_fee",
    )
    .eq("provider", PROVIDER)
    .eq("origin_wilaya_id", originWilayaId);

  if (error) throw new Error(`loadExistingRows origin=${originWilayaId}: ${error.message}`);

  const map = new Map<string, StoredFeeRow>();
  for (const row of (data ?? []) as unknown as StoredFeeRow[]) {
    const key = `${row.destination_wilaya_id}:${row.destination_commune_id}`;
    map.set(key, row);
  }
  return map;
}

function feesChanged(existing: StoredFeeRow, incoming: GlobalFeeRow): boolean {
  return (
    existing.express_home         !== incoming.express_home         ||
    existing.express_desk         !== incoming.express_desk         ||
    existing.economic_home        !== incoming.economic_home        ||
    existing.economic_desk        !== incoming.economic_desk        ||
    existing.retour_fee           !== incoming.retour_fee           ||
    existing.cod_percentage       !== incoming.cod_percentage       ||
    existing.insurance_percentage !== incoming.insurance_percentage ||
    existing.oversize_fee         !== incoming.oversize_fee
  );
}

function buildPriceHistoryRow(
  existing:       StoredFeeRow,
  incoming:       GlobalFeeRow,
  originWilayaId: string,
  now:            string,
): PriceHistoryRow {
  return {
    provider:                  PROVIDER,
    origin_wilaya_id:          originWilayaId,
    destination_wilaya_id:     incoming.destination_wilaya_id,
    destination_commune_id:    incoming.destination_commune_id,
    prev_express_home:         existing.express_home,
    prev_express_desk:         existing.express_desk,
    prev_economic_home:        existing.economic_home,
    prev_economic_desk:        existing.economic_desk,
    prev_retour_fee:           existing.retour_fee,
    prev_cod_percentage:       existing.cod_percentage,
    prev_insurance_percentage: existing.insurance_percentage,
    prev_oversize_fee:         existing.oversize_fee,
    new_express_home:          incoming.express_home,
    new_express_desk:          incoming.express_desk,
    new_economic_home:         incoming.economic_home,
    new_economic_desk:         incoming.economic_desk,
    new_retour_fee:            incoming.retour_fee,
    new_cod_percentage:        incoming.cod_percentage,
    new_insurance_percentage:  incoming.insurance_percentage,
    new_oversize_fee:          incoming.oversize_fee,
    changed_at:                now,
  };
}

// Writes the incoming rows for one destination wilaya immediately after fetching.
// Returns the total number of rows processed (new + changed + unchanged).
//
// Write strategy (three payload shapes to never overwrite columns wrongly):
//   New routes     → upsert with created_at (fresh row, no conflict expected)
//   Changed routes → upsert without created_at (ON CONFLICT preserves it); history logged
//   Unchanged rows → upsert with only last_synced_at + is_active (prices untouched)
async function writeDestinationRows(
  supabase:       ReturnType<typeof createClient>,
  incoming:       GlobalFeeRow[],
  existingMap:    Map<string, StoredFeeRow>,
  seenKeys:       Set<string>,
  originWilayaId: string,
  now:            string,
): Promise<number> {
  type NewRow = GlobalFeeRow & { created_at: string; last_synced_at: string; is_active: boolean };
  type ChangedRow = GlobalFeeRow & { updated_at: string; last_synced_at: string; is_active: boolean };
  type TouchRow = {
    provider: string; origin_wilaya_id: string;
    destination_wilaya_id: string; destination_commune_id: string;
    last_synced_at: string; is_active: boolean;
  };

  const newRows:     NewRow[]          = [];
  const changedRows: ChangedRow[]      = [];
  const touchRows:   TouchRow[]        = [];
  const historyRows: PriceHistoryRow[] = [];

  for (const row of incoming) {
    const key = `${row.destination_wilaya_id}:${row.destination_commune_id}`;
    seenKeys.add(key);
    const existing = existingMap.get(key);
    if (!existing) {
      newRows.push({ ...row, created_at: now, last_synced_at: now, is_active: true });
    } else if (feesChanged(existing, row)) {
      changedRows.push({ ...row, updated_at: now, last_synced_at: now, is_active: true });
      historyRows.push(buildPriceHistoryRow(existing, row, originWilayaId, now));
    } else {
      touchRows.push({
        provider:               row.provider,
        origin_wilaya_id:       row.origin_wilaya_id,
        destination_wilaya_id:  row.destination_wilaya_id,
        destination_commune_id: row.destination_commune_id,
        last_synced_at: now,
        is_active:      true,
      });
    }
  }

  const ON_CONFLICT = "provider,origin_wilaya_id,destination_wilaya_id,destination_commune_id";

  if (newRows.length > 0) {
    const { error } = await supabase
      .from("global_delivery_prices")
      .upsert(newRows, { onConflict: ON_CONFLICT });
    if (error) throw new Error(`prices INSERT new origin=${originWilayaId}: ${error.message}`);
  }

  if (changedRows.length > 0) {
    const { error } = await supabase
      .from("global_delivery_prices")
      .upsert(changedRows, { onConflict: ON_CONFLICT });
    if (error) throw new Error(`prices UPSERT changed origin=${originWilayaId}: ${error.message}`);
  }

  if (touchRows.length > 0) {
    const { error } = await supabase
      .from("global_delivery_prices")
      .upsert(touchRows, { onConflict: ON_CONFLICT });
    if (error) throw new Error(`prices UPSERT unchanged origin=${originWilayaId}: ${error.message}`);
  }

  if (historyRows.length > 0) {
    const { error } = await supabase
      .from("global_delivery_price_history")
      .insert(historyRows);
    if (error) {
      // History is best-effort — never abort the main sync for it.
      console.error(`[prices] history insert failed: ${error.message}`);
    }
  }

  return incoming.length;
}

// Marks routes in the DB that were not seen in this sync run as inactive.
// Called once per origin after all 58 destination wilayas have been fetched.
async function markInactiveRoutes(
  supabase:       ReturnType<typeof createClient>,
  existingMap:    Map<string, StoredFeeRow>,
  seenKeys:       Set<string>,
  originWilayaId: string,
  now:            string,
): Promise<void> {
  const ON_CONFLICT = "provider,origin_wilaya_id,destination_wilaya_id,destination_commune_id";
  const inactiveRows: {
    provider: string; origin_wilaya_id: string;
    destination_wilaya_id: string; destination_commune_id: string;
    is_active: boolean; last_synced_at: string;
  }[] = [];

  for (const [key, row] of existingMap) {
    if (!seenKeys.has(key)) {
      inactiveRows.push({
        provider:               PROVIDER,
        origin_wilaya_id:       originWilayaId,
        destination_wilaya_id:  row.destination_wilaya_id,
        destination_commune_id: row.destination_commune_id,
        is_active:      false,
        last_synced_at: now,
      });
    }
  }

  if (inactiveRows.length === 0) return;

  const { error } = await supabase
    .from("global_delivery_prices")
    .upsert(inactiveRows, { onConflict: ON_CONFLICT });

  if (error) {
    console.error(`[prices] markInactiveRoutes origin=${originWilayaId}: ${error.message}`);
  } else {
    console.log(`[prices] marked ${inactiveRows.length} routes inactive for origin=${originWilayaId}`);
  }
}

// ── Price sync (per origin) ────────────────────────────────────────────────────
//
// Writes per-destination immediately — never collects all rows then bulk-writes.
// Incremental: compares incoming vs cached and writes only what changed.
// Speed is determined entirely by the quota headers from the rate limiter.

async function syncGlobalPricesForOrigin(
  baseUrl:        string,
  feesEndpoint:   string,
  headers:        Record<string, string>,
  originWilayaId: string,
  supabase:       ReturnType<typeof createClient>,
): Promise<number> {
  const now      = new Date().toISOString();
  const originT0 = Date.now();

  console.log(`[prices] START origin=${originWilayaId} endpoint=${feesEndpoint}`);

  // Load existing rows once — used for all 58 destination comparisons.
  const existingMap = await loadExistingRows(supabase, originWilayaId);
  const seenKeys    = new Set<string>();
  let   totalRows   = 0;

  for (let dest = 1; dest <= TOTAL_WILAYAS; dest++) {
    if (isCancelled()) {
      console.log(`[SYNC] Stopping at dest=${dest} origin=${originWilayaId} — cancellation`);
      break;
    }

    const sep    = feesEndpoint.includes("?") ? "&" : "?";
    const url    = `${baseUrl.replace(/\/$/, "")}${feesEndpoint}${sep}from_wilaya_id=${originWilayaId}&to_wilaya_id=${dest}`;
    const destT0 = Date.now();

    try {
      const payload = await fetchYalidine(url, headers);
      const rows    = normalizeFeesGlobal(payload, originWilayaId, String(dest));
      if (rows.length > 0) {
        totalRows += await writeDestinationRows(supabase, rows, existingMap, seenKeys, originWilayaId, now);
      }
      console.log(
        `[prices] origin=${originWilayaId} dest=${dest}/${TOTAL_WILAYAS}` +
        ` → ${rows.length} rows in ${Date.now() - destT0}ms`,
      );
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      console.warn(
        `[prices] origin=${originWilayaId} dest=${dest}/${TOTAL_WILAYAS}` +
        ` → SKIP after ${Date.now() - destT0}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!isCancelled()) {
    await markInactiveRoutes(supabase, existingMap, seenKeys, originWilayaId, now);
  } else {
    console.log(
      `[prices] origin=${originWilayaId} — cancelled, skipping markInactiveRoutes` +
      ` (${totalRows} rows committed)`,
    );
  }

  console.log(
    `[prices] DONE origin=${originWilayaId} total_rows=${totalRows}` +
    ` elapsed=${Date.now() - originT0}ms`,
  );

  if (isCancelled()) {
    throw new CancellationError(`cancelled after committing origin=${originWilayaId}`);
  }

  return totalRows;
}

// ── Public sync entry point ────────────────────────────────────────────────────

export async function syncGlobalDeliveryCache(opts?: {
  originWilayas?: string[];
  skipGeo?:       boolean;
  skipPrices?:    boolean;
}): Promise<{
  ok:         boolean;
  cancelled?: boolean;
  wilayas:    number;
  communes:   number;
  offices:    number;
  prices:     number;
  origins:    string[];
  failed:     string[];
  error?:     string;
}> {
  if (_syncInProgress) {
    console.warn("[sync] in-process lock: sync already running, ignoring duplicate call");
    return { ok: false, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [], error: "already_running" };
  }
  _syncInProgress  = true;
  _cancelRequested = false;
  _rateLimiter.reset(); // clear quota state from any previous run

  const supabase = createClient();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  await markSyncRunning(supabase);

  heartbeatTimer = setInterval(() => {
    void updateHeartbeat(supabase).catch((e: unknown) => {
      console.error("[sync] heartbeat error:", e instanceof Error ? e.message : String(e));
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const { creds, baseUrl } = await pickYalidineCredentials();
    const headers = buildHeaders(creds);

    let wilayas  = 0;
    let communes = 0;
    let offices  = 0;
    let prices   = 0;

    // ── Geo sync ─────────────────────────────────────────────────────────────
    if (!opts?.skipGeo) {
      const geo = await syncGlobalGeo(baseUrl, headers, supabase);
      wilayas  = geo.wilayas;
      communes = geo.communes;
      offices  = geo.offices;
      await markSyncStageGeo(supabase, geo);
    } else {
      const { count: wc } = await supabase.from("global_delivery_wilayas").select("id", { count: "exact", head: true }).eq("provider", PROVIDER);
      const { count: cc } = await supabase.from("global_delivery_communes").select("id", { count: "exact", head: true }).eq("provider", PROVIDER);
      const { count: oc } = await supabase.from("global_delivery_offices").select("id", { count: "exact", head: true }).eq("provider", PROVIDER);
      wilayas  = wc ?? 0;
      communes = cc ?? 0;
      offices  = oc ?? 0;
      await markSyncStageGeo(supabase, { wilayas, communes, offices });
    }

    // ── Price sync ───────────────────────────────────────────────────────────
    const syncedOrigins: string[] = [];
    const failedOrigins: string[] = [];

    if (!opts?.skipPrices) {
      const originList = opts?.originWilayas ??
        Array.from({ length: TOTAL_WILAYAS }, (_, i) => String(i + 1));

      const { data: accountRow } = await supabase
        .from("merchant_delivery_accounts")
        .select("endpoints")
        .eq("provider", PROVIDER)
        .eq("active", true)
        .limit(1)
        .maybeSingle();

      const optional     = asObject(asObject((accountRow as { endpoints?: unknown } | null)?.endpoints ?? {}).optional ?? {});
      const feesEndpoint = String(optional.fees ?? optional.fee ?? "/v1/fees/").trim() || "/v1/fees/";

      console.log(`[sync] price sync: ${originList.length} origins endpoint=${feesEndpoint}`);

      for (const originId of originList) {
        if (isCancelled()) {
          console.log(`[SYNC] Cancellation requested — not starting origin ${originId}`);
          break;
        }

        await markCurrentOrigin(supabase, originId);
        const originT0 = Date.now();

        try {
          const rowCount = await syncGlobalPricesForOrigin(
            baseUrl, feesEndpoint, headers, originId, supabase,
          );
          prices += rowCount;
          syncedOrigins.push(originId);
          console.log(
            `[sync] origin=${originId} OK rows=${rowCount}` +
            ` elapsed=${Date.now() - originT0}ms synced=${syncedOrigins.length}/${originList.length}`,
          );
        } catch (err) {
          if (err instanceof CancellationError) {
            console.log(`[SYNC] Cancellation propagated from origin=${originId} — stopping price sync`);
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[sync] origin=${originId} FAILED elapsed=${Date.now() - originT0}ms: ${msg}`);
            failedOrigins.push(originId);
            if (msg.includes("auth error") || msg.includes("401") || msg.includes("403")) {
              throw err;
            }
          }
        } finally {
          await markOriginProgress(supabase, syncedOrigins, failedOrigins, prices);
        }

        if (isCancelled()) {
          console.log(`[SYNC] Cancellation confirmed after origin=${originId}`);
          break;
        }
      }

      console.log(
        `[sync] price sync complete: synced=${syncedOrigins.length}` +
        ` failed=${failedOrigins.length} prices=${prices}` +
        (isCancelled() ? " (cancelled)" : ""),
      );
    } else {
      const { count: pc } = await supabase
        .from("global_delivery_prices")
        .select("id", { count: "exact", head: true })
        .eq("provider", PROVIDER);
      prices = pc ?? 0;
    }

    if (isCancelled()) {
      console.log("[SYNC] Cancellation completed — writing cancelled status");
      await markSyncCancelled(supabase);
      return { ok: false, cancelled: true, wilayas, communes, offices, prices, origins: syncedOrigins, failed: failedOrigins };
    }

    await markSyncDone(supabase, { wilayas, communes, offices, prices, origins: syncedOrigins, failed: failedOrigins });
    return { ok: true, wilayas, communes, offices, prices, origins: syncedOrigins, failed: failedOrigins };

  } catch (err) {
    if (err instanceof CancellationError || _cancelRequested) {
      console.log("[SYNC] Sync cancelled safely.");
      await markSyncCancelled(supabase);
      return { ok: false, cancelled: true, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [] };
    }
    const errorMsg = err instanceof Error ? err.message : "unknown error";
    console.error(`[sync] FATAL: ${errorMsg}`);
    await markSyncFailed(supabase, errorMsg);
    return { ok: false, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [], error: errorMsg };
  } finally {
    clearInterval(heartbeatTimer);
    heartbeatTimer  = undefined;
    _syncInProgress = false;
    console.log("[sync] in-process lock released");
  }
}

// ── Retry failed origins ──────────────────────────────────────────────────────
//
// Reads origins_failed from the DB and retries only those origins.
// Never re-syncs origins that already succeeded.
// Merges newly-succeeded origins into origins_synced.
// Origins that fail again stay in origins_failed.
// Uses the same incremental write logic as the full sync.

export async function retrySyncFailedOrigins(): Promise<{
  ok:         boolean;
  cancelled?: boolean;
  synced:     string[];
  failed:     string[];
  newPrices:  number;
  error?:     string;
}> {
  if (_syncInProgress) {
    console.warn("[retry] in-process lock: sync already running, ignoring duplicate call");
    return { ok: false, synced: [], failed: [], newPrices: 0, error: "already_running" };
  }

  const supabase = createClient();

  // Read current status row to extract what we must preserve.
  const { data: statusRow } = await supabase
    .from("global_delivery_sync_status")
    .select("origins_failed,origins_synced,prices_count,wilayas_count,communes_count,offices_count")
    .eq("provider", PROVIDER)
    .maybeSingle();

  const row          = (statusRow as Record<string, unknown> | null) ?? {};
  const toRetry      = (row.origins_failed   as string[]) ?? [];
  const prevSynced   = (row.origins_synced   as string[]) ?? [];
  const prevPrices   = Number(row.prices_count   ?? 0);
  const prevWilayas  = Number(row.wilayas_count  ?? 0);
  const prevCommunes = Number(row.communes_count ?? 0);
  const prevOffices  = Number(row.offices_count  ?? 0);

  if (toRetry.length === 0) {
    console.log("[retry] no failed origins to retry");
    return { ok: true, synced: [], failed: [], newPrices: 0 };
  }

  console.log(`[retry] retrying ${toRetry.length} failed origin(s): ${toRetry.join(", ")}`);

  _syncInProgress  = true;
  _cancelRequested = false;
  _rateLimiter.reset();

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  await markRetryRunning(supabase, {
    synced:   prevSynced,
    prices:   prevPrices,
    wilayas:  prevWilayas,
    communes: prevCommunes,
    offices:  prevOffices,
  });

  heartbeatTimer = setInterval(() => {
    void updateHeartbeat(supabase).catch((e: unknown) => {
      console.error("[retry] heartbeat error:", e instanceof Error ? e.message : String(e));
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const { creds, baseUrl } = await pickYalidineCredentials();
    const headers = buildHeaders(creds);

    const { data: accountRow } = await supabase
      .from("merchant_delivery_accounts")
      .select("endpoints")
      .eq("provider", PROVIDER)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    const optional     = asObject(asObject((accountRow as { endpoints?: unknown } | null)?.endpoints ?? {}).optional ?? {});
    const feesEndpoint = String(optional.fees ?? optional.fee ?? "/v1/fees/").trim() || "/v1/fees/";

    const nowSynced:   string[] = [];
    const stillFailed: string[] = [];
    let   newPrices              = 0;

    for (const originId of toRetry) {
      if (isCancelled()) {
        console.log(`[retry] cancellation requested — not starting origin ${originId}`);
        break;
      }

      await markCurrentOrigin(supabase, originId);
      const originT0 = Date.now();

      try {
        const rowCount = await syncGlobalPricesForOrigin(
          baseUrl, feesEndpoint, headers, originId, supabase,
        );
        newPrices += rowCount;
        nowSynced.push(originId);
        console.log(
          `[retry] origin=${originId} OK rows=${rowCount}` +
          ` elapsed=${Date.now() - originT0}ms`,
        );
      } catch (err) {
        if (err instanceof CancellationError) {
          console.log(`[retry] cancellation propagated from origin=${originId}`);
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[retry] origin=${originId} FAILED elapsed=${Date.now() - originT0}ms: ${msg}`);
        stillFailed.push(originId);
        if (msg.includes("auth error") || msg.includes("401") || msg.includes("403")) {
          throw err; // fatal — stop immediately
        }
      } finally {
        const mergedSynced = [...prevSynced, ...nowSynced];
        await markOriginProgress(supabase, mergedSynced, stillFailed, prevPrices + newPrices);
      }

      if (isCancelled()) {
        console.log(`[retry] cancellation confirmed after origin=${originId}`);
        break;
      }
    }

    if (isCancelled()) {
      await markSyncCancelled(supabase);
      return {
        ok: false, cancelled: true,
        synced: nowSynced, failed: stillFailed, newPrices,
      };
    }

    await markSyncDone(supabase, {
      wilayas:  prevWilayas,
      communes: prevCommunes,
      offices:  prevOffices,
      prices:   prevPrices + newPrices,
      origins:  [...prevSynced, ...nowSynced],
      failed:   stillFailed,
    });

    return { ok: true, synced: nowSynced, failed: stillFailed, newPrices };

  } catch (err) {
    if (err instanceof CancellationError || _cancelRequested) {
      await markSyncCancelled(supabase);
      return { ok: false, cancelled: true, synced: [], failed: [], newPrices: 0 };
    }
    const errorMsg = err instanceof Error ? err.message : "unknown error";
    console.error(`[retry] FATAL: ${errorMsg}`);
    await markSyncFailed(supabase, errorMsg);
    return { ok: false, synced: [], failed: [], newPrices: 0, error: errorMsg };
  } finally {
    clearInterval(heartbeatTimer);
    heartbeatTimer  = undefined;
    _syncInProgress = false;
    console.log("[retry] in-process lock released");
  }
}

// ── Read helpers ───────────────────────────────────────────────────────────────

export type GlobalDeliverySyncStatus = {
  status:               "idle" | "running" | "success" | "partial" | "failed" | "cancelled";
  sync_stage:           "syncing_geo" | "syncing_prices" | null;
  current_origin_id:    string | null;
  wilayas_count:        number;
  communes_count:       number;
  offices_count:        number;
  prices_count:         number;
  origins_synced:       string[];
  origins_failed:       string[];
  last_heartbeat_at:    string | null;
  last_sync_started_at: string | null;
  last_sync_success_at: string | null;
  error_message:        string | null;
  cancel_requested:     boolean;
};

export async function getGlobalDeliverySyncStatus(): Promise<GlobalDeliverySyncStatus> {
  const supabase = createClient();
  const { data } = await supabase
    .from("global_delivery_sync_status")
    .select("*")
    .eq("provider", PROVIDER)
    .maybeSingle();

  const d = (data as Record<string, unknown> | null) ?? {};
  return {
    status:               (d.status as GlobalDeliverySyncStatus["status"]) ?? "idle",
    sync_stage:           (d.sync_stage as GlobalDeliverySyncStatus["sync_stage"]) ?? null,
    current_origin_id:    (d.current_origin_id as string | null) ?? null,
    wilayas_count:        Number(d.wilayas_count ?? 0),
    communes_count:       Number(d.communes_count ?? 0),
    offices_count:        Number(d.offices_count ?? 0),
    prices_count:         Number(d.prices_count ?? 0),
    origins_synced:       (d.origins_synced as string[]) ?? [],
    origins_failed:       (d.origins_failed as string[]) ?? [],
    last_heartbeat_at:    (d.last_heartbeat_at as string | null) ?? null,
    last_sync_started_at: (d.last_sync_started_at as string | null) ?? null,
    last_sync_success_at: (d.last_sync_success_at as string | null) ?? null,
    error_message:        (d.error_message as string | null) ?? null,
    cancel_requested:     Boolean(d.cancel_requested ?? false),
  };
}

export async function getGlobalWilayas(): Promise<Array<{ wilaya_id: string; wilaya_name: string }>> {
  const supabase = createClient();
  const { data } = await supabase
    .from("global_delivery_wilayas")
    .select("wilaya_id,wilaya_name")
    .eq("provider", PROVIDER)
    .order("wilaya_name", { ascending: true });
  return (data ?? []) as Array<{ wilaya_id: string; wilaya_name: string }>;
}

export async function getGlobalCommunes(wilayaId: string): Promise<Array<Record<string, unknown>>> {
  const supabase = createClient();
  const { data } = await supabase
    .from("global_delivery_communes")
    .select("commune_id,commune_name,wilaya_id")
    .eq("provider", PROVIDER)
    .eq("wilaya_id", wilayaId)
    .order("commune_name", { ascending: true });
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function getGlobalOffices(wilayaId: string): Promise<Array<Record<string, unknown>>> {
  const supabase = createClient();
  const { data } = await supabase
    .from("global_delivery_offices")
    .select("office_id,office_name,wilaya_id,commune_id,address")
    .eq("provider", PROVIDER)
    .eq("wilaya_id", wilayaId)
    .order("office_name", { ascending: true });
  return (data ?? []) as Array<Record<string, unknown>>;
}

export type GlobalFeeRecord = {
  destination_wilaya_id:  string;
  destination_commune_id: string | null;
  express_home:           number | null;
  express_desk:           number | null;
  economic_home:          number | null;
  economic_desk:          number | null;
  retour_fee:             number | null;
  cod_percentage:         number | null;
  insurance_percentage:   number | null;
  oversize_fee:           number | null;
};

export async function getGlobalPricesForOrigin(
  originWilayaId: string,
): Promise<GlobalFeeRecord[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("global_delivery_prices")
    .select(
      "destination_wilaya_id,destination_commune_id," +
      "express_home,express_desk,economic_home,economic_desk," +
      "retour_fee,cod_percentage,insurance_percentage,oversize_fee",
    )
    .eq("provider", PROVIDER)
    .eq("origin_wilaya_id", originWilayaId);
  return (data ?? []) as unknown as GlobalFeeRecord[];
}
