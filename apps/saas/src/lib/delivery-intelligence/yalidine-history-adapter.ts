import { YalidineRateLimiter, FETCH_TIMEOUT_MS } from "@/lib/delivery-intelligence/delivery-sync-engine";
import { mapYalidineParcelToOrder, normalizeYalidineStatus } from "@/lib/delivery-intelligence/yalidine-sync-service";
import { extractOutcomeContext, normalizeOutcomeReason } from "@/lib/delivery-intelligence/outcome";
import type {
  NormalizedShipmentSnapshot,
  NormalizedShipmentEvent,
} from "@/lib/delivery-intelligence/merchant-history-writer";

// ── Typed error classes ───────────────────────────────────────────────────────
//
// Each class signals a distinct failure mode so callers can decide whether to
// retry, fail immediately, or schedule a delayed retry.

/** 401 or 403: credentials are invalid. Retrying will not help. */
export class YalidineAuthError extends Error {
  readonly status: number;
  constructor(status: number, tracking: string) {
    super(`Yalidine auth failed (HTTP ${status}) for tracking=${tracking}`);
    this.name = "YalidineAuthError";
    this.status = status;
  }
}

/**
 * 429: provider rate limit hit despite the local rate limiter.
 * The retryAfterMs field carries the Retry-After value so callers can
 * schedule the next attempt at the right time.
 */
export class YalidineRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Yalidine rate limit exceeded; retry after ${retryAfterMs}ms`);
    this.name = "YalidineRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** 5xx or unexpected non-ok response. Transient; retrying is appropriate. */
export class YalidineServerError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Yalidine server error (HTTP ${status}): ${detail}`);
    this.name = "YalidineServerError";
    this.status = status;
  }
}

/** AbortController fired (FETCH_TIMEOUT_MS exceeded). Retrying is appropriate. */
export class YalidineTimeoutError extends Error {
  constructor(tracking: string) {
    super(`Yalidine request timed out for tracking=${tracking}`);
    this.name = "YalidineTimeoutError";
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function buildYalidineHeaders(tenantId: string, apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-ID": tenantId,
    "X-API-TOKEN": apiKey,
  };
}

function readField<T>(
  record: JsonRecord,
  keys: string[],
  coerce: (v: unknown) => T | null,
): T | null {
  for (const key of keys) {
    const v = record[key];
    if (v !== null && v !== undefined && v !== "") {
      const result = coerce(v);
      if (result !== null) return result;
    }
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

function parseIso(v: unknown): string | null {
  const s = asStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractSingleParcel(body: JsonRecord): JsonRecord | null {
  const data = body.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as JsonRecord;
  }
  if (body.tracking ?? body.id) {
    return body;
  }
  return null;
}

function extractHistoriesArray(body: JsonRecord): JsonRecord[] {
  const candidates: unknown[] = [body.data, body.histories, body.results, body.events];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (item): item is JsonRecord => Boolean(item) && typeof item === "object",
      );
    }
  }
  return [];
}

async function yalidineGet(params: {
  url: string;
  tenantId: string;
  apiKey: string;
  tracking: string;
  rateLimiter: YalidineRateLimiter;
}): Promise<Response | null> {
  const { url, tenantId, apiKey, tracking, rateLimiter } = params;

  await rateLimiter.waitIfNeeded(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildYalidineHeaders(tenantId, apiKey),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
      throw new YalidineTimeoutError(tracking);
    }
    // Network-level error (DNS, TCP reset) — retryable; re-throw as-is.
    throw fetchErr;
  }
  clearTimeout(timer);

  rateLimiter.recordResponse(response.headers);

  if (response.status === 404) {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    throw new YalidineAuthError(response.status, tracking);
  }
  if (response.status === 429) {
    const retryAfterSec = parseInt(response.headers.get("Retry-After") ?? "60", 10);
    throw new YalidineRateLimitError(retryAfterSec * 1_000);
  }
  if (!response.ok) {
    throw new YalidineServerError(response.status, `tracking=${tracking}`);
  }

  return response;
}

// ── Public fetch functions ────────────────────────────────────────────────────

/**
 * Fetches GET /v1/parcels/{tracking}.
 * Returns the raw parcel object, or null if the tracking number was not found (404).
 * Throws a typed error for auth (401/403), rate-limit (429), timeout, or server errors.
 */
export async function fetchYalidineParcel(params: {
  baseUrl: string;
  tracking: string;
  tenantId: string;
  apiKey: string;
  rateLimiter: YalidineRateLimiter;
}): Promise<JsonRecord | null> {
  const { baseUrl, tracking, tenantId, apiKey, rateLimiter } = params;
  const url = `${baseUrl}/v1/parcels/${encodeURIComponent(tracking)}`;

  const response = await yalidineGet({ url, tenantId, apiKey, tracking, rateLimiter });
  if (!response) return null;

  let body: JsonRecord;
  try {
    body = (await response.json()) as JsonRecord;
  } catch {
    throw new YalidineServerError(response.status, `malformed JSON for tracking=${tracking}`);
  }
  return extractSingleParcel(body);
}

/**
 * Fetches GET /v1/histories/{tracking}.
 * Returns the list of raw history events, or [] if the tracking was not found (404).
 * Throws a typed error for auth (401/403), rate-limit (429), timeout, or server errors.
 */
export async function fetchYalidineHistories(params: {
  baseUrl: string;
  tracking: string;
  tenantId: string;
  apiKey: string;
  rateLimiter: YalidineRateLimiter;
}): Promise<JsonRecord[]> {
  const { baseUrl, tracking, tenantId, apiKey, rateLimiter } = params;
  const url = `${baseUrl}/v1/histories/${encodeURIComponent(tracking)}`;

  const response = await yalidineGet({ url, tenantId, apiKey, tracking, rateLimiter });
  if (!response) return [];

  let body: JsonRecord;
  try {
    body = (await response.json()) as JsonRecord;
  } catch {
    throw new YalidineServerError(response.status, `malformed JSON histories for tracking=${tracking}`);
  }
  return extractHistoriesArray(body);
}

// ── Normalization functions ───────────────────────────────────────────────────

/**
 * Converts a raw Yalidine parcel object into a provider-agnostic snapshot.
 * Uses mapYalidineParcelToOrder for status + outcome normalization, then reads
 * Yalidine-specific fields (financials, stopdesk, wilaya IDs, dates) directly
 * from the raw parcel since they are not exposed by mapYalidineParcelToOrder.
 */
export function normalizeParcelToSnapshot(
  parcel: JsonRecord,
  tracking: string,
): NormalizedShipmentSnapshot {
  const mapped = mapYalidineParcelToOrder({ parcel });

  const normalizedStatus = mapped?.status ?? "PENDING";
  const normalizedOutcome = mapped?.normalized_outcome_reason ?? null;

  return {
    tracking,
    orderId: readField(parcel, ["order_id", "reference", "id"], asStr),
    phoneMasked: readField(parcel, ["customer_phone", "phone", "mobile", "to_mobile"], asStr),
    phoneSource: "yalidine_masked",
    customerNameMasked: readField(parcel, ["customer_name", "name", "recipient_name", "to_name"], asStr),
    wilayaId: readField(parcel, ["to_wilaya_id", "wilaya_id", "destination_wilaya_id"], asNum),
    wilayaName:
      readField(parcel, ["to_wilaya_name", "wilaya_name", "destination_wilaya_name"], asStr)
      ?? mapped?.wilaya
      ?? null,
    communeName:
      readField(parcel, ["to_commune_name", "commune_name", "destination_commune_name"], asStr)
      ?? mapped?.commune
      ?? null,
    isStopdesk: readField(parcel, ["is_stopdesk", "stopdesk", "is_desk"], asBool),
    stopdeskId: readField(parcel, ["stopdesk_id", "center_id", "desk_id"], asNum),
    codAmount: readField(parcel, ["price", "cod_amount", "order_amount", "amount"], asNum),
    deliveryFee: readField(parcel, ["delivery_fee", "fee", "frais_livraison"], asNum),
    hasRecouvrement: readField(parcel, ["has_recouvrement", "recouvrement"], asBool),
    lastStatus: readField(parcel, ["last_status", "status", "state", "situation"], asStr),
    normalizedStatus,
    normalizedOutcome,
    parcelSubType: readField(parcel, ["type", "parcel_type", "subtype", "sub_type"], asStr),
    hasExchange: readField(parcel, ["has_exchange", "exchange", "is_exchange"], asBool),
    dateCreation: parseIso(readField(parcel, ["date_creation", "created_at", "createdAt"], asStr)),
    dateExpedition: parseIso(
      readField(parcel, ["date_expedition", "shipped_at", "expedition_date"], asStr),
    ),
    dateLastStatus: parseIso(
      readField(parcel, ["date_last_status", "last_state_update_at", "updated_at"], asStr),
    ),
    paymentStatus: readField(parcel, ["payment_status", "paiement_status"], asStr),
    paymentId: readField(parcel, ["payment_id", "paiement_id"], asStr),
    rawPayload: parcel,
  };
}

/**
 * Converts raw Yalidine history events into provider-agnostic shipment events.
 * Events with no parseable date are silently dropped — they cannot be given a
 * stable identity in the UNIQUE (tracking, date_status, status) constraint.
 */
export function normalizeHistoriesToEvents(
  rawEvents: JsonRecord[],
  tracking: string,
): NormalizedShipmentEvent[] {
  const events: NormalizedShipmentEvent[] = [];

  for (const event of rawEvents) {
    const dateStatus = parseIso(
      readField(event, ["date_status", "date", "created_at", "timestamp", "date_time"], asStr),
    );
    if (!dateStatus) continue;

    const status = readField(event, ["status", "state", "situation", "etat"], asStr) ?? "";
    const reason = readField(event, ["reason", "raison", "comment", "motif"], asStr);

    const normalizedStatus = normalizeYalidineStatus(status);
    const outcomeCtx = extractOutcomeContext({ payload: event, normalizedStatus });
    const normalizedOutcome = normalizeOutcomeReason({
      normalizedStatus,
      providerStatusRaw: outcomeCtx.providerStatusRaw,
      providerSituationRaw: outcomeCtx.providerSituationRaw,
      providerReasonRaw: outcomeCtx.providerReasonRaw,
    });

    events.push({
      tracking,
      status,
      normalizedStatus,
      normalizedOutcome,
      reason,
      dateStatus,
      source: "history_api_targeted",
    });
  }

  return events;
}
