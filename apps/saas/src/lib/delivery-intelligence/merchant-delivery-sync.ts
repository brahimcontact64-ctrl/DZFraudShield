/**
 * merchant-delivery-sync.ts
 *
 * Per-merchant Yalidine delivery cache sync. Reuses the shared sync engine
 * (delivery-sync-engine.ts) for HTTP, rate-limiting, retries, and normalisation.
 *
 * Writes to merchant-owned delivery_* tables:
 *   delivery_wilayas, delivery_communes, delivery_stopdesks, delivery_prices
 *
 * Progress is tracked in merchant_delivery_sync_status (one row per merchant + provider).
 *
 * Each merchant sync is fully isolated: its own rate-limiter, its own cancel flag,
 * and its own Yalidine credentials (never admin credentials).
 */

import { createClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/security/crypto";
import { normalizeYalidineCredentialsForStorage } from "@/lib/delivery-intelligence/credentials-guard";
import {
  YalidineRateLimiter,
  CancellationError,
  QuotaExhaustedError,
  STALE_LOCK_MS as ENGINE_STALE_LOCK_MS,
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
  type GeoWilayaRow,
  type GeoCommuneRow,
  type GeoOfficeRow,
  type FeeRow,
} from "@/lib/delivery-intelligence/delivery-sync-engine";

// ── Constants ──────────────────────────────────────────────────────────────────

const PROVIDER = "yalidine";
const BASE_URL  = "https://api.yalidine.app";

export const STALE_LOCK_MS = ENGINE_STALE_LOCK_MS;

// ── Per-merchant in-process state ─────────────────────────────────────────────

type MerchantState = {
  inProgress:      boolean;
  cancelRequested: boolean;
  rateLimiter:     YalidineRateLimiter;
};

const _states = new Map<string, MerchantState>();

function ensureState(merchantId: string): MerchantState {
  let s = _states.get(merchantId);
  if (!s) {
    s = { inProgress: false, cancelRequested: false } as MerchantState;
    s.rateLimiter = new YalidineRateLimiter(() => s!.cancelRequested);
    _states.set(merchantId, s);
  }
  return s;
}

export function requestMerchantCancellation(merchantId: string): void {
  const s = ensureState(merchantId);
  console.log(`[merchant-sync:${merchantId}] cancellation requested (in-memory flag set)`);
  s.cancelRequested = true;
}

export function isMerchantSyncInProgress(merchantId: string): boolean {
  return ensureState(merchantId).inProgress;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type Creds = Record<string, string>;

type ResumeState = {
  syncStage:     "syncing_geo" | "syncing_prices" | null;
  originsSynced: string[];
  pricesCount:   number;
  wilayasCount:  number;
  communesCount: number;
  officesCount:  number;
};

type MerchantWilayaRow = {
  merchant_id:   string;
  account_id:    string | null;
  provider:      string;
  provider_code: string;
  wilaya_id:     string;
  wilaya_name:   string;
  last_sync_at:  string;
  updated_at:    string;
};

type MerchantCommuneRow = {
  merchant_id:   string;
  account_id:    string | null;
  provider:      string;
  provider_code: string;
  wilaya_id:     string;
  wilaya_name:   string | null;
  commune_id:    string;
  commune_name:  string;
  last_sync_at:  string;
  updated_at:    string;
};

type MerchantStopdeskRow = {
  merchant_id:   string;
  account_id:    string | null;
  provider:      string;
  provider_code: string;
  wilaya_id:     string | null;
  wilaya_name:   string | null;
  commune_id:    string | null;
  commune_name:  string | null;
  office_id:     string;
  office_name:   string;
  last_sync_at:  string;
  updated_at:    string;
};

type MerchantPriceRow = {
  merchant_id:          string;
  account_id:           string | null;
  provider:             string;
  provider_code:        string;
  // NOTE: departure_center_id stores the ORIGIN WILAYA ID (e.g. "16"),
  // not the physical Yalidine office/center ID. See toMerchantPrices below.
  departure_center_id:  string;
  wilaya_id:            string;
  commune_id:           string;
  office_id:            string;
  home_price:           number | null;
  stopdesk_price:       number | null;
  last_sync_at:         string;
  updated_at:           string;
};

// ── Row converters ─────────────────────────────────────────────────────────────

function toMerchantWilayas(
  rows: GeoWilayaRow[],
  merchantId: string,
  accountId: string | null,
): MerchantWilayaRow[] {
  return rows.map((r) => ({
    merchant_id:   merchantId,
    account_id:    accountId,
    provider:      PROVIDER,
    provider_code: PROVIDER,
    wilaya_id:     r.wilaya_id,
    wilaya_name:   r.wilaya_name,
    last_sync_at:  r.last_sync_at,
    updated_at:    r.updated_at,
  }));
}

function toMerchantCommunes(
  rows: GeoCommuneRow[],
  merchantId: string,
  accountId: string | null,
): MerchantCommuneRow[] {
  return rows.map((r) => ({
    merchant_id:   merchantId,
    account_id:    accountId,
    provider:      PROVIDER,
    provider_code: PROVIDER,
    wilaya_id:     r.wilaya_id,
    wilaya_name:   null,
    commune_id:    r.commune_id,
    commune_name:  r.commune_name,
    last_sync_at:  r.last_sync_at,
    updated_at:    r.updated_at,
  }));
}

function toMerchantStopdesks(
  rows: GeoOfficeRow[],
  merchantId: string,
  accountId: string | null,
): MerchantStopdeskRow[] {
  return rows.map((r) => ({
    merchant_id:   merchantId,
    account_id:    accountId,
    provider:      PROVIDER,
    provider_code: PROVIDER,
    wilaya_id:     r.wilaya_id || null,
    wilaya_name:   null,
    commune_id:    r.commune_id || null,
    commune_name:  null,
    office_id:     r.office_id,
    office_name:   r.office_name,
    last_sync_at:  r.last_sync_at,
    updated_at:    r.updated_at,
  }));
}

function toMerchantPrices(
  rows: FeeRow[],
  merchantId: string,
  accountId: string | null,
  now: string,
): MerchantPriceRow[] {
  return rows.map((r) => ({
    merchant_id:          merchantId,
    account_id:           accountId,
    provider:             PROVIDER,
    provider_code:        PROVIDER,
    // departure_center_id stores the ORIGIN WILAYA ID (e.g. "16"), not a Yalidine
    // office ID. Checkout queries filter on this field using shipping_origins.wilaya_id.
    departure_center_id:  r.origin_wilaya_id,
    wilaya_id:            r.destination_wilaya_id,
    commune_id:           r.destination_commune_id || "",
    office_id:            "",
    home_price:           r.express_home ?? r.economic_home ?? null,
    stopdesk_price:       r.express_desk ?? r.economic_desk ?? null,
    last_sync_at:         now,
    updated_at:           now,
  }));
}

// ── Credential resolution ──────────────────────────────────────────────────────

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

async function pickMerchantCredentials(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
): Promise<{ creds: Creds; baseUrl: string; accountId: string | null; feesEndpoint: string }> {
  const { data: row, error } = await supabase
    .from("merchant_delivery_accounts")
    .select("id,credentials,base_url,endpoints")
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER)
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !row) {
    throw new Error(`No active Yalidine account found for merchant ${merchantId}.`);
  }

  const accountRow = row as { id: string; credentials: string | null; base_url?: string; endpoints?: unknown };
  const rawCreds   = accountRow.credentials ? decryptSecret(accountRow.credentials) : "";
  const parsed     = parseDecryptedCredentials(rawCreds);
  const normalized = normalizeYalidineCredentialsForStorage(PROVIDER, parsed) as Creds;
  const baseUrl    = String(accountRow.base_url ?? BASE_URL).trim() || BASE_URL;

  const optional     = asObject(asObject(accountRow.endpoints ?? {}).optional ?? {});
  const feesEndpoint = String(optional.fees ?? optional.fee ?? "/v1/fees/").trim() || "/v1/fees/";

  console.log(
    `[merchant-sync:${merchantId}] credentials loaded` +
    ` X-API-ID="${normalized.tenantId ?? ""}" X-API-TOKEN=${tokenFingerprint(normalized.apiKey ?? "")}`,
  );

  return { creds: normalized, baseUrl, accountId: accountRow.id ?? null, feesEndpoint };
}

// ── Resume helpers ─────────────────────────────────────────────────────────────

async function readSyncStateForResume(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
): Promise<{ status: string; heartbeatAt: string | null; resume: ResumeState } | null> {
  const { data } = await supabase
    .from("merchant_delivery_sync_status")
    .select("status,sync_stage,last_heartbeat_at,origins_synced,prices_count,wilayas_count,communes_count,offices_count")
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER)
    .maybeSingle();

  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    status:      String(d.status ?? "idle"),
    heartbeatAt: (d.last_heartbeat_at as string | null) ?? null,
    resume: {
      syncStage:     (d.sync_stage as "syncing_geo" | "syncing_prices" | null) ?? null,
      originsSynced: (d.origins_synced as string[]) ?? [],
      pricesCount:   Number(d.prices_count  ?? 0),
      wilayasCount:  Number(d.wilayas_count  ?? 0),
      communesCount: Number(d.communes_count ?? 0),
      officesCount:  Number(d.offices_count  ?? 0),
    },
  };
}

// ── Bound engine wrappers (per-merchant) ──────────────────────────────────────

function makeFetch(state: MerchantState) {
  return (url: string, headers: Record<string, string>) =>
    engineFetch(url, headers, state.rateLimiter, () => state.cancelRequested);
}

function makeFetchAllPages(state: MerchantState) {
  return (baseUrl: string, endpoint: string, headers: Record<string, string>) =>
    engineFetchAll(baseUrl, endpoint, headers, state.rateLimiter, () => state.cancelRequested);
}

// ── Status helpers ─────────────────────────────────────────────────────────────

async function markRunning(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[merchant-sync:${merchantId}] marking status=running`);
  await supabase
    .from("merchant_delivery_sync_status")
    .upsert(
      {
        merchant_id:               merchantId,
        provider:                  PROVIDER,
        status:                    "running",
        sync_stage:                "syncing_geo",
        current_origin_id:         null,
        last_sync_started_at:      now,
        last_heartbeat_at:         now,
        cancel_requested:          false,
        origins_synced:            [],
        origins_failed:            [],
        prices_count:              0,
        wilayas_count:             0,
        communes_count:            0,
        offices_count:             0,
        error_message:             null,
        rate_limit_pauses:         0,
        rate_limit_pause_total_ms: 0,
        retry_count:               0,
        quota_second:              null,
        quota_minute:              null,
        quota_hour:                null,
        quota_day:                 null,
        updated_at:                now,
      },
      { onConflict: "merchant_id,provider" },
    );
}

async function markResuming(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  resume:     ResumeState,
): Promise<void> {
  const now = new Date().toISOString();
  console.log(
    `[merchant-sync:${merchantId}] stale lock detected — auto-resuming:` +
    ` ${resume.originsSynced.length} origins already synced,` +
    ` continuing price sync from next unprocessed origin`,
  );
  await supabase
    .from("merchant_delivery_sync_status")
    .upsert(
      {
        merchant_id:               merchantId,
        provider:                  PROVIDER,
        status:                    "running",
        sync_stage:                "syncing_prices",
        current_origin_id:         null,
        last_sync_started_at:      now,
        last_heartbeat_at:         now,
        cancel_requested:          false,
        origins_synced:            resume.originsSynced,
        origins_failed:            [],
        prices_count:              resume.pricesCount,
        wilayas_count:             resume.wilayasCount,
        communes_count:            resume.communesCount,
        offices_count:             resume.officesCount,
        error_message:             null,
        rate_limit_pauses:         0,
        rate_limit_pause_total_ms: 0,
        retry_count:               0,
        quota_second:              null,
        quota_minute:              null,
        quota_hour:                null,
        quota_day:                 null,
        updated_at:                now,
      },
      { onConflict: "merchant_id,provider" },
    );
}

async function updateHeartbeat(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  state:      MerchantState,
): Promise<void> {
  const s = state.rateLimiter.stats;
  const { data, error } = await supabase
    .from("merchant_delivery_sync_status")
    .update({
      last_heartbeat_at:         new Date().toISOString(),
      rate_limit_pauses:         s.pauseCount,
      rate_limit_pause_total_ms: s.pauseTotalMs,
      retry_count:               s.retryCount,
      quota_second:              s.quotaSecond,
      quota_minute:              s.quotaMinute,
      quota_hour:                s.quotaHour,
      quota_day:                 s.quotaDay,
    })
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER)
    .select("cancel_requested")
    .maybeSingle();

  if (error) {
    console.error(`[merchant-sync:${merchantId}] heartbeat write failed: ${error.message}`);
    return;
  }

  const row = data as { cancel_requested?: boolean } | null;
  if (row?.cancel_requested && !state.cancelRequested) {
    console.log(`[merchant-sync:${merchantId}] cancellation detected via heartbeat DB poll`);
    state.cancelRequested = true;
  }
}

async function markStageGeo(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  geo:        { wilayas: number; communes: number; offices: number },
): Promise<void> {
  await supabase
    .from("merchant_delivery_sync_status")
    .update({
      sync_stage:     "syncing_prices",
      wilayas_count:  geo.wilayas,
      communes_count: geo.communes,
      offices_count:  geo.offices,
      updated_at:     new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER);
}

async function markCurrentOrigin(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  originId:   string,
): Promise<void> {
  await supabase
    .from("merchant_delivery_sync_status")
    .update({ current_origin_id: originId, updated_at: new Date().toISOString() })
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER);
}

async function markOriginProgress(
  supabase:       ReturnType<typeof createClient>,
  merchantId:     string,
  syncedOrigins:  string[],
  failedOrigins:  string[],
  totalPrices:    number,
  state:          MerchantState,
): Promise<void> {
  const s = state.rateLimiter.stats;
  await supabase
    .from("merchant_delivery_sync_status")
    .update({
      origins_synced:            syncedOrigins,
      origins_failed:            failedOrigins,
      prices_count:              totalPrices,
      rate_limit_pauses:         s.pauseCount,
      rate_limit_pause_total_ms: s.pauseTotalMs,
      retry_count:               s.retryCount,
      quota_second:              s.quotaSecond,
      quota_minute:              s.quotaMinute,
      quota_hour:                s.quotaHour,
      quota_day:                 s.quotaDay,
      updated_at:                new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER);
}

async function markDone(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  counts: {
    wilayas: number; communes: number; offices: number;
    prices: number; origins: string[]; failed: string[];
  },
  state: MerchantState,
): Promise<void> {
  const now       = new Date().toISOString();
  const allFailed = counts.failed.length > 0 && counts.origins.length === 0;
  const someFailed = counts.failed.length > 0 && counts.origins.length > 0;
  const status     = allFailed ? "failed" : someFailed ? "partial" : "success";
  const summary    = someFailed
    ? `Completed with ${counts.failed.length} failed origin(s): ${counts.failed.join(", ")}`
    : null;
  const s = state.rateLimiter.stats;

  await supabase
    .from("merchant_delivery_sync_status")
    .upsert(
      {
        merchant_id:               merchantId,
        provider:                  PROVIDER,
        status,
        sync_stage:                null,
        current_origin_id:         null,
        last_sync_completed_at:    now,
        last_sync_success_at:      status !== "failed" ? now : undefined,
        wilayas_count:             counts.wilayas,
        communes_count:            counts.communes,
        offices_count:             counts.offices,
        prices_count:              counts.prices,
        origins_synced:            counts.origins,
        origins_failed:            counts.failed,
        error_message:             summary,
        rate_limit_pauses:         s.pauseCount,
        rate_limit_pause_total_ms: s.pauseTotalMs,
        retry_count:               s.retryCount,
        quota_second:              s.quotaSecond,
        quota_minute:              s.quotaMinute,
        quota_hour:                s.quotaHour,
        quota_day:                 s.quotaDay,
        updated_at:                now,
      },
      { onConflict: "merchant_id,provider" },
    );

  console.log(
    `[merchant-sync:${merchantId}] status=${status}` +
    ` synced=${counts.origins.length} failed=${counts.failed.length} prices=${counts.prices}`,
  );
}

async function markFailed(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("merchant_delivery_sync_status")
    .upsert(
      {
        merchant_id:            merchantId,
        provider:               PROVIDER,
        status:                 "failed",
        sync_stage:             null,
        current_origin_id:      null,
        last_sync_completed_at: now,
        error_message:          errorMessage.slice(0, 1000),
        updated_at:             now,
      },
      { onConflict: "merchant_id,provider" },
    );
}

async function markCancelled(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("merchant_delivery_sync_status")
    .update({
      status:            "cancelled",
      sync_stage:        null,
      current_origin_id: null,
      last_heartbeat_at: null,
      cancel_requested:  false,
      updated_at:        now,
    })
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER);
  console.log(`[merchant-sync:${merchantId}] sync cancelled safely`);
}

async function markRetryRunning(
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  current: {
    synced: string[]; prices: number;
    wilayas: number; communes: number; offices: number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("merchant_delivery_sync_status")
    .upsert(
      {
        merchant_id:          merchantId,
        provider:             PROVIDER,
        status:               "running",
        sync_stage:           "syncing_prices",
        current_origin_id:    null,
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
      { onConflict: "merchant_id,provider" },
    );
}

// ── Geo sync ───────────────────────────────────────────────────────────────────

async function syncMerchantGeo(
  baseUrl:    string,
  headers:    Record<string, string>,
  supabase:   ReturnType<typeof createClient>,
  merchantId: string,
  accountId:  string | null,
  state:      MerchantState,
): Promise<{ wilayas: number; communes: number; offices: number }> {
  const now          = new Date().toISOString();
  const fetchAll     = makeFetchAllPages(state);
  const isCancelled  = () => state.cancelRequested;

  console.log(`[merchant-sync:${merchantId}] fetching geo: wilayas …`);
  const wilayaItems = await fetchAll(baseUrl, "/v1/wilayas/", headers);
  if (isCancelled()) throw new CancellationError("cancelled after wilaya fetch");

  console.log(`[merchant-sync:${merchantId}] fetching geo: communes …`);
  const communeItems = await fetchAll(baseUrl, "/v1/communes/", headers);
  if (isCancelled()) throw new CancellationError("cancelled after commune fetch");

  console.log(`[merchant-sync:${merchantId}] fetching geo: centers …`);
  const officeItems = await fetchAll(baseUrl, "/v1/centers/", headers);
  if (isCancelled()) throw new CancellationError("cancelled after centers fetch");

  const geoWilayas  = normalizeGeoWilayas(wilayaItems, PROVIDER, now);
  const geoCommunes = normalizeGeoCommunes(communeItems, PROVIDER, now);
  const geoOffices  = normalizeGeoOffices(officeItems, PROVIDER, now);

  const wilayas   = toMerchantWilayas(geoWilayas, merchantId, accountId);
  const communes  = toMerchantCommunes(geoCommunes, merchantId, accountId);
  const stopdesks = toMerchantStopdesks(geoOffices, merchantId, accountId);

  if (wilayas.length > 0) {
    const { error } = await supabase
      .from("delivery_wilayas")
      .upsert(wilayas, { onConflict: "merchant_id,provider,wilaya_id" });
    if (error) throw new Error(`delivery_wilayas upsert: ${error.message}`);
  }

  if (communes.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < communes.length; i += CHUNK) {
      const { error } = await supabase
        .from("delivery_communes")
        .upsert(communes.slice(i, i + CHUNK), { onConflict: "merchant_id,provider,commune_id" });
      if (error) throw new Error(`delivery_communes upsert: ${error.message}`);
    }
  }

  if (stopdesks.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < stopdesks.length; i += CHUNK) {
      const { error } = await supabase
        .from("delivery_stopdesks")
        .upsert(stopdesks.slice(i, i + CHUNK), { onConflict: "merchant_id,provider,office_id" });
      if (error) throw new Error(`delivery_stopdesks upsert: ${error.message}`);
    }
  }

  console.log(
    `[merchant-sync:${merchantId}] geo synced:` +
    ` wilayas=${wilayas.length} communes=${communes.length} stopdesks=${stopdesks.length}`,
  );

  if (isCancelled()) throw new CancellationError("cancelled after geo upsert");
  return { wilayas: wilayas.length, communes: communes.length, offices: stopdesks.length };
}

// ── Price sync (per origin) ────────────────────────────────────────────────────

async function syncMerchantPricesForOrigin(
  baseUrl:        string,
  feesEndpoint:   string,
  headers:        Record<string, string>,
  originWilayaId: string,
  supabase:       ReturnType<typeof createClient>,
  merchantId:     string,
  accountId:      string | null,
  state:          MerchantState,
): Promise<number> {
  const fetchOne    = makeFetch(state);
  const isCancelled = () => state.cancelRequested;
  const now         = new Date().toISOString();
  const originT0    = Date.now();

  // ── Per-origin diagnostic counters ──────────────────────────────────────────
  let diagApiCalls   = 0;  // HTTP requests made
  let diagFeeRows    = 0;  // rows out of normalizeFeesPayload
  let diagPriceRows  = 0;  // rows sent to Supabase upsert
  let diagStored     = 0;  // rows confirmed stored (no upsert error)
  let diagUpsertErr  = 0;  // rows dropped because upsert returned an error
  let diagEmpty      = 0;  // (origin,dest) pairs that yielded 0 fee rows

  console.log(`[merchant-sync:${merchantId}] prices START origin=${originWilayaId} endpoint=${feesEndpoint}`);

  let totalRows = 0;

  for (let dest = 1; dest <= TOTAL_WILAYAS; dest++) {
    if (isCancelled()) {
      console.log(`[merchant-sync:${merchantId}] stopping at dest=${dest} — cancellation`);
      break;
    }

    const sep    = feesEndpoint.includes("?") ? "&" : "?";
    const url    = `${baseUrl.replace(/\/$/, "")}${feesEndpoint}${sep}from_wilaya_id=${originWilayaId}&to_wilaya_id=${dest}`;
    const destT0 = Date.now();
    diagApiCalls++;

    try {
      const payload = await fetchOne(url, headers);

      // ── DIAGNOSTIC: inspect raw Yalidine payload structure ─────────────────
      // Logged for every dest of the first origin (to reveal the exact API shape),
      // and for any subsequent call where the root-level price fields are absent
      // (which would explain why normalizeFeesPayload returns 0 rows).
      {
        const payloadKeys    = Object.keys(payload).sort();
        const feeAtRoot      = payloadKeys.some(k =>
          ["express_home","home","express_desk","desk","economic_home","economic_desk"].includes(k),
        );
        const hasPerCommune  = "per_commune"  in payload;
        const hasData        = "data"         in payload;
        const dataVal        = hasData ? payload["data"] : null;
        const dataIsArray    = Array.isArray(dataVal);
        const dataIsObj      = !dataIsArray && dataVal !== null && typeof dataVal === "object";
        const perCommuneSize =
          hasPerCommune
            ? Object.keys(asObject(payload["per_commune"])).length
            : dataIsObj
              ? Object.keys(asObject((asObject(dataVal))["per_commune"] ?? {})).length
              : 0;

        if (originWilayaId === "1" || !feeAtRoot) {
          console.log(
            `[merchant-sync:${merchantId}] DIAG-PAYLOAD origin=${originWilayaId} dest=${dest}` +
            ` keys=[${payloadKeys.join(",")}]` +
            ` fee_at_root=${feeAtRoot}` +
            ` per_commune=${hasPerCommune}(${perCommuneSize} entries)` +
            ` has_data=${hasData}(${dataIsArray ? "array len=" + (dataVal as unknown[]).length : dataIsObj ? "object" : typeof dataVal})` +
            ` sample=${JSON.stringify(payload).slice(0, 500)}`,
          );
        }
      }

      const feeRows   = normalizeFeesPayload(payload, PROVIDER, originWilayaId, String(dest));
      const priceRows = toMerchantPrices(feeRows, merchantId, accountId, now);

      diagFeeRows   += feeRows.length;
      diagPriceRows += priceRows.length;
      if (feeRows.length === 0) diagEmpty++;

      let storedThisDest = 0;
      if (priceRows.length > 0) {
        const { error } = await supabase
          .from("delivery_prices")
          .upsert(priceRows, {
            onConflict: "merchant_id,provider,departure_center_id,wilaya_id,commune_id,office_id",
          });
        if (error) {
          diagUpsertErr += priceRows.length;
          console.error(
            `[merchant-sync:${merchantId}] UPSERT-ERROR origin=${originWilayaId} dest=${dest}` +
            ` rows_dropped=${priceRows.length} code=${error.code} msg=${error.message}`,
          );
        } else {
          storedThisDest  = priceRows.length;
          diagStored     += priceRows.length;
          totalRows      += priceRows.length;
        }
      }

      console.log(
        `[merchant-sync:${merchantId}] origin=${originWilayaId} dest=${dest}/${TOTAL_WILAYAS}` +
        ` fee_rows=${feeRows.length} stored=${storedThisDest}` +
        ` elapsed=${Date.now() - destT0}ms`,
      );
    } catch (err) {
      if (err instanceof CancellationError)   throw err;
      if (err instanceof QuotaExhaustedError) throw err;
      diagEmpty++;
      console.warn(
        `[merchant-sync:${merchantId}] SKIP origin=${originWilayaId} dest=${dest}/${TOTAL_WILAYAS}` +
        ` after ${Date.now() - destT0}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Per-origin summary ───────────────────────────────────────────────────────
  console.log(
    `[merchant-sync:${merchantId}] ORIGIN-SUMMARY origin=${originWilayaId}` +
    ` api_requests=${diagApiCalls}` +
    ` fee_rows_from_yalidine=${diagFeeRows}` +
    ` price_rows_sent_to_supabase=${diagPriceRows}` +
    ` rows_stored=${diagStored}` +
    ` rows_dropped_by_upsert_error=${diagUpsertErr}` +
    ` dests_with_zero_rows=${diagEmpty}/${TOTAL_WILAYAS}` +
    ` elapsed=${Date.now() - originT0}ms`,
  );

  if (isCancelled()) throw new CancellationError(`cancelled after committing origin=${originWilayaId}`);
  return totalRows;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export type MerchantSyncResult = {
  ok:         boolean;
  cancelled?: boolean;
  wilayas:    number;
  communes:   number;
  offices:    number;
  prices:     number;
  origins:    string[];
  failed:     string[];
  error?:     string;
};

export async function syncMerchantDeliveryCache(
  merchantId: string,
  opts?: {
    originWilayas?: string[];
    skipGeo?:       boolean;
    skipPrices?:    boolean;
  },
): Promise<MerchantSyncResult> {
  const state = ensureState(merchantId);

  if (state.inProgress) {
    console.warn(`[merchant-sync:${merchantId}] in-process lock: already running`);
    return { ok: false, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [], error: "already_running" };
  }

  state.inProgress      = true;
  state.cancelRequested = false;
  state.rateLimiter.reset();

  const supabase = createClient();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // Auto-resume: if the DB shows a stale running lock with price-sync already in
  // progress, skip already-committed origins instead of restarting from wilaya 1.
  // Resume only applies when no explicit originWilayas override is given.
  let resumeFrom: ResumeState | null = null;
  if (!opts?.originWilayas) {
    const existing = await readSyncStateForResume(supabase, merchantId);
    if (existing?.status === "running") {
      const heartbeatMs = existing.heartbeatAt ? new Date(existing.heartbeatAt).getTime() : 0;
      const isStale     = Date.now() - heartbeatMs > STALE_LOCK_MS;
      if (isStale && existing.resume.syncStage === "syncing_prices" && existing.resume.originsSynced.length > 0) {
        resumeFrom = existing.resume;
      }
    }
  }

  if (resumeFrom) {
    await markResuming(supabase, merchantId, resumeFrom);
  } else {
    await markRunning(supabase, merchantId);
  }

  heartbeatTimer = setInterval(() => {
    void updateHeartbeat(supabase, merchantId, state).catch((e: unknown) => {
      console.error(`[merchant-sync:${merchantId}] heartbeat error:`, e instanceof Error ? e.message : String(e));
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const { creds, baseUrl, accountId, feesEndpoint } = await pickMerchantCredentials(supabase, merchantId);
    const headers = buildHeaders(creds);

    // When resuming a stale sync, carry forward the already-accumulated counts.
    let wilayas  = resumeFrom?.wilayasCount  ?? 0;
    let communes = resumeFrom?.communesCount ?? 0;
    let offices  = resumeFrom?.officesCount  ?? 0;
    let prices   = resumeFrom?.pricesCount   ?? 0;

    // ── Geo sync ─────────────────────────────────────────────────────────────
    if (resumeFrom) {
      // Geo was already completed before the crash — skip it entirely.
    } else if (!opts?.skipGeo) {
      const geo = await syncMerchantGeo(baseUrl, headers, supabase, merchantId, accountId, state);
      wilayas  = geo.wilayas;
      communes = geo.communes;
      offices  = geo.offices;
      await markStageGeo(supabase, merchantId, geo);
    } else {
      const { count: wc } = await supabase
        .from("delivery_wilayas").select("id", { count: "exact", head: true })
        .eq("merchant_id", merchantId).eq("provider", PROVIDER);
      const { count: cc } = await supabase
        .from("delivery_communes").select("id", { count: "exact", head: true })
        .eq("merchant_id", merchantId).eq("provider", PROVIDER);
      const { count: oc } = await supabase
        .from("delivery_stopdesks").select("id", { count: "exact", head: true })
        .eq("merchant_id", merchantId).eq("provider", PROVIDER);
      wilayas  = wc ?? 0;
      communes = cc ?? 0;
      offices  = oc ?? 0;
      await markStageGeo(supabase, merchantId, { wilayas, communes, offices });
    }

    // ── Price sync ───────────────────────────────────────────────────────────
    // Seed syncedOrigins from the resumed state so markOriginProgress carries
    // the full cumulative list (already-done + newly-done) to the DB.
    const syncedOrigins: string[] = resumeFrom ? [...resumeFrom.originsSynced] : [];
    const failedOrigins: string[] = [];

    if (!opts?.skipPrices) {
      const fullOriginList = opts?.originWilayas ??
        Array.from({ length: TOTAL_WILAYAS }, (_, i) => String(i + 1));

      // Resume: skip origins already fully committed in a previous run.
      const alreadySynced = new Set(syncedOrigins);
      const originList    = resumeFrom
        ? fullOriginList.filter((o) => !alreadySynced.has(o))
        : fullOriginList;

      if (resumeFrom && alreadySynced.size > 0) {
        console.log(
          `[merchant-sync:${merchantId}] RESUME: skipping ${alreadySynced.size} already-synced origins,` +
          ` ${originList.length} remaining (next: ${originList[0] ?? "none"})`,
        );
      }
      console.log(`[merchant-sync:${merchantId}] price sync: ${originList.length} origins endpoint=${feesEndpoint}`);

      let grandApiRequests = 0;

      for (const originId of originList) {
        if (state.cancelRequested) break;

        await markCurrentOrigin(supabase, merchantId, originId);

        try {
          const count = await syncMerchantPricesForOrigin(
            baseUrl, feesEndpoint, headers, originId, supabase, merchantId, accountId, state,
          );
          prices += count;
          grandApiRequests += TOTAL_WILAYAS; // one request per destination
          syncedOrigins.push(originId);
        } catch (err) {
          if (err instanceof CancellationError) {
            console.log(`[merchant-sync:${merchantId}] cancelled during origin=${originId}`);
            break;
          }
          if (err instanceof QuotaExhaustedError) {
            // Day quota is gone — mark remaining origins as failed and halt.
            // The sync can be re-run tomorrow; already-synced origins won't be re-fetched.
            console.error(
              `[merchant-sync:${merchantId}] quota exhausted during origin=${originId} —` +
              ` halting sync. Re-run tomorrow to complete remaining origins.`,
            );
            const startIdx  = originList.indexOf(originId);
            const remaining = startIdx >= 0 ? originList.slice(startIdx) : [originId];
            for (const o of remaining) failedOrigins.push(o);
            break;
          }
          console.error(
            `[merchant-sync:${merchantId}] origin=${originId} failed:`,
            err instanceof Error ? err.message : String(err),
          );
          failedOrigins.push(originId);
        }

        await markOriginProgress(supabase, merchantId, syncedOrigins, failedOrigins, prices, state);
      }

      // ── Grand total ──────────────────────────────────────────────────────────
      console.log(
        `[merchant-sync:${merchantId}] GRAND-TOTAL` +
        ` origins_attempted=${originList.length}` +
        ` origins_synced=${syncedOrigins.length}` +
        ` origins_failed=${failedOrigins.length}` +
        ` total_api_requests=${grandApiRequests}` +
        ` total_rows_stored=${prices}` +
        ` rows_per_api_call=${grandApiRequests > 0 ? (prices / grandApiRequests).toFixed(2) : "n/a"}` +
        ` expected_if_full_dataset=${originList.length * TOTAL_WILAYAS}+ (at least 1 per pair)`,
      );
    }

    if (state.cancelRequested) {
      await markCancelled(supabase, merchantId);
      return { ok: true, cancelled: true, wilayas, communes, offices, prices, origins: syncedOrigins, failed: failedOrigins };
    }

    await markDone(supabase, merchantId, { wilayas, communes, offices, prices, origins: syncedOrigins, failed: failedOrigins }, state);
    return { ok: true, wilayas, communes, offices, prices, origins: syncedOrigins, failed: failedOrigins };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[merchant-sync:${merchantId}] sync failed: ${msg}`);
    await markFailed(supabase, merchantId, msg);
    return { ok: false, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [], error: msg };
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    state.inProgress = false;
  }
}

export async function retryMerchantFailedOrigins(merchantId: string): Promise<MerchantSyncResult> {
  const supabase = createClient();

  const { data: statusRow } = await supabase
    .from("merchant_delivery_sync_status")
    .select("origins_synced,origins_failed,prices_count,wilayas_count,communes_count,offices_count")
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER)
    .maybeSingle();

  type StatusRow = {
    origins_synced: string[];
    origins_failed: string[];
    prices_count:   number;
    wilayas_count:  number;
    communes_count: number;
    offices_count:  number;
  } | null;

  const row = statusRow as StatusRow;
  const failedOrigins = row?.origins_failed ?? [];

  if (failedOrigins.length === 0) {
    return { ok: false, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [], error: "no_failed_origins" };
  }

  const state = ensureState(merchantId);
  if (state.inProgress) {
    return { ok: false, wilayas: 0, communes: 0, offices: 0, prices: 0, origins: [], failed: [], error: "already_running" };
  }

  await markRetryRunning(supabase, merchantId, {
    synced:  row?.origins_synced  ?? [],
    prices:  row?.prices_count    ?? 0,
    wilayas: row?.wilayas_count   ?? 0,
    communes: row?.communes_count ?? 0,
    offices:  row?.offices_count  ?? 0,
  });

  return syncMerchantDeliveryCache(merchantId, { skipGeo: true, originWilayas: failedOrigins });
}

export type MerchantDeliverySyncStatus = {
  status:                    "idle" | "running" | "success" | "partial" | "failed" | "cancelled";
  sync_stage:                "syncing_geo" | "syncing_prices" | null;
  current_origin_id:         string | null;
  wilayas_count:             number;
  communes_count:            number;
  offices_count:             number;
  prices_count:              number;
  origins_synced:            string[];
  origins_failed:            string[];
  last_heartbeat_at:         string | null;
  last_sync_started_at:      string | null;
  last_sync_completed_at:    string | null;
  last_sync_success_at:      string | null;
  error_message:             string | null;
  cancel_requested:          boolean;
  rate_limit_pauses:         number;
  rate_limit_pause_total_ms: number;
  retry_count:               number;
  quota_second:              number | null;
  quota_minute:              number | null;
  quota_hour:                number | null;
  quota_day:                 number | null;
};

export async function getMerchantSyncStatus(merchantId: string): Promise<MerchantDeliverySyncStatus> {
  const supabase = createClient();
  const { data } = await supabase
    .from("merchant_delivery_sync_status")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("provider", PROVIDER)
    .maybeSingle();

  const d = (data as Record<string, unknown> | null) ?? {};
  return {
    status:                    (d.status as MerchantDeliverySyncStatus["status"]) ?? "idle",
    sync_stage:                (d.sync_stage as MerchantDeliverySyncStatus["sync_stage"]) ?? null,
    current_origin_id:         (d.current_origin_id as string | null) ?? null,
    wilayas_count:             Number(d.wilayas_count ?? 0),
    communes_count:            Number(d.communes_count ?? 0),
    offices_count:             Number(d.offices_count ?? 0),
    prices_count:              Number(d.prices_count ?? 0),
    origins_synced:            (d.origins_synced as string[]) ?? [],
    origins_failed:            (d.origins_failed as string[]) ?? [],
    last_heartbeat_at:         (d.last_heartbeat_at as string | null) ?? null,
    last_sync_started_at:      (d.last_sync_started_at as string | null) ?? null,
    last_sync_completed_at:    (d.last_sync_completed_at as string | null) ?? null,
    last_sync_success_at:      (d.last_sync_success_at as string | null) ?? null,
    error_message:             (d.error_message as string | null) ?? null,
    cancel_requested:          Boolean(d.cancel_requested ?? false),
    rate_limit_pauses:         Number(d.rate_limit_pauses ?? 0),
    rate_limit_pause_total_ms: Number(d.rate_limit_pause_total_ms ?? 0),
    retry_count:               Number(d.retry_count ?? 0),
    quota_second:              d.quota_second != null ? Number(d.quota_second) : null,
    quota_minute:              d.quota_minute != null ? Number(d.quota_minute) : null,
    quota_hour:                d.quota_hour   != null ? Number(d.quota_hour)   : null,
    quota_day:                 d.quota_day    != null ? Number(d.quota_day)    : null,
  };
}
