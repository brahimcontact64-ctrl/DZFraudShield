/**
 * delivery-sync-engine.ts
 *
 * Shared Yalidine synchronization primitives used by both the Admin Global Cache
 * (global-delivery-cache.ts) and the Merchant Local Cache (merchant-delivery-sync.ts).
 *
 * This module is pure utility — it has no module-level mutable state and makes no
 * database calls. Callers supply their own rate-limiter instance, cancellation
 * predicate, and Supabase client so that admin and merchant syncs remain fully
 * isolated from each other.
 */

// ── Shared constants ───────────────────────────────────────────────────────────

/** If status=running but no heartbeat for this long, the process crashed. */
export const STALE_LOCK_MS         = 5 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Per-request HTTP timeout — quota limiter controls pacing, this guards stalled TCP. */
export const FETCH_TIMEOUT_MS  = 12_000;
/** Retries for network/5xx errors ONLY. 429 retries indefinitely after Retry-After. */
export const MAX_NETWORK_RETRIES = 3;
export const BACKOFF_BASE_MS     = 1_000;

export const TOTAL_WILAYAS = 58;

// Official Yalidine quota limits per the API documentation.
export const MAX_QUOTA_SECOND =     5;
export const MAX_QUOTA_MINUTE =    50;
export const MAX_QUOTA_HOUR   = 1_000;
export const MAX_QUOTA_DAY    = 10_000;

export const WINDOW_MS_SECOND =      1_000;
export const WINDOW_MS_MINUTE =     60_000;
export const WINDOW_MS_HOUR   =  3_600_000;

// Conservative fallback limits when Yalidine has not yet returned a quota header.
const FALLBACK_MAX_SECOND =  1;
const FALLBACK_MAX_MINUTE = 45;

// ── Shared types ───────────────────────────────────────────────────────────────

export type GeoWilayaRow = {
  provider:     string;
  wilaya_id:    string;
  wilaya_name:  string;
  last_sync_at: string;
  updated_at:   string;
};

export type GeoCommuneRow = {
  provider:              string;
  wilaya_id:             string;
  commune_id:            string;
  commune_name:          string;
  has_stop_desk:         boolean;
  is_deliverable:        boolean;
  delivery_time_parcel:  number | null;
  delivery_time_payment: number | null;
  last_sync_at:          string;
  updated_at:            string;
};

export type GeoOfficeRow = {
  provider:    string;
  wilaya_id:   string;
  commune_id:  string;
  office_id:   string;
  office_name: string;
  address:     string | null;
  last_sync_at: string;
  updated_at:   string;
};

export type FeeRow = {
  origin_wilaya_id:       string;
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

export type DeliverySyncStatus = {
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

// ── Rate limiter quota state ────────────────────────────────────────────────────

interface QuotaState {
  secondLeft:            number | null;
  minuteLeft:            number | null;
  hourLeft:              number | null;
  dayLeft:               number | null;
  lastResponseAt:        number;
  hasSecondHeader:       boolean;
  hasMinuteHeader:       boolean;
  secondWindowStartedAt: number;
  minuteWindowStartedAt: number;
  hourWindowStartedAt:   number;
  dayWindowStartedAt:    number;
  fallbackSecondCount:    number;
  fallbackSecondWindowAt: number;
  fallbackMinuteCount:    number;
  fallbackMinuteWindowAt: number;
}

const EMPTY_QUOTA_STATE: QuotaState = {
  secondLeft: null, minuteLeft: null, hourLeft: null, dayLeft: null,
  lastResponseAt:        0,
  hasSecondHeader:       false,
  hasMinuteHeader:       false,
  secondWindowStartedAt: 0,
  minuteWindowStartedAt: 0,
  hourWindowStartedAt:   0,
  dayWindowStartedAt:    0,
  fallbackSecondCount:    0,
  fallbackSecondWindowAt: 0,
  fallbackMinuteCount:    0,
  fallbackMinuteWindowAt: 0,
};

// ── YalidineRateLimiter ────────────────────────────────────────────────────────
//
// Reads official Yalidine quota headers after every successful response and sleeps
// as needed before the next request. Enforces all four quota windows:
//   5 req/s | 50 req/min | 1 000 req/hr | 10 000 req/day
//
// The isCancelled predicate is injected at construction so long quota sleeps
// remain responsive to cancellation requests.

export class YalidineRateLimiter {
  private state: QuotaState = { ...EMPTY_QUOTA_STATE };
  private _pauseCount  = 0;
  private _pauseTotalMs = 0;
  private _retryCount  = 0;

  constructor(private readonly isCancelled: () => boolean) {}

  reset(): void {
    this.state        = { ...EMPTY_QUOTA_STATE };
    this._pauseCount  = 0;
    this._pauseTotalMs = 0;
    this._retryCount  = 0;
  }

  /** Live snapshot of rate-limit statistics accumulated since the last reset(). */
  get stats() {
    return {
      pauseCount:   this._pauseCount,
      pauseTotalMs: this._pauseTotalMs,
      retryCount:   this._retryCount,
      quotaSecond:  this.state.secondLeft,
      quotaMinute:  this.state.minuteLeft,
      quotaHour:    this.state.hourLeft,
      quotaDay:     this.state.dayLeft,
    };
  }

  /** Call once per HTTP 429 response — records the retry and its Retry-After wait. */
  recordRetry(actualWaitMs: number): void {
    this._retryCount++;
    this._pauseCount++;
    this._pauseTotalMs += actualWaitMs;
  }

  /**
   * Update stored quota values from the response headers of a completed request.
   * Window-start detection: quota going UP between responses = fresh window started.
   */
  recordResponse(headers: Headers): void {
    const parse = (name: string): number | null => {
      const v = parseInt(headers.get(name) ?? "", 10);
      return isNaN(v) ? null : v;
    };

    const now  = Date.now();
    const s    = parse("x-second-quota-left");
    const m    = parse("x-minute-quota-left");
    const h    = parse("x-hour-quota-left");
    const d    = parse("x-day-quota-left");
    const prev = this.state;

    const detectWindowStart = (
      newVal: number | null, prevVal: number | null,
      maxQuota: number, prevStartedAt: number,
    ): number => {
      if (newVal === null) return prevStartedAt;
      const isFirstEver    = prevVal === null;
      const quotaIncreased = prevVal !== null && newVal > prevVal;
      if ((isFirstEver && newVal === maxQuota) || quotaIncreased) return now;
      return prevStartedAt;
    };

    this.state = {
      ...prev,
      secondLeft: s ?? prev.secondLeft,
      minuteLeft: m ?? prev.minuteLeft,
      hourLeft:   h ?? prev.hourLeft,
      dayLeft:    d ?? prev.dayLeft,
      lastResponseAt:    now,
      hasSecondHeader:   prev.hasSecondHeader || s !== null,
      hasMinuteHeader:   prev.hasMinuteHeader || m !== null,
      secondWindowStartedAt: detectWindowStart(s, prev.secondLeft, MAX_QUOTA_SECOND, prev.secondWindowStartedAt),
      minuteWindowStartedAt: detectWindowStart(m, prev.minuteLeft, MAX_QUOTA_MINUTE, prev.minuteWindowStartedAt),
      hourWindowStartedAt:   detectWindowStart(h, prev.hourLeft,   MAX_QUOTA_HOUR,   prev.hourWindowStartedAt),
      dayWindowStartedAt:    detectWindowStart(d, prev.dayLeft,    MAX_QUOTA_DAY,    prev.dayWindowStartedAt),
    };

    console.log(
      `[YALIDINE] Quota: second=${s ?? "—"} minute=${m ?? "—"}` +
      ` hour=${h ?? "—"} day=${d ?? "—"}`,
    );
  }

  /**
   * Call BEFORE every outgoing request. Sleeps until any exhausted quota window resets.
   * Priority: day > hour > minute > second > fallback.
   *
   * @param context - Optional URL being fetched; included in every wait log line so
   *                  logs show exactly which (origin, destination) triggered the pause.
   */
  async waitIfNeeded(context = ""): Promise<void> {
    const q   = this.state;
    const now = Date.now();
    const ctx = context ? ` | next=${context}` : "";

    if (q.dayLeft !== null && q.dayLeft <= 0) {
      throw new QuotaExhaustedError("day", "Yalidine daily quota exhausted — sync halted. Re-run tomorrow when the quota resets.");
    }

    if (q.hourLeft !== null && q.hourLeft <= 0) {
      const expiresAt = q.hourWindowStartedAt > 0
        ? q.hourWindowStartedAt + WINDOW_MS_HOUR
        : now + WINDOW_MS_HOUR;
      const waitMs = Math.max(1_000, expiresAt - now);
      console.warn(`[YALIDINE] WAIT window=hour duration=${Math.ceil(waitMs / 1_000)}s quota_left=0${ctx}`);
      const t0 = Date.now();
      await cancelAwareSleep(waitMs, this.isCancelled);
      this._pauseCount++;
      this._pauseTotalMs += Date.now() - t0;
      this.state.hourLeft = null;
      return;
    }

    if (q.minuteLeft !== null && q.minuteLeft <= 0) {
      const expiresAt = q.minuteWindowStartedAt > 0
        ? q.minuteWindowStartedAt + WINDOW_MS_MINUTE
        : now + WINDOW_MS_MINUTE;
      const waitMs = Math.max(1_000, expiresAt - now);
      console.warn(`[YALIDINE] WAIT window=minute duration=${Math.ceil(waitMs / 1_000)}s quota_left=0${ctx}`);
      const t0 = Date.now();
      await cancelAwareSleep(waitMs, this.isCancelled);
      this._pauseCount++;
      this._pauseTotalMs += Date.now() - t0;
      this.state.minuteLeft = null;
      return;
    }

    if (q.secondLeft !== null && q.secondLeft <= 0) {
      const expiresAt = q.secondWindowStartedAt > 0
        ? q.secondWindowStartedAt + WINDOW_MS_SECOND
        : now + WINDOW_MS_SECOND;
      const waitMs = Math.max(0, expiresAt - now);
      if (waitMs > 0) {
        console.log(`[YALIDINE] WAIT window=second duration=${waitMs}ms quota_left=0${ctx}`);
        const t0 = Date.now();
        await sleep(waitMs);
        this._pauseCount++;
        this._pauseTotalMs += Date.now() - t0;
      }
      this.state.secondLeft = null;
      return;
    }

    if (!q.hasMinuteHeader) {
      const elapsed = now - q.fallbackMinuteWindowAt;
      if (elapsed >= WINDOW_MS_MINUTE) {
        this.state.fallbackMinuteCount    = 0;
        this.state.fallbackMinuteWindowAt = now;
      }
      if (this.state.fallbackMinuteCount >= FALLBACK_MAX_MINUTE) {
        const waitMs = Math.max(1_000, WINDOW_MS_MINUTE - (now - this.state.fallbackMinuteWindowAt));
        console.warn(`[YALIDINE] WAIT window=minute(fallback) duration=${Math.ceil(waitMs / 1_000)}s limit=${FALLBACK_MAX_MINUTE}/min${ctx}`);
        const t0 = Date.now();
        await cancelAwareSleep(waitMs, this.isCancelled);
        this._pauseCount++;
        this._pauseTotalMs += Date.now() - t0;
        this.state.fallbackMinuteCount    = 0;
        this.state.fallbackMinuteWindowAt = Date.now();
      }
      this.state.fallbackMinuteCount++;
    }

    if (!q.hasSecondHeader) {
      const now2    = Date.now();
      const elapsed = now2 - q.fallbackSecondWindowAt;
      if (elapsed >= WINDOW_MS_SECOND) {
        this.state.fallbackSecondCount    = 0;
        this.state.fallbackSecondWindowAt = now2;
      }
      if (this.state.fallbackSecondCount >= FALLBACK_MAX_SECOND) {
        const waitMs = Math.max(0, WINDOW_MS_SECOND - (now2 - this.state.fallbackSecondWindowAt));
        if (waitMs > 0) {
          console.log(`[YALIDINE] WAIT window=second(fallback) duration=${waitMs}ms limit=${FALLBACK_MAX_SECOND}/s${ctx}`);
          const t0 = Date.now();
          await sleep(waitMs);
          this._pauseCount++;
          this._pauseTotalMs += Date.now() - t0;
        }
        this.state.fallbackSecondCount    = 0;
        this.state.fallbackSecondWindowAt = Date.now();
      }
      this.state.fallbackSecondCount++;
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cancellation-aware sleep: wakes every 2s to check the cancellation predicate. */
export async function cancelAwareSleep(ms: number, isCancelled: () => boolean): Promise<void> {
  const POLL_MS = 2_000;
  const end     = Date.now() + ms;
  while (Date.now() < end) {
    if (isCancelled()) return;
    await sleep(Math.min(POLL_MS, end - Date.now()));
  }
}

export function positiveOrNull(v: number | null): number | null {
  return v !== null && v > 0 ? v : null;
}

export function readPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".").filter(Boolean)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function firstStr(obj: Record<string, unknown>, paths: string[]): string | null {
  for (const p of paths) {
    const v = readPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export function firstNum(obj: Record<string, unknown>, paths: string[]): number | null {
  for (const p of paths) {
    const v = readPath(obj, p);
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

export function resolveCollection(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
  }
  for (const key of ["data", "results", "items", "list", "records"]) {
    const v = (payload as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      return v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
    }
  }
  return [];
}

export function buildHeaders(creds: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const apiKey   = (creds.apiKey ?? creds.key ?? "").trim();
  const tenantId = (creds.tenantId ?? "").trim();
  if (apiKey)   h[creds.headerName ?? "X-API-TOKEN"] = apiKey;
  if (tenantId) h["X-API-ID"] = tenantId;
  return h;
}

export function tokenFingerprint(token: string): string {
  const t = String(token ?? "").trim();
  if (!t)          return "(empty)";
  if (t.length <= 4) return "****";
  return "*".repeat(12) + t.slice(-4);
}

// ── Quota-aware HTTP fetch ─────────────────────────────────────────────────────
//
// Rules:
//   1. Before every request: rateLimiter.waitIfNeeded()
//   2. After every successful response: rateLimiter.recordResponse()
//   3. HTTP 429: sleep Retry-After (cancellation-aware), retry same request.
//      The network-retry counter is NOT incremented for 429.
//   4. Network errors / timeouts: retry with exponential backoff (max 3 attempts).
//   5. Auth errors (401/403): throw immediately — fatal.
//   6. Other non-OK: retry with backoff up to MAX_NETWORK_RETRIES.

export async function fetchYalidine(
  url:          string,
  headers:      Record<string, string>,
  rateLimiter:  YalidineRateLimiter,
  isCancelled:  () => boolean,
): Promise<Record<string, unknown>> {
  // Lazy-import config to avoid a module-level circular dependency with the
  // delivery-sync-engine, which is shared infrastructure used by non-MDI code.
  const { MDI_CONFIG } = await import("@/lib/delivery-intelligence/mdi-config");

  let networkAttempt    = 0;
  let rateLimitAttempt  = 0;

  while (true) {
    if (isCancelled()) throw new CancellationError("cancelled in fetchYalidine");

    await rateLimiter.waitIfNeeded(url);
    if (isCancelled()) throw new CancellationError("cancelled during quota wait");

    if (networkAttempt > 0) {
      const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, networkAttempt - 1), 30_000);
      console.log(`[YALIDINE] Retry backoff=${backoff}ms attempt=${networkAttempt + 1} url=${url}`);
      await cancelAwareSleep(backoff, isCancelled);
      if (isCancelled()) throw new CancellationError("cancelled during retry backoff");
    }

    const t0         = Date.now();
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    console.log(`[YALIDINE] → ${url} (attempt ${networkAttempt + 1})`);

    let resp: Response;
    try {
      resp = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - t0;
      const msg     = err instanceof Error ? err.message : String(err);
      console.error(
        `[YALIDINE] Network/timeout error in ${elapsed}ms attempt=${networkAttempt + 1}` +
        ` url=${url}: ${msg}`,
      );
      networkAttempt++;
      if (networkAttempt >= MAX_NETWORK_RETRIES) {
        throw new Error(`Yalidine network error after ${MAX_NETWORK_RETRIES} attempts: ${msg} — url=${url}`);
      }
      continue;
    }

    const elapsed = Date.now() - t0;
    console.log(
      `[YALIDINE] ← HTTP ${resp.status} in ${elapsed}ms` +
      ` second=${resp.headers.get("x-second-quota-left") ?? "—"}` +
      ` minute=${resp.headers.get("x-minute-quota-left") ?? "—"}` +
      ` hour=${resp.headers.get("x-hour-quota-left") ?? "—"}` +
      ` day=${resp.headers.get("x-day-quota-left") ?? "—"}` +
      ` url=${url}`,
    );

    if (resp.status === 429) {
      rateLimitAttempt++;
      if (rateLimitAttempt > MDI_CONFIG.MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `Yalidine rate limit: exceeded ${MDI_CONFIG.MAX_RATE_LIMIT_RETRIES} consecutive` +
          ` 429 responses — url=${url}`,
        );
      }
      const retryAfterS = Math.max(1, parseInt(resp.headers.get("Retry-After") ?? "1", 10));
      rateLimiter.recordResponse(resp.headers);
      const waitStart = Date.now();
      console.warn(
        `[YALIDINE] WAIT window=429 Retry-After=${retryAfterS}s` +
        ` quota_second=${resp.headers.get("x-second-quota-left") ?? "—"}` +
        ` quota_minute=${resp.headers.get("x-minute-quota-left") ?? "—"}` +
        ` quota_hour=${resp.headers.get("x-hour-quota-left") ?? "—"}` +
        ` quota_day=${resp.headers.get("x-day-quota-left") ?? "—"}` +
        ` | retrying=${url}`,
      );
      await cancelAwareSleep(retryAfterS * 1_000, isCancelled);
      rateLimiter.recordRetry(Date.now() - waitStart);
      console.log(`[YALIDINE] RESUME after 429 wait — actual_wait=${Date.now() - waitStart}ms | url=${url}`);
      if (isCancelled()) throw new CancellationError("cancelled during 429 retry wait");
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Yalidine auth error HTTP ${resp.status} — check API credentials. url=${url}`);
    }

    if (!resp.ok) {
      console.warn(`[YALIDINE] HTTP ${resp.status} in ${elapsed}ms attempt=${networkAttempt + 1} url=${url}`);
      networkAttempt++;
      if (networkAttempt >= MAX_NETWORK_RETRIES) {
        throw new Error(`Yalidine HTTP ${resp.status} after ${MAX_NETWORK_RETRIES} attempts — url=${url}`);
      }
      continue;
    }

    rateLimiter.recordResponse(resp.headers);
    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    return json;
  }
}

/** Fetches all pages of a paginated Yalidine endpoint. */
export async function fetchAllPages(
  baseUrl:     string,
  endpoint:    string,
  headers:     Record<string, string>,
  rateLimiter: YalidineRateLimiter,
  isCancelled: () => boolean,
): Promise<Record<string, unknown>[]> {
  const allItems: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let currentUrl   = `${baseUrl.replace(/\/$/, "")}${endpoint}`;
  let fallbackPage = 1;

  for (let page = 1; page <= 100; page++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    const payload = await fetchYalidine(currentUrl, headers, rateLimiter, isCancelled);
    const items   = resolveCollection(payload);
    if (items.length === 0) break;

    allItems.push(...items);

    const nextLink = firstStr(payload, ["links.next", "pagination.next", "next", "next_page_url"]);
    if (nextLink) { currentUrl = nextLink; continue; }

    const hasMore  = Boolean(readPath(payload, "has_more") ?? readPath(payload, "pagination.has_more"));
    const pageSize = firstNum(payload, ["page_size", "pagination.page_size", "per_page"]);
    if (hasMore || (pageSize !== null && items.length >= pageSize)) {
      fallbackPage++;
      const sep  = endpoint.includes("?") ? "&" : "?";
      currentUrl = `${baseUrl.replace(/\/$/, "")}${endpoint}${sep}page=${fallbackPage}`;
      continue;
    }

    break;
  }

  return allItems;
}

// ── Geo normalizers ────────────────────────────────────────────────────────────

export function normalizeGeoWilayas(items: Record<string, unknown>[], provider: string, now: string): GeoWilayaRow[] {
  return items
    .map((item) => ({
      provider,
      wilaya_id:    firstStr(item, ["id", "wilaya_id", "code", "wilayaCode"]) ?? "",
      wilaya_name:  firstStr(item, ["name", "wilaya_name", "wilayaName", "label"]) ?? "",
      last_sync_at: now,
      updated_at:   now,
    }))
    .filter((r) => r.wilaya_id && r.wilaya_name);
}

export function normalizeGeoCommunes(items: Record<string, unknown>[], provider: string, now: string): GeoCommuneRow[] {
  return items
    .map((item) => ({
      provider,
      wilaya_id:    firstStr(item, ["wilaya_id", "wilayaId", "wilaya.id", "cityTerritoryId", "parentId"]) ?? "",
      commune_id:   firstStr(item, ["commune_id", "communeId", "id", "code", "districtTerritoryId"]) ?? "",
      commune_name: firstStr(item, ["commune_name", "communeName", "name", "label", "district", "commune"]) ?? "",
      has_stop_desk: Boolean(
        readPath(item, "has_stop_desk") ?? readPath(item, "hasStopDesk") ?? readPath(item, "stop_desk") ?? false,
      ),
      is_deliverable:
        readPath(item, "is_deliverable") !== false && readPath(item, "isDeliverable") !== false,
      delivery_time_parcel:
        firstNum(item, ["delivery_time_parcel", "deliveryTimeParcel", "parcel_delivery_time"]),
      delivery_time_payment:
        firstNum(item, ["delivery_time_payment", "deliveryTimePayment", "payment_delivery_time"]),
      last_sync_at: now,
      updated_at:   now,
    }))
    .filter((r) => r.wilaya_id && r.commune_id && r.commune_name);
}

export function normalizeGeoOffices(items: Record<string, unknown>[], provider: string, now: string): GeoOfficeRow[] {
  return items
    .map((item) => ({
      provider,
      wilaya_id:   firstStr(item, ["wilaya_id", "wilayaId", "cityTerritoryId", "city.id"]) ?? "",
      commune_id:  firstStr(item, ["commune_id", "communeId", "districtTerritoryId", "district.id"]) ?? "",
      office_id:   firstStr(item, ["id", "office_id", "center_id", "pickupBagId", "code"]) ?? "",
      office_name: firstStr(item, ["name", "office_name", "center_name", "agency_name", "label"]) ?? "",
      address:     firstStr(item, ["address", "location", "lieu"]),
      last_sync_at: now,
      updated_at:   now,
    }))
    .filter((r) => r.office_id && r.office_name);
}

// ── Fee normalizer ─────────────────────────────────────────────────────────────

export function normalizeFeesPayload(
  payload:        Record<string, unknown>,
  _provider:      string,
  originWilayaId: string,
  destWilayaId:   string,
): FeeRow[] {
  const eHome  = firstNum(payload, ["express_home", "home"]);
  const eDesk  = firstNum(payload, ["express_desk", "desk"]);
  const ecHome = firstNum(payload, ["economic_home", "home_economic"]);
  const ecDesk = firstNum(payload, ["economic_desk", "desk_economic"]);
  const retour = firstNum(payload, ["retour", "retour_fee", "return_fee"]);
  const cod    = firstNum(payload, ["cod_tax", "cod_tax_percentage", "cod_percentage"]);
  const ins    = firstNum(payload, ["insurance_fee", "insurance_fee_percentage", "insurance_percentage"]);
  const over   = firstNum(payload, ["oversize_fee"]);

  const base = { origin_wilaya_id: originWilayaId };
  const rows: FeeRow[] = [];

  if (eHome !== null || eDesk !== null) {
    rows.push({
      ...base,
      destination_wilaya_id:  destWilayaId,
      destination_commune_id: "",
      express_home:           positiveOrNull(eHome),
      express_desk:           positiveOrNull(eDesk),
      economic_home:          positiveOrNull(ecHome),
      economic_desk:          positiveOrNull(ecDesk),
      retour_fee:             retour,
      cod_percentage:         cod,
      insurance_percentage:   ins,
      oversize_fee:           over,
    });
  }

  const perCommune = asObject(
    readPath(payload, "per_commune") ?? readPath(payload, "data.per_commune") ?? {},
  );
  for (const [rawId, rawFee] of Object.entries(perCommune)) {
    const communeId = String(rawId).trim();
    if (!communeId) continue;
    const fee = asObject(rawFee);
    const cH  = firstNum(fee, ["express_home", "home"]);
    const cD  = firstNum(fee, ["express_desk", "desk"]);
    const cEH = firstNum(fee, ["economic_home", "home_economic"]);
    const cED = firstNum(fee, ["economic_desk", "desk_economic"]);
    if (cH === null && cD === null) continue;
    rows.push({
      ...base,
      destination_wilaya_id:  destWilayaId,
      destination_commune_id: communeId,
      express_home:           positiveOrNull(cH)  ?? positiveOrNull(eHome),
      express_desk:           positiveOrNull(cD)  ?? positiveOrNull(eDesk),
      economic_home:          positiveOrNull(cEH) ?? positiveOrNull(ecHome),
      economic_desk:          positiveOrNull(cED) ?? positiveOrNull(ecDesk),
      retour_fee:             retour,
      cod_percentage:         cod,
      insurance_percentage:   ins,
      oversize_fee:           over,
    });
  }

  return rows;
}

// ── CancellationError ──────────────────────────────────────────────────────────

export class CancellationError extends Error {
  readonly cancelled = true;
  constructor(msg = "Sync cancelled") {
    super(msg);
    this.name = "CancellationError";
  }
}

// ── QuotaExhaustedError ────────────────────────────────────────────────────────
// Thrown when a hard quota limit (day or hour) is exhausted and cannot be
// recovered by waiting within a reasonable sync window. Callers must re-throw
// this error to halt the outer loop rather than silently skipping destinations.

export class QuotaExhaustedError extends Error {
  readonly quotaExhausted = true;
  constructor(public readonly scope: "day" | "hour" = "day", msg?: string) {
    super(msg ?? `Yalidine ${scope} quota exhausted — sync halted until quota resets.`);
    this.name = "QuotaExhaustedError";
  }
}
