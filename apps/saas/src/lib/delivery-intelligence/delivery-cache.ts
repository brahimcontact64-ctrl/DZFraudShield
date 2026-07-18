import { createClient } from "@/lib/supabase/server";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { mergeWithAlgeriaSeed, findMissingWilayas } from "@/lib/delivery-intelligence/algeria-wilayas";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { getGlobalWilayas, getGlobalCommunes, getGlobalOffices } from "@/lib/delivery-intelligence/global-delivery-cache";

// In-process mutex: prevents concurrent syncs for the same merchant from
// the PHP client's retry-on-timeout creating a second parallel sync run.
const _syncInProgressMerchants = new Set<string>();

type Account = Awaited<ReturnType<typeof getSyncableDeliveryAccounts>>[number];

type WilayaRow = {
  wilaya_id: string;
  wilaya_name: string;
};

type CommuneRow = {
  wilaya_id: string;
  commune_id: string;
  commune_name: string;
};

type StopdeskRow = {
  wilaya_id?: string | null;
  wilaya_name?: string | null;
  commune_id?: string | null;
  commune_name?: string | null;
  office_id: string;
  office_name: string;
};

type PriceRow = {
  wilaya_id: string;
  wilaya_name?: string | null;
  commune_id?: string | null;
  commune_name?: string | null;
  office_id?: string | null;
  office_name?: string | null;
  home_price?: number | null;
  stopdesk_price?: number | null;
  // NOTE: departure_center_id stores the ORIGIN WILAYA ID (e.g. "16"),
  // not the physical Yalidine office/center ID.
  departure_center_id?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const YALIDINE_SYNC_COOLDOWN_MS = 15 * 60 * 1000;
const YALIDINE_FAILURE_MARKER = "yalidine_cache_failed_at:";
const YALIDINE_WILAYA_TARGET_COUNT = 58;
const YALIDINE_FEES_DESTINATION_MAX_ATTEMPTS = 4;
const YALIDINE_FEES_SYNC_MAX_ROUNDS = 4;
const YALIDINE_PROVIDER_FETCH_MAX_ATTEMPTS = 6;
const YALIDINE_PROVIDER_FETCH_MAX_WAIT_MS = 15000;

type SyncTriggerSource =
  | "plugin_delivery_cache_force"
  | "dashboard_origin_options_refresh"
  | "dashboard_account_save"
  | "plugin_onboarding_connect"
  | "admin_delivery_cache_force_sync"
  | "cron_daily"
  | "background_job"
  | "dashboard_manual"
  | "unknown";

type SyncQueueStatus = "queued" | "already_running" | "cooldown_active";

type YalidineSyncStatus = {
  status: "success" | "failed" | "running" | "cooldown" | "idle";
  last_sync_at: string | null;
  error_message: string | null;
  cooldown_until: string | null;
};

type YalidineSyncQueueResult = {
  status: SyncQueueStatus;
  jobId: string | null;
  sync: YalidineSyncStatus;
};

type CacheFetchDiagnostics = {
  centersFetchSucceeded?: boolean;
  centersFetchError?: string | null;
  communesFetchSucceeded?: boolean;
};

type CacheFetchResult = {
  wilayas: WilayaRow[];
  communes: CommuneRow[];
  stopdesks: StopdeskRow[];
  prices: PriceRow[];
  departureCenterId?: string;
  diagnostics?: CacheFetchDiagnostics;
};

class YalidineQuotaError extends Error {
  retryAfterSeconds: number | null;

  quota: {
    secondLeft: number | null;
    minuteLeft: number | null;
    hourLeft: number | null;
    dayLeft: number | null;
  };

  constructor(params: {
    endpoint: string;
    retryAfterSeconds: number | null;
    quota: {
      secondLeft: number | null;
      minuteLeft: number | null;
      hourLeft: number | null;
      dayLeft: number | null;
    };
  }) {
    const retryPart = params.retryAfterSeconds !== null ? `retry_after=${params.retryAfterSeconds}` : "retry_after=unknown";
    const quotaPart = `quota[s=${params.quota.secondLeft ?? -1},m=${params.quota.minuteLeft ?? -1},h=${params.quota.hourLeft ?? -1},d=${params.quota.dayLeft ?? -1}]`;
    super(`provider_cache_sync_quota_yalidine_429:${retryPart}:${quotaPart}:${params.endpoint}`);
    this.name = "YalidineQuotaError";
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.quota = params.quota;
  }
}

function normalizeWilayaName(value: string): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['`´’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSeedWilayaId(value: string): boolean {
  return /_seed_/i.test(String(value ?? ""));
}

function dedupeWilayas(rows: Array<{ wilaya_id?: string | null; wilaya_name?: string | null }>) {
  const byName = new Map<string, { wilaya_id: string; wilaya_name: string }>();

  for (const row of rows) {
    const wilayaId = String(row.wilaya_id ?? "").trim();
    const wilayaName = String(row.wilaya_name ?? "").trim();
    if (!wilayaId || !wilayaName) continue;

    const key = normalizeWilayaName(wilayaName);
    if (!key) continue;

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { wilaya_id: wilayaId, wilaya_name: wilayaName });
      continue;
    }

    const existingIsSeed = isSeedWilayaId(existing.wilaya_id);
    const currentIsSeed = isSeedWilayaId(wilayaId);
    if (existingIsSeed && !currentIsSeed) {
      byName.set(key, { wilaya_id: wilayaId, wilaya_name: wilayaName });
    }
  }

  return [...byName.values()].sort((a, b) => a.wilaya_name.localeCompare(b.wilaya_name, "fr"));
}

function resolveEffectiveWilayaId(
  wilayas: Array<{ wilaya_id?: string | null; wilaya_name?: string | null }>,
  requestedWilayaId?: string | null,
): string | null {
  const requested = String(requestedWilayaId ?? "").trim();
  if (!requested) return null;
  if (!isSeedWilayaId(requested)) return requested;

  const selected = wilayas.find((row) => String(row.wilaya_id ?? "").trim() === requested);
  const selectedName = String(selected?.wilaya_name ?? "").trim();
  if (!selectedName) return requested;

  const key = normalizeWilayaName(selectedName);
  const preferred = wilayas.find((row) => {
    const id = String(row.wilaya_id ?? "").trim();
    const name = String(row.wilaya_name ?? "").trim();
    if (!id || !name || isSeedWilayaId(id)) return false;
    return normalizeWilayaName(name) === key;
  });

  return String(preferred?.wilaya_id ?? requested);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  let cursor: unknown = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }

    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

function firstString(record: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, paths: string[]): number | null {
  for (const path of paths) {
    const value = readPath(record, path);
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveCollection(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }

  const sources = [
    payload.data,
    payload.items,
    payload.results,
    readPath(payload, "data.items"),
    readPath(payload, "data.results"),
    readPath(payload, "data.data"),
    readPath(payload, "result.data"),
  ];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    return source.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  return [];
}

function buildProviderHeaders(account: Account): Record<string, string> {
  const creds = account.credentials ?? {};
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (account.provider === "yalidine") {
    if (creds.apiKey || creds.key) {
      headers[creds.headerName || "X-API-TOKEN"] = creds.apiKey || creds.key || "";
    }
    if (creds.tenantId) {
      headers["X-API-ID"] = creds.tenantId;
    }
  } else if (account.provider === "zr_express") {
    if (creds.apiKey || creds.secretKey || creds.key || creds.token) {
      headers[creds.headerName || creds.secretHeaderName || "X-Api-Key"] = creds.apiKey || creds.secretKey || creds.key || creds.token || "";
    }
    if (creds.tenantId || creds.tenant) {
      headers[creds.tenantHeaderName || "X-Tenant"] = creds.tenantId || creds.tenant || "";
    }
  } else if (account.provider === "procolis") {
    const token = String(creds.token ?? creds.apiToken ?? "").trim();
    const key = String(creds.key ?? creds.apiKey ?? creds.secretKey ?? "").trim();
    if (token) {
      headers.token = token;
    }
    if (key) {
      headers.key = key;
    }
  } else if (creds.apiKey || creds.key || creds.token) {
    headers[creds.headerName || "Authorization"] = creds.apiKey || creds.key || creds.token || "";
  }

  const custom = creds.customHeaders;
  if (custom) {
    try {
      const parsed = JSON.parse(custom) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        headers[key] = value;
      }
    } catch {
      // Ignore malformed custom headers.
    }
  }

  return headers;
}

// Per-request abort timeout. Bounds a single fetch() so a hung TCP connection
// fails in ≤ this many ms instead of waiting for the OS TCP timeout (~120 s).
// This is a ceiling, not a goal — fast responses resolve well before this fires.
const PROVIDER_FETCH_TIMEOUT_MS = 12_000;

async function fetchProvider(
  account: Account,
  endpoint: string,
  options?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
) {
  const url = (() => {
    if (/^https?:\/\//i.test(endpoint)) {
      return endpoint;
    }
    const base = account.base_url.endsWith("/") ? account.base_url : `${account.base_url}/`;
    const normalizedEndpoint = endpoint.replace(/^\/+/, "");
    return new URL(normalizedEndpoint, base).toString();
  })();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options?.method ?? "GET",
      headers: buildProviderHeaders(account),
      body: options?.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const parseNumericHeader = (name: string): number | null => {
    const raw = response.headers.get(name);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const parseRetryAfterSeconds = (): number | null => {
    const raw = response.headers.get("retry-after");
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.max(0, Math.ceil(numeric));
    }
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) {
      const diffMs = asDate - Date.now();
      return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
    }
    return null;
  };

  const quotaHeaders = {
    secondLeft: parseNumericHeader("x-second-quota-left"),
    minuteLeft: parseNumericHeader("x-minute-quota-left"),
    hourLeft: parseNumericHeader("x-hour-quota-left"),
    dayLeft: parseNumericHeader("x-day-quota-left"),
    retryAfter: parseRetryAfterSeconds(),
  };

  if (account.provider === "yalidine") {
    if (context?.requestCounter) {
      context.requestCounter.count += 1;
    }
    console.info("yalidine_external_api_call", {
      merchant_id: account.merchant_id,
      provider: account.provider,
      endpoint: url,
      trigger_source: context?.triggerSource ?? "unknown",
      request_count: context?.requestCounter?.count ?? null,
      cooldown_status: context?.cooldownStatus ?? "allowed",
      quota_second_left: quotaHeaders.secondLeft,
      quota_minute_left: quotaHeaders.minuteLeft,
      quota_hour_left: quotaHeaders.hourLeft,
      quota_day_left: quotaHeaders.dayLeft,
      retry_after_seconds: quotaHeaders.retryAfter,
    });
  }

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (account.provider === "yalidine" && response.status === 429) {
      throw new YalidineQuotaError({
        endpoint: url,
        retryAfterSeconds: quotaHeaders.retryAfter,
        quota: {
          secondLeft: quotaHeaders.secondLeft,
          minuteLeft: quotaHeaders.minuteLeft,
          hourLeft: quotaHeaders.hourLeft,
          dayLeft: quotaHeaders.dayLeft,
        },
      });
    }
    throw new Error(`provider_cache_sync_failed_${account.provider}_${response.status}`);
  }
  return json;
}

function normalizeWilayas(payload: Record<string, unknown>): WilayaRow[] {
  return resolveCollection(payload)
    .map((item) => ({
      wilaya_id: firstString(item, ["id", "wilaya_id", "code", "wilayaCode"]) ?? "",
      wilaya_name: firstString(item, ["name", "wilaya_name", "wilayaName", "label"]) ?? "",
    }))
    .filter((item) => item.wilaya_id && item.wilaya_name);
}

function normalizeCommunes(payload: Record<string, unknown>): CommuneRow[] {
  return resolveCollection(payload)
    .map((item) => ({
      wilaya_id: firstString(item, [
        "wilaya_id",
        "wilayaId",
        "wilaya.id",
        "city_id",
        "cityTerritoryId",
        "parentId",
      ]) ?? "",
      commune_id: firstString(item, [
        "commune_id",
        "communeId",
        "commune.id",
        "districtTerritoryId",
        "district.id",
        "id",
        "code",
      ]) ?? "",
      commune_name: firstString(item, [
        "commune_name",
        "communeName",
        "commune",
        "district",
        "district.name",
        "name",
        "label",
      ]) ?? "",
    }))
    .filter((item) => item.wilaya_id && item.commune_id && item.commune_name);
}

function normalizeStopdesks(payload: Record<string, unknown>): StopdeskRow[] {
  return resolveCollection(payload)
    .map((item) => ({
      wilaya_id: firstString(item, ["wilaya_id", "wilayaId", "cityTerritoryId", "city.id"]),
      wilaya_name: firstString(item, ["wilaya_name", "wilayaName", "city.name"]),
      commune_id: firstString(item, ["commune_id", "communeId", "districtTerritoryId", "district.id"]),
      commune_name: firstString(item, ["commune_name", "communeName", "commune", "district.name"]),
      office_id: firstString(item, ["id", "office_id", "center_id", "pickupBagId", "code"]) ?? "",
      office_name: firstString(item, ["name", "office_name", "center_name", "agency_name", "label"]) ?? "",
    }))
    .filter((item) => item.office_id && item.office_name);
}

function normalizePrices(payload: Record<string, unknown>): PriceRow[] {
  return resolveCollection(payload)
    .map((item) => ({
      wilaya_id: firstString(item, ["wilaya_id", "wilayaId", "cityTerritoryId", "city.id"]) ?? "",
      wilaya_name: firstString(item, ["wilaya_name", "wilayaName", "city.name"]),
      commune_id: firstString(item, ["commune_id", "communeId", "districtTerritoryId", "district.id"]),
      commune_name: firstString(item, ["commune_name", "communeName", "district.name"]),
      office_id: firstString(item, ["office_id", "officeId", "center_id", "pickupBagId"]),
      office_name: firstString(item, ["office_name", "officeName", "center_name"]),
      home_price: firstNumber(item, [
        "home_price",
        "homePrice",
        "homeDeliveryPrice",
        "domicile",
        "delivery_price",
        "deliveryPrice",
        "price_home",
        "priceHome",
      ]),
      stopdesk_price: firstNumber(item, [
        "stopdesk_price",
        "stopdeskPrice",
        "pickupPointPrice",
        "desk_price",
        "price_stopdesk",
        "pickup_price",
        "pickupPrice",
      ]),
    }))
    .filter((item) => item.wilaya_id && (item.home_price !== null || item.stopdesk_price !== null));
}

function mergePriceRowsByWilayaCommune(rows: PriceRow[]): PriceRow[] {
  const byKey = new Map<string, PriceRow>();
  for (const row of rows) {
    const wilayaId = String(row.wilaya_id ?? "").trim();
    if (!wilayaId) {
      continue;
    }

    const communeId = String(row.commune_id ?? "").trim();
    const key = `${wilayaId}|${communeId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row });
      continue;
    }

    byKey.set(key, {
      ...existing,
      wilaya_name: existing.wilaya_name ?? row.wilaya_name ?? null,
      commune_name: existing.commune_name ?? row.commune_name ?? null,
      office_id: existing.office_id ?? row.office_id ?? null,
      office_name: existing.office_name ?? row.office_name ?? null,
      home_price: existing.home_price ?? row.home_price,
      stopdesk_price: existing.stopdesk_price ?? row.stopdesk_price,
    });
  }

  return Array.from(byKey.values());
}

function resolveYalidineOriginWilayaIdFromCredentials(account: Account): string | null {
  const credentials = asObject(account.credentials ?? {});
  const candidate = firstString(credentials, [
    "from_wilaya_id",
    "fromWilayaId",
    "origin_wilaya_id",
    "originWilayaId",
    "store_origin_wilaya_id",
    "storeOriginWilayaId",
    "sender_wilaya_id",
    "senderWilayaId",
    "wilaya_id",
  ]);
  if (!candidate) {
    return null;
  }

  const normalized = String(candidate).trim();
  return /^[0-9]{1,3}$/.test(normalized) ? normalized : null;
}

async function resolveYalidineOriginWilayaId(account: Account, wilayas: WilayaRow[]): Promise<string> {
  const fromCredentials = resolveYalidineOriginWilayaIdFromCredentials(account);
  if (fromCredentials) {
    return fromCredentials;
  }

  try {
    const supabase = createClient();
    const { data } = await supabase
      .from("shipping_origins")
      .select("wilaya_id")
      .eq("merchant_id", account.merchant_id)
      .eq("provider", "yalidine")
      .order("is_default", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const fromOrigin = String((data as { wilaya_id?: string | null } | null)?.wilaya_id ?? "").trim();
    if (/^[0-9]{1,3}$/.test(fromOrigin)) {
      return fromOrigin;
    }
  } catch {
    // Ignore optional shipping origin lookup failures and surface a clear configuration error below.
  }

  try {
    const supabase = createClient();
    const { data } = await supabase
      .from("merchant_shipping_profiles")
      .select("from_wilaya_name")
      .eq("merchant_id", account.merchant_id)
      .maybeSingle();

    const fromWilayaName = String((data as { from_wilaya_name?: string | null } | null)?.from_wilaya_name ?? "").trim();
    if (fromWilayaName) {
      const normalized = normalizeWilayaName(fromWilayaName);
      const matched = wilayas.find((row) => normalizeWilayaName(row.wilaya_name) === normalized);
      const matchedId = String(matched?.wilaya_id ?? "").trim();
      if (/^[0-9]{1,3}$/.test(matchedId)) {
        return matchedId;
      }
    }
  } catch {
    // Ignore optional profile lookup failures and surface a clear configuration error below.
  }

  console.warn("yalidine_origin_wilaya_fallback_default", {
    merchant_id: account.merchant_id,
    account_id: account.id,
    fallback_from_wilaya_id: "16",
  });
  return "16";
}

async function resolveYalidineDepartureCenterId(merchantId: string): Promise<string> {
  try {
    const supabase = createClient();
    const { data } = await supabase
      .from("shipping_origins")
      .select("wilaya_id")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .order("is_default", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Use wilaya_id (e.g. "16") so departure_center_id matches what the checkout
    // queries: shipping_origins.wilaya_id. The old office_id (center ID like "161501")
    // was wrong — the checkout never matched it.
    const wilayaId = String((data as { wilaya_id?: string | null } | null)?.wilaya_id ?? "").trim();
    return wilayaId || "";
  } catch {
    return "";
  }
}

function buildEndpointWithQuery(endpoint: string, query: Record<string, string | number>): string {
  const clean = String(endpoint ?? "").trim();
  const base = clean.length > 0 ? clean : "/v1/fees/";
  const separator = base.includes("?") ? "&" : "?";
  const search = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${base}${separator}${search}`;
}

function normalizeYalidineFeesPrices(params: {
  payload: Record<string, unknown>;
  destinationWilayaId: string;
  communesById: Map<string, CommuneRow>;
  wilayaNameById: Map<string, string>;
}): PriceRow[] {
  const perCommune = asObject(
    readPath(params.payload, "per_commune")
    ?? readPath(params.payload, "data.per_commune")
    ?? readPath(params.payload, "fees.per_commune")
    ?? {}
  );

  const rows: PriceRow[] = [];
  for (const [rawCommuneId, rawFee] of Object.entries(perCommune)) {
    const communeId = String(rawCommuneId ?? "").trim();
    if (!communeId) {
      continue;
    }

    const fee = asObject(rawFee);
    const homeCandidate = firstNumber(fee, ["express_home", "home", "home_price", "price_home"]);
    const stopdeskCandidate = firstNumber(fee, ["express_desk", "desk", "stopdesk_price", "price_stopdesk"]);
    const homePrice = homeCandidate !== null && homeCandidate > 0 ? homeCandidate : null;
    const stopdeskPrice = stopdeskCandidate !== null && stopdeskCandidate > 0 ? stopdeskCandidate : null;
    if (homePrice === null && stopdeskPrice === null) {
      continue;
    }

    const commune = params.communesById.get(communeId);
    const wilayaId = String(commune?.wilaya_id ?? params.destinationWilayaId).trim();
    rows.push({
      wilaya_id: wilayaId,
      wilaya_name: params.wilayaNameById.get(wilayaId) ?? null,
      commune_id: communeId,
      commune_name: commune?.commune_name ?? null,
      office_id: null,
      office_name: null,
      home_price: homePrice,
      stopdesk_price: stopdeskPrice,
    });
  }

  return rows;
}

function buildYalidinePriceCoverage(prices: PriceRow[]) {
  const home = new Set<string>();
  const stopdesk = new Set<string>();

  for (const row of prices) {
    const wilayaId = String(row.wilaya_id ?? "").trim();
    if (!/^[0-9]{1,3}$/.test(wilayaId)) {
      continue;
    }

    const homePrice = Number(row.home_price ?? null);
    if (Number.isFinite(homePrice) && homePrice > 0) {
      home.add(wilayaId);
    }

    const stopdeskPrice = Number(row.stopdesk_price ?? null);
    if (Number.isFinite(stopdeskPrice) && stopdeskPrice > 0) {
      stopdesk.add(wilayaId);
    }
  }

  return { home, stopdesk };
}

function collectYalidineMissingWilayas(coverage: { home: Set<string>; stopdesk: Set<string> }): string[] {
  const missing: string[] = [];
  for (let destination = 1; destination <= YALIDINE_WILAYA_TARGET_COUNT; destination += 1) {
    const wilayaId = String(destination);
    if (!coverage.home.has(wilayaId) || !coverage.stopdesk.has(wilayaId)) {
      missing.push(wilayaId);
    }
  }
  return missing;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchYalidineFeesForDestination(params: {
  account: Account;
  endpoint: string;
  originWilayaId: string;
  destinationWilayaId: string;
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  };
}) {
  for (let attempt = 1; attempt <= YALIDINE_FEES_DESTINATION_MAX_ATTEMPTS; attempt += 1) {
    const endpoint = buildEndpointWithQuery(params.endpoint, {
      from_wilaya_id: params.originWilayaId,
      to_wilaya_id: params.destinationWilayaId,
    });

    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetchProviderWithRetry(params.account, endpoint, undefined, params.context);
    } catch (error) {
      if (error instanceof YalidineQuotaError) {
        throw error;
      }

      if (attempt >= YALIDINE_FEES_DESTINATION_MAX_ATTEMPTS) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt * 250);
    }
  }

  return {} as Record<string, unknown>;
}

async function fetchProviderWithRetry(
  account: Account,
  endpoint: string,
  options?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
) {
  for (let attempt = 1; attempt <= YALIDINE_PROVIDER_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetchProvider(account, endpoint, options, context);
    } catch (error) {
      if (attempt >= YALIDINE_PROVIDER_FETCH_MAX_ATTEMPTS) {
        throw error;
      }

      let waitMs = Math.min(YALIDINE_PROVIDER_FETCH_MAX_WAIT_MS, attempt * 500);
      if (error instanceof YalidineQuotaError) {
        const retryAfterMs = error.retryAfterSeconds !== null
          ? Math.max(1000, error.retryAfterSeconds * 1000)
          : 1000;
        waitMs = Math.min(YALIDINE_PROVIDER_FETCH_MAX_WAIT_MS, retryAfterMs);
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
    }
  }

  throw new Error("yalidine_provider_retry_exhausted");
}

async function fetchYalidineFeesPrices(
  account: Account,
  optional: Record<string, unknown>,
  communes: CommuneRow[],
  wilayas: WilayaRow[],
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
): Promise<PriceRow[]> {
  const originWilayaId = await resolveYalidineOriginWilayaId(account, wilayas);
  const feesEndpoint = String(optional.fees ?? optional.fee ?? "/v1/fees/").trim() || "/v1/fees/";
  const communesById = new Map(communes.map((row) => [row.commune_id, row] as const));
  const wilayaNameById = new Map(wilayas.map((row) => [row.wilaya_id, row.wilaya_name] as const));
  const rowsByKey = new Map<string, PriceRow>();

  let pendingWilayas = new Set<string>(
    Array.from({ length: YALIDINE_WILAYA_TARGET_COUNT }, (_, idx) => String(idx + 1)),
  );

  for (let round = 1; round <= YALIDINE_FEES_SYNC_MAX_ROUNDS; round += 1) {
    if (pendingWilayas.size === 0) {
      break;
    }

    const currentRoundDestinations = [...pendingWilayas].sort((a, b) => Number(a) - Number(b));

    let roundRowsAdded = 0;
    for (const destinationWilayaId of currentRoundDestinations) {
      // eslint-disable-next-line no-await-in-loop
      const payload = await fetchYalidineFeesForDestination({
        account,
        endpoint: feesEndpoint,
        originWilayaId,
        destinationWilayaId,
        context,
      });


      const rows = normalizeYalidineFeesPrices({
        payload,
        destinationWilayaId,
        communesById,
        wilayaNameById,
      });

      roundRowsAdded += rows.length;
      for (const row of rows) {
        const key = `${row.wilaya_id}|${row.commune_id ?? ""}`;
        if (!rowsByKey.has(key)) {
          rowsByKey.set(key, row);
          continue;
        }

        const existing = rowsByKey.get(key)!;
        rowsByKey.set(key, {
          ...existing,
          home_price: existing.home_price ?? row.home_price,
          stopdesk_price: existing.stopdesk_price ?? row.stopdesk_price,
        });
      }
    }

    const coverage = buildYalidinePriceCoverage(Array.from(rowsByKey.values()));
    pendingWilayas = new Set(collectYalidineMissingWilayas(coverage));

  }

  return Array.from(rowsByKey.values());
}

function assertYalidinePriceCoverageBeforeWrite(params: {
  account: Account;
  prices: PriceRow[];
}) {
  const nonPositiveRows = params.prices.filter((row) => {
    // Only flag explicitly non-positive values — null means "no data" and is valid.
    const home = row.home_price !== null && row.home_price !== undefined ? Number(row.home_price) : null;
    const stopdesk = row.stopdesk_price !== null && row.stopdesk_price !== undefined ? Number(row.stopdesk_price) : null;
    const hasNonPositiveHome = home !== null && Number.isFinite(home) && home <= 0;
    const hasNonPositiveStopdesk = stopdesk !== null && Number.isFinite(stopdesk) && stopdesk <= 0;
    return hasNonPositiveHome || hasNonPositiveStopdesk;
  });

  if (nonPositiveRows.length > 0) {
    throw new Error(`yalidine_sync_incomplete:contains_non_positive_prices:${nonPositiveRows.length}`);
  }

  const coverage = buildYalidinePriceCoverage(params.prices);
  const missingWilayas = collectYalidineMissingWilayas(coverage);
  // Only block if NO wilaya has coverage at all — partial coverage (some wilayas
  // genuinely have no Yalidine service) is valid and should not block the write.
  if (missingWilayas.length >= YALIDINE_WILAYA_TARGET_COUNT) {
    throw new Error(
      `yalidine_sync_incomplete:missing_wilaya_prices:${missingWilayas.length}:${missingWilayas.slice(0, 30).join(",")}`,
    );
  }
}

function normalizeZrTerritoryPrices(rows: Record<string, unknown>[]): PriceRow[] {
  return rows
    .filter((row) => String(firstString(row, ["level"]) ?? "").toLowerCase() === "commune")
    .map((row) => {
      const deliveryPayload = asObject(readPath(row, "delivery") as Record<string, unknown> | undefined);
      const hasHome = Boolean(readPath(deliveryPayload, "hasHomeDelivery"));
      const hasPickup = Boolean(readPath(deliveryPayload, "hasPickupPoint"));
      const homePrice = firstNumber(deliveryPayload, [
        "homePrice",
        "home_price",
        "homeDeliveryPrice",
        "priceHome",
        "price_home",
        "deliveryPrice",
        "delivery_price",
      ]) ?? firstNumber(row, [
        "homePrice",
        "home_price",
        "homeDeliveryPrice",
        "domicile",
        "deliveryPrice",
        "delivery_price",
        "priceHome",
        "price_home",
      ]);
      const stopdeskPrice = firstNumber(deliveryPayload, [
        "stopdeskPrice",
        "stopdesk_price",
        "pickupPointPrice",
        "pickupPrice",
        "pickup_price",
        "deskPrice",
        "desk_price",
      ]) ?? firstNumber(row, [
        "stopdeskPrice",
        "stopdesk_price",
        "pickupPointPrice",
        "pickupPrice",
        "pickup_price",
        "deskPrice",
        "desk_price",
      ]);

      return {
        wilaya_id: firstString(row, ["parentId"]) ?? "",
        wilaya_name: null,
        commune_id: firstString(row, ["id"]) ?? null,
        commune_name: firstString(row, ["name"]) ?? null,
        office_id: null,
        office_name: null,
        // Never force zero when provider only signals capability flags.
        home_price: homePrice !== null ? homePrice : (hasHome ? null : null),
        stopdesk_price: stopdeskPrice !== null ? stopdeskPrice : (hasPickup ? null : null),
      } as PriceRow;
    })
    .filter((row) => row.wilaya_id && (row.home_price !== null || row.stopdesk_price !== null));
}

function normalizeZrRates(
  payload: Record<string, unknown>,
  districts: Record<string, unknown>[],
  wilayas: WilayaRow[],
): PriceRow[] {
  const districtById = new Map(
    districts.map((row) => {
      const communeId = firstString(row, ["id"]) ?? "";
      return [communeId, row] as const;
    }).filter(([communeId]) => communeId),
  );
  const wilayaNameById = new Map(
    wilayas
      .map((row) => [row.wilaya_id, row.wilaya_name] as const)
      .filter(([wilayaId, wilayaName]) => wilayaId && wilayaName),
  );
  const districtIdsByWilayaId = new Map<string, string[]>();
  for (const row of districts) {
    const parentId = firstString(row, ["parentId"]) ?? "";
    const districtId = firstString(row, ["id"]) ?? "";
    if (!parentId || !districtId) {
      continue;
    }
    const existing = districtIdsByWilayaId.get(parentId) ?? [];
    existing.push(districtId);
    districtIdsByWilayaId.set(parentId, existing);
  }
  const wilayaIds = new Set(wilayas.map((row) => row.wilaya_id).filter(Boolean));

  const rates = asArray(payload.rates)
    .concat(asArray(payload.items))
    .concat(asArray(payload.data))
    .concat(asArray(payload.rows))
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");

  const expandedRates: Record<string, unknown>[] = [];
  for (const item of rates) {
    const rawTargetId = firstString(item, ["toTerritoryId", "territoryId", "toId", "id"]) ?? "";
    const explicitDistrictId = firstString(item, ["districtTerritoryId", "communeId", "toDistrictId", "destinationDistrictId"]);
    if (explicitDistrictId) {
      expandedRates.push({ ...item, toTerritoryId: explicitDistrictId });
      continue;
    }

    if (rawTargetId && wilayaIds.has(rawTargetId)) {
      const districtIds = districtIdsByWilayaId.get(rawTargetId) ?? [];
      if (districtIds.length > 0) {
        for (const districtId of districtIds) {
          expandedRates.push({ ...item, toTerritoryId: districtId });
        }
        continue;
      }
    }

    expandedRates.push(item);
  }

  return expandedRates
    .map((item) => {
      const communeId = firstString(item, ["toTerritoryId", "territoryId", "toId", "id"]) ?? "";
      const district = districtById.get(communeId) ?? null;
      const deliveryPrices = asArray(item.deliveryPrices)
        .concat(asArray(item.prices))
        .concat(asArray(item.delivery_rates))
        .concat(asArray(item.tariffs))
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");

      const homePriceRow = deliveryPrices.find((row) => {
        const type = String(firstString(row, ["deliveryType"]) ?? "").toLowerCase();
        return type === "home" || type === "home-delivery" || type === "home_delivery";
      });
      const pickupPriceRow = deliveryPrices.find((row) => {
        const type = String(firstString(row, ["deliveryType"]) ?? "").toLowerCase();
        return type === "pickup-point" || type === "pickup_point" || type === "stopdesk" || type === "pickup";
      });

      const inlineHomePrice = firstNumber(item, ["homePrice", "home_price", "priceHome", "deliveryPrice", "delivery_price"]);
      const inlineStopdeskPrice = firstNumber(item, ["stopdeskPrice", "stopdesk_price", "pickupPrice", "pickup_price", "priceStopdesk"]);
      const homePrice = firstNumber(homePriceRow ?? {}, ["discountedPrice", "price", "amount", "value", "cost"])
        ?? inlineHomePrice;
      const stopdeskPrice = firstNumber(pickupPriceRow ?? {}, ["discountedPrice", "price", "amount", "value", "cost"])
        ?? inlineStopdeskPrice;
      const districtParentId = firstString(district ?? {}, ["parentId"]) ?? "";

      return {
        wilaya_id: districtParentId,
        wilaya_name: wilayaNameById.get(districtParentId) ?? null,
        commune_id: communeId || null,
        commune_name: firstString(item, ["toTerritoryName"]) ?? firstString(district ?? {}, ["name"]),
        office_id: null,
        office_name: null,
        home_price: homePrice,
        stopdesk_price: stopdeskPrice,
      } satisfies PriceRow;
    })
    .filter((row) => row.wilaya_id && (row.home_price !== null || row.stopdesk_price !== null));
}

function pickBestCachedPrice(
  rows: Array<{ home_price: number | null; stopdesk_price: number | null }>,
  deliveryType: "home" | "stopdesk",
): number {
  const key = deliveryType === "stopdesk" ? "stopdesk_price" : "home_price";
  const positive = rows
    .map((row) => Number(row[key] ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (positive.length > 0) {
    return positive[0] as number;
  }

  const nonNegative = rows
    .map((row) => Number(row[key] ?? 0))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return nonNegative.length > 0 ? (nonNegative[0] as number) : 0;
}

function resolveRankedPriceCandidate(
  rows: Array<{
    wilaya_id?: string | null;
    commune_id?: string | null;
    office_id?: string | null;
    home_price: number | null;
    stopdesk_price: number | null;
    wilaya_name: string | null;
    commune_name: string | null;
    office_name: string | null;
  }>,
  params: {
    deliveryType: "home" | "stopdesk";
    communeId?: string | null;
    officeId?: string | null;
  },
) {
  const targetCommuneId = String(params.communeId ?? "").trim();
  const targetOfficeId = String(params.officeId ?? "").trim();

  const scoped = rows.filter((row) => {
    const rowCommune = String(row.commune_id ?? "").trim();
    const rowOffice = String(row.office_id ?? "").trim();

    if (params.deliveryType === "stopdesk") {
      if (targetOfficeId && rowOffice === targetOfficeId) return true;
      if (targetCommuneId && rowCommune === targetCommuneId) return true;
      return !rowCommune;
    }

    if (targetCommuneId && rowCommune === targetCommuneId) return true;
    return !rowCommune;
  });

  const candidateRows = scoped.length > 0 ? scoped : rows;
  if (candidateRows.length === 0) {
    return { row: null, price: null };
  }

  const key = params.deliveryType === "stopdesk" ? "stopdesk_price" : "home_price";
  const rank = (row: {
    commune_id?: string | null;
    office_id?: string | null;
    home_price: number | null;
    stopdesk_price: number | null;
  }) => {
    const rowCommune = String(row.commune_id ?? "").trim();
    const rowOffice = String(row.office_id ?? "").trim();

    if (params.deliveryType === "stopdesk") {
      if (targetOfficeId && rowOffice === targetOfficeId) return 1;
      if (targetCommuneId && rowCommune === targetCommuneId) return 2;
      if (!rowCommune) return 3;
      return 4;
    }

    if (targetCommuneId && rowCommune === targetCommuneId) return 1;
    if (!rowCommune) return 2;
    return 3;
  };

  const sorted = [...candidateRows].sort((a, b) => rank(a) - rank(b));
  const priced = sorted.find((row) => {
    const value = Number(row[key] ?? null);
    return Number.isFinite(value) && value > 0;
  });
  if (priced) {
    return {
      row: priced,
      price: Number(priced[key] ?? 0),
    };
  }

  return { row: sorted[0] ?? null, price: null };
}

async function upsertProviderSyncMarker(provider: string, syncedAt: string) {
  const supabase = createClient();
  const primary = await supabase
    .from("delivery_providers")
    .update({
      last_sync_at: syncedAt,
      updated_at: syncedAt,
    })
    .eq("code", provider);

  if (!primary.error) {
    return;
  }

  // Older deployments may not yet have last_sync_at/updated_at columns.
  const fallback = await supabase
    .from("delivery_providers")
    .update({
      is_active: true,
    })
    .eq("code", provider);

  if (fallback.error && fallback.error.code !== "42703") {
    throw new Error(`delivery_provider_sync_marker_failed:${fallback.error.code ?? "unknown"}`);
  }
}

function assertWrite(result: { error: { code?: string; message: string } | null }, table: string) {
  if (!result.error) {
    return;
  }
  throw new Error(`delivery_cache_write_failed:${table}:${result.error.code ?? "unknown"}:${result.error.message}`);
}

function isMissingRelationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("42P01") || message.includes("Could not find the table");
}

function parseYalidineFailureTimestamp(message: string | null | undefined): number {
  const raw = String(message ?? "");
  const idx = raw.indexOf(YALIDINE_FAILURE_MARKER);
  if (idx < 0) {
    return 0;
  }

  const stamped = raw.slice(idx + YALIDINE_FAILURE_MARKER.length).split("|")[0]?.trim() ?? "";
  const parsed = Date.parse(stamped);
  return Number.isFinite(parsed) ? parsed : 0;
}

function withYalidineFailureMarker(message: string, nowIso = new Date().toISOString()): string {
  return `${YALIDINE_FAILURE_MARKER}${nowIso}|${message}`;
}

function extractYalidineFailureMessage(message: string | null | undefined): string | null {
  const raw = String(message ?? "").trim();
  if (!raw) {
    return null;
  }

  const idx = raw.indexOf("|");
  if (raw.startsWith(YALIDINE_FAILURE_MARKER) && idx >= 0) {
    const extracted = raw.slice(idx + 1).trim();
    return extracted || null;
  }

  return raw;
}

async function hasProcessingYalidineSyncJob(params: {
  merchantId: string;
  provider: string;
  excludeJobId?: string;
}): Promise<boolean> {
  const supabase = createClient();
  const { data } = await supabase
    .from("background_jobs")
    .select("id,payload")
    .eq("type", "sync_delivery_cache")
    .eq("merchant_id", params.merchantId)
    .eq("status", "processing")
    .order("created_at", { ascending: false })
    .limit(20);

  const jobs = (data ?? []) as Array<{ id: string; payload?: Record<string, unknown> | null }>;
  return jobs.some((job) => {
    if (params.excludeJobId && job.id === params.excludeJobId) {
      return false;
    }
    const payload = asObject(job.payload ?? {});
    return String(payload.provider ?? "") === params.provider;
  });
}

export async function getYalidineSyncStatus(merchantId: string): Promise<YalidineSyncStatus> {
  const supabase = createClient();
  const nowMs = Date.now();

  const { data: account } = await supabase
    .from("merchant_delivery_accounts")
    .select("id,last_sync_at,last_error_message,provider")
    .eq("merchant_id", merchantId)
    .eq("provider", "yalidine")
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const failureMs = parseYalidineFailureTimestamp((account as { last_error_message?: string | null } | null)?.last_error_message ?? null);
  const cooldownUntilMs = failureMs > 0
    ? failureMs + YALIDINE_SYNC_COOLDOWN_MS
    : (((account as { last_sync_at?: string | null } | null)?.last_sync_at
      ? new Date(String((account as { last_sync_at?: string | null } | null)?.last_sync_at)).getTime() + YALIDINE_SYNC_COOLDOWN_MS
      : 0));

  const running = account?.id
    ? await hasProcessingYalidineSyncJob({
        merchantId,
        provider: "yalidine",
      })
    : false;

  if (running) {
    return {
      status: "running",
      last_sync_at: (account as { last_sync_at?: string | null } | null)?.last_sync_at ?? null,
      error_message: extractYalidineFailureMessage((account as { last_error_message?: string | null } | null)?.last_error_message ?? null),
      cooldown_until: null,
    };
  }

  const hasCooldown = cooldownUntilMs > nowMs;
  if (hasCooldown) {
    return {
      status: "cooldown",
      last_sync_at: (account as { last_sync_at?: string | null } | null)?.last_sync_at ?? null,
      error_message: extractYalidineFailureMessage((account as { last_error_message?: string | null } | null)?.last_error_message ?? null),
      cooldown_until: new Date(cooldownUntilMs).toISOString(),
    };
  }

  const hasLastSync = Boolean((account as { last_sync_at?: string | null } | null)?.last_sync_at);
  const hasError = Boolean(extractYalidineFailureMessage((account as { last_error_message?: string | null } | null)?.last_error_message ?? null));
  return {
    status: hasError ? "failed" : (hasLastSync ? "success" : "idle"),
    last_sync_at: (account as { last_sync_at?: string | null } | null)?.last_sync_at ?? null,
    error_message: extractYalidineFailureMessage((account as { last_error_message?: string | null } | null)?.last_error_message ?? null),
    cooldown_until: null,
  };
}

export async function enqueueQuotaSafeYalidineSync(params: {
  merchantId: string;
  triggerSource?: SyncTriggerSource;
  bypassCooldown?: boolean;
}): Promise<YalidineSyncQueueResult> {
  const sync = await getYalidineSyncStatus(params.merchantId);
  if (sync.status === "running") {
    return { status: "already_running", jobId: null, sync };
  }
  if (sync.status === "cooldown" && !params.bypassCooldown) {
    return { status: "cooldown_active", jobId: null, sync };
  }

  const supabase = createClient();
  const { data: pending } = await supabase
    .from("background_jobs")
    .select("id,payload")
    .eq("type", "sync_delivery_cache")
    .eq("merchant_id", params.merchantId)
    .in("status", ["pending", "processing"])
    .order("created_at", { ascending: false })
    .limit(20);

  const pendingJobs = (pending ?? []) as Array<{ id: string; payload?: Record<string, unknown> | null }>;
  const duplicate = pendingJobs.find((job) => String(asObject(job.payload ?? {}).provider ?? "") === "yalidine");
  if (duplicate) {
    return {
      status: "already_running",
      jobId: duplicate.id,
      sync: {
        ...sync,
        status: "running",
      },
    };
  }

  const jobId = await enqueueBackgroundJob({
    type: "sync_delivery_cache",
    merchantId: params.merchantId,
    payload: {
      provider: "yalidine",
      force: true,
      source: params.triggerSource ?? "unknown",
    },
  });

  return {
    status: "queued",
    jobId,
    sync: {
      ...sync,
      status: "running",
    },
  };
}

async function upsertCacheRows(params: {
  account: Account;
  syncedAt: string;
  wilayas: WilayaRow[];
  communes: CommuneRow[];
  stopdesks: StopdeskRow[];
  prices: PriceRow[];
  // NOTE: departureCenterId is the ORIGIN WILAYA ID (e.g. "16"), not the physical
  // Yalidine office/center ID. It maps to delivery_prices.departure_center_id.
  departureCenterId?: string;
}) {
  const supabase = createClient();
  const provider = params.account.provider;
  const merchantId = params.account.merchant_id;
  const accountId = params.account.id;
  // departure_center_id = origin wilaya ID. See field-level comment above.
  const departureCenterId = params.departureCenterId ?? "";

  // Build wilaya-name lookup before firing parallel writes.
  const wilayaNameById = new Map(params.wilayas.map((row) => [row.wilaya_id, row.wilaya_name]));

  // Geo tables are independent — run all three upserts in parallel to reduce
  // wall-clock time. Each assertWrite call will throw on write failure.
  await Promise.all([
    params.wilayas.length > 0
      ? supabase.from("delivery_wilayas").upsert(
          params.wilayas.map((row) => ({
            merchant_id: merchantId,
            account_id: accountId,
            provider,
            provider_code: provider,
            wilaya_id: row.wilaya_id,
            wilaya_name: row.wilaya_name,
            last_sync_at: params.syncedAt,
            updated_at: params.syncedAt,
          })),
          { onConflict: "merchant_id,provider,wilaya_id" }
        ).then((r) => assertWrite(r, "delivery_wilayas"))
      : Promise.resolve(),

    params.communes.length > 0
      ? supabase.from("delivery_communes").upsert(
          params.communes.map((row) => ({
            merchant_id: merchantId,
            account_id: accountId,
            provider,
            provider_code: provider,
            wilaya_id: row.wilaya_id,
            wilaya_name: wilayaNameById.get(row.wilaya_id) ?? null,
            commune_id: row.commune_id,
            commune_name: row.commune_name,
            last_sync_at: params.syncedAt,
            updated_at: params.syncedAt,
          })),
          { onConflict: "merchant_id,provider,commune_id" }
        ).then((r) => assertWrite(r, "delivery_communes"))
      : Promise.resolve(),

    params.stopdesks.length > 0
      ? supabase.from("delivery_stopdesks").upsert(
          params.stopdesks.map((row) => ({
            merchant_id: merchantId,
            account_id: accountId,
            provider,
            provider_code: provider,
            wilaya_id: row.wilaya_id ?? null,
            wilaya_name: row.wilaya_name ?? null,
            commune_id: row.commune_id ?? null,
            commune_name: row.commune_name ?? null,
            office_id: row.office_id,
            office_name: row.office_name,
            last_sync_at: params.syncedAt,
            updated_at: params.syncedAt,
          })),
          { onConflict: "merchant_id,provider,office_id" }
        ).then((r) => assertWrite(r, "delivery_stopdesks"))
      : Promise.resolve(),
  ]);

  if (params.prices.length > 0) {
    // Purge only rows for this specific departure center to avoid clearing other centers' prices.
    const purgeResult = await supabase
      .from("delivery_prices")
      .delete()
      .eq("merchant_id", merchantId)
      .eq("provider", provider)
      .eq("departure_center_id", departureCenterId);
    assertWrite(purgeResult, "delivery_prices_purge");

    const result = await supabase.from("delivery_prices").upsert(
      params.prices.map((row) => ({
        merchant_id: merchantId,
        account_id: accountId,
        provider,
        provider_code: provider,
        departure_center_id: departureCenterId,
        wilaya_id: row.wilaya_id,
        wilaya_name: row.wilaya_name ?? null,
        commune_id: row.commune_id ?? null,
        commune_name: row.commune_name ?? null,
        office_id: row.office_id ?? `__commune__:${row.commune_id ?? row.wilaya_id}`,
        office_name: row.office_name ?? null,
        home_price: row.home_price ?? null,
        stopdesk_price: row.stopdesk_price ?? null,
        last_sync_at: params.syncedAt,
        updated_at: params.syncedAt,
      })),
      { onConflict: "merchant_id,provider,departure_center_id,wilaya_id,commune_id,office_id" }
    );
    assertWrite(result, "delivery_prices");
  }
}

/** Maximum pages to fetch in a paginated loop (safety ceiling). */
const MAX_PAGES = 50;
/** Items per page for paginated provider APIs. */
const PAGE_SIZE = 100;

/**
 * Fetches all pages from a ZR Express-style paginated POST endpoint.
 * Returns the merged array of raw items from every page.
 */
async function fetchAllZrPages(
  account: Account,
  endpoint: string,
  extraBody?: Record<string, unknown>,
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
): Promise<Record<string, unknown>[]> {
  const allItems: Record<string, unknown>[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const payload = await fetchProvider(account, endpoint, {
      method: "POST",
      body: { pageNumber: page, pageSize: PAGE_SIZE, includeUnavailable: true, ...extraBody },
    }, context).catch(() => ({} as Record<string, unknown>));

    const items = resolveCollection(payload);
    allItems.push(...items);

    // Stop when the provider signals there are no more pages, or the page
    // returned fewer items than the page size (last page).
    const hasNext = Boolean(payload.hasNext ?? payload.has_next ?? payload.hasNextPage);
    const isLastPage = !hasNext || items.length < PAGE_SIZE;
    if (isLastPage) {
      break;
    }
  }

  return allItems;
}

/**
 * Fetches all pages from a Yalidine-style GET endpoint that supports
 * `?page=N` query-string pagination. Returns the merged items array.
 */
async function fetchAllYalidinePages(
  account: Account,
  endpoint: string,
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
): Promise<Record<string, unknown>> {
  const allItems: Record<string, unknown>[] = [];
  const visitedEndpoints = new Set<string>();
  let currentEndpoint = endpoint;
  let fallbackPage = 1;
  let firstPagePayload: Record<string, unknown> | null = null;

  const readPageSizeFromEndpoint = (value: string): number | null => {
    const pageSizeMatch = value.match(/[?&](?:page_size|pageSize|per_page)=([0-9]+)/i);
    if (!pageSizeMatch) {
      return null;
    }
    const parsed = Number(pageSizeMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  };

  const computePageSize = (payload: Record<string, unknown>, endpointValue: string): number | null => {
    const fromPayload = firstNumber(payload, [
      "page_size",
      "pageSize",
      "pagination.page_size",
      "pagination.pageSize",
      "meta.page_size",
      "meta.pageSize",
      "per_page",
      "pagination.per_page",
    ]);
    if (fromPayload !== null && fromPayload > 0) {
      return Math.floor(fromPayload);
    }
    return readPageSizeFromEndpoint(endpointValue);
  };

  const resolveNextEndpoint = (
    payload: Record<string, unknown>,
    baseEndpoint: string,
    nextPageNumber: number,
  ): string | null => {
    const directNext = firstString(payload, ["links.next", "pagination.next", "next", "next_page_url"]);
    if (directNext) {
      return directNext;
    }

    const sep = baseEndpoint.includes("?") ? "&" : "?";
    return `${baseEndpoint}${sep}page=${nextPageNumber}`;
  };

  for (let loopPage = 1; loopPage <= MAX_PAGES; loopPage += 1) {
    if (visitedEndpoints.has(currentEndpoint)) {
      break;
    }
    visitedEndpoints.add(currentEndpoint);

    // eslint-disable-next-line no-await-in-loop
    const payload = await fetchProviderWithRetry(account, currentEndpoint, undefined, context);
    if (!firstPagePayload) {
      firstPagePayload = payload;
    }

    const pageItems = resolveCollection(payload);
    if (pageItems.length === 0) {
      break;
    }

    allItems.push(...pageItems);
    const pageSize = computePageSize(payload, currentEndpoint);
    const hasMore = Boolean(
      readPath(payload, "has_more")
      ?? readPath(payload, "hasMore")
      ?? readPath(payload, "pagination.has_more")
      ?? readPath(payload, "pagination.hasMore"),
    );
    const nextLink = firstString(payload, ["links.next", "pagination.next", "next", "next_page_url"]);
    const continueByLength = pageSize !== null && pageItems.length >= pageSize;

    if (hasMore) {
      fallbackPage += 1;
      const nextEndpoint = nextLink ?? resolveNextEndpoint(payload, endpoint, fallbackPage);
      if (!nextEndpoint) {
        break;
      }
      currentEndpoint = nextEndpoint;
      continue;
    }

    if (nextLink) {
      currentEndpoint = nextLink;
      continue;
    }

    if (continueByLength) {
      fallbackPage += 1;
      const nextEndpoint = resolveNextEndpoint(payload, endpoint, fallbackPage);
      if (!nextEndpoint) {
        break;
      }
      currentEndpoint = nextEndpoint;
      continue;
    }

    break;
  }

  if (!firstPagePayload) {
    return {};
  }

  return { ...firstPagePayload, data: allItems };
}

function normalizeProcolisTarification(payload: Record<string, unknown>): { homePrice: number | null; stopdeskPrice: number | null } {
  const root = asObject(payload.data ?? payload.result ?? payload.tarification ?? payload);

  let homePrice = firstNumber(root, [
    "home_price",
    "homePrice",
    "prix_domicile",
    "tarif_domicile",
    "deliveryPrice",
    "delivery_price",
    "price_home",
  ]);
  let stopdeskPrice = firstNumber(root, [
    "stopdesk_price",
    "stopdeskPrice",
    "prix_stopdesk",
    "tarif_stopdesk",
    "pickupPrice",
    "pickup_price",
    "desk_price",
    "price_stopdesk",
  ]);

  const genericPrice = firstNumber(root, ["price", "prix", "tarif", "montant"]);
  if (genericPrice !== null) {
    const type = String(firstString(root, ["TypeLivraison", "typeLivraison", "type_livraison", "deliveryType", "type"]) ?? "").toLowerCase();
    const isStopdeskType = type.includes("pickup") || type.includes("stop") || type.includes("desk") || type.includes("point") || type.includes("bureau");
    if (isStopdeskType && stopdeskPrice === null) {
      stopdeskPrice = genericPrice;
    }
    if (!isStopdeskType && homePrice === null) {
      homePrice = genericPrice;
    }
  }

  return { homePrice, stopdeskPrice };
}

async function fetchProcolisPrices(
  account: Account,
  tarificationEndpoint: string,
  communes: CommuneRow[],
  wilayas: WilayaRow[],
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
): Promise<PriceRow[]> {
  const targets = communes.length > 0
    ? communes.map((commune) => ({ wilaya_id: commune.wilaya_id, commune_id: commune.commune_id, commune_name: commune.commune_name }))
    : wilayas.map((wilaya) => ({ wilaya_id: wilaya.wilaya_id, commune_id: null, commune_name: null }));

  if (targets.length === 0) {
    return [];
  }

  const targetMap = new Map<string, PriceRow>();
  const normalizeKey = (target: { wilaya_id: string; commune_id: string | null }) => `${target.wilaya_id}:${target.commune_id ?? ""}`;
  const chunkSize = 8;

  for (let offset = 0; offset < targets.length; offset += chunkSize) {
    const chunk = targets.slice(offset, offset + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(chunk.map(async (target) => {
      const homeBody: Record<string, unknown> = {
        IDWilaya: target.wilaya_id,
        Commune: target.commune_name ?? target.commune_id ?? "",
        TypeLivraison: "home",
      };
      const stopdeskBody: Record<string, unknown> = {
        IDWilaya: target.wilaya_id,
        Commune: target.commune_name ?? target.commune_id ?? "",
        TypeLivraison: "stopdesk",
      };

      const [homePayload, stopdeskPayload] = await Promise.all([
        fetchProvider(account, tarificationEndpoint, { method: "POST", body: homeBody }, context).catch(() => ({} as Record<string, unknown>)),
        fetchProvider(account, tarificationEndpoint, { method: "POST", body: stopdeskBody }, context).catch(() => ({} as Record<string, unknown>)),
      ]);

      const homeNormalized = normalizeProcolisTarification(homePayload);
      const stopdeskNormalized = normalizeProcolisTarification(stopdeskPayload);

      const mergedHome = homeNormalized.homePrice ?? stopdeskNormalized.homePrice;
      const mergedStopdesk = stopdeskNormalized.stopdeskPrice ?? homeNormalized.stopdeskPrice;
      if (mergedHome === null && mergedStopdesk === null) {
        return;
      }

      const key = normalizeKey(target);
      const existing = targetMap.get(key);
      targetMap.set(key, {
        wilaya_id: target.wilaya_id,
        commune_id: target.commune_id,
        commune_name: target.commune_name,
        office_id: null,
        office_name: null,
        home_price: mergedHome,
        stopdesk_price: mergedStopdesk,
        wilaya_name: existing?.wilaya_name ?? null,
      });
    }));
  }

  return Array.from(targetMap.values());
}

async function fetchAndNormalizeCache(
  account: Account,
  context?: {
    triggerSource?: SyncTriggerSource;
    requestCounter?: { count: number };
    cooldownStatus?: "allowed" | "cooldown" | "running";
  },
): Promise<CacheFetchResult> {
  if (account.provider === "yalidine") {
    const optional = asObject(account.endpoints?.optional ?? {});
    const wilayasEndpoint = String(optional.wilayas ?? "/v1/wilayas/");
    const communesEndpoint = String(optional.communes ?? "/v1/communes/");
    const centersEndpoint = String(optional.centers ?? "/v1/centers/");

    // Fetch wilayas, communes, centers, and departure-center ID in parallel.
    const [wilayasPayload, communesPayload, centersResult, departureCenterId] = await Promise.all([
      fetchAllYalidinePages(account, wilayasEndpoint, context),
      fetchAllYalidinePages(account, communesEndpoint, context),
      fetchAllYalidinePages(account, centersEndpoint, context).then(
        (p) => ({ payload: p, error: null as string | null }),
        (err) => ({ payload: {} as Record<string, unknown>, error: (err instanceof Error ? err.message : "yalidine_centers_fetch_failed") }),
      ),
      resolveYalidineDepartureCenterId(account.merchant_id),
    ]);
    const centersPayload = centersResult.payload;
    const centersFetchError = centersResult.error;
    const rawWilayas = normalizeWilayas(wilayasPayload);
    const mergedWilayas = mergeWithAlgeriaSeed(rawWilayas, "yalidine");
    const normalizedCommunes = normalizeCommunes(communesPayload);

    // Fees are NOT synced here — they are fetched on demand by the plugin's
    // /sync-fees endpoint (POST) which calls Yalidine /v1/fees/ directly and
    // writes results to wp_dzfs_fees. Keeping fees out of this sync path keeps
    // the delivery-cache request fast (≤ 8 s) so the PHP client does not time out.
    return {
      wilayas: mergedWilayas,
      communes: normalizedCommunes,
      stopdesks: normalizeStopdesks(centersPayload),
      prices: [],
      departureCenterId,
      diagnostics: {
        communesFetchSucceeded: true,
        centersFetchSucceeded: centersFetchError === null,
        centersFetchError,
      },
    };
  }

  if (account.provider === "zr_express") {
    const optional = asObject(account.endpoints?.optional ?? {});
    const territoriesEndpoint = String(optional.territoriesSearch ?? "/api/v1/territories/search");
    const pickupEndpoint = String(optional.pickupBagsSearch ?? "/api/v1/pickup-bags/search");
    const ratesEndpoint = String(
      optional.deliveryRates
      ?? optional.rates
      ?? optional.pricesSearch
      ?? optional.shippingPricesSearch
      ?? "/api/v1/delivery-pricing/rates",
    );

    // Fetch all pages – ZR Express has ~1600 territory records for Algeria
    // (58 wilayas + ~1541 communes).  A single page of 200 misses most data.
    const [territoryItems, pickupItems, priceItems] = await Promise.all([
      fetchAllZrPages(account, territoriesEndpoint, undefined, context),
      fetchAllZrPages(account, pickupEndpoint, undefined, context).catch(() => [] as Record<string, unknown>[]),
      fetchProvider(account, ratesEndpoint, undefined, context).catch(() => ({} as Record<string, unknown>)),
    ]);

    const cities = territoryItems.filter((row) => String(firstString(row, ["level"]) ?? "").toLowerCase() === "wilaya");
    const districts = territoryItems.filter((row) => String(firstString(row, ["level"]) ?? "").toLowerCase() === "commune");
    const rawWilayas = cities
      .map((row) => ({
        wilaya_id: firstString(row, ["id"]) ?? "",
        wilaya_name: firstString(row, ["name"]) ?? "",
      }))
      .filter((row) => row.wilaya_id && row.wilaya_name);
    const mergedWilayas = mergeWithAlgeriaSeed(rawWilayas, "zr_express");

    // Build a synthetic payload wrapper so normalise helpers can resolve it.
    const pickupPayload: Record<string, unknown> = { data: pickupItems };
    const pricesPayload = priceItems as Record<string, unknown>;

    const normalizedStopdesks = normalizeStopdesks(pickupPayload);
    const fallbackStopdesks = districts
      .filter((row) => {
        const deliveryPayload = asObject(readPath(row, "delivery") as Record<string, unknown> | undefined);
        return Boolean(readPath(deliveryPayload, "hasPickupPoint"));
      })
      .map((row) => ({
        wilaya_id: firstString(row, ["parentId"]),
        wilaya_name: null,
        commune_id: firstString(row, ["id"]),
        commune_name: firstString(row, ["name"]),
        office_id: `zr_virtual_${firstString(row, ["id"]) ?? "unknown"}`,
        office_name: `${firstString(row, ["name"]) ?? "Commune"} Stop Desk`,
      }))
      .filter((row) => row.office_id && row.office_name);

    const normalizedPrices = normalizeZrRates(pricesPayload, districts, mergedWilayas);
    const fallbackTerritoryPrices = normalizeZrTerritoryPrices(territoryItems);

    return {
      wilayas: mergedWilayas,
      communes: districts
        .map((row) => ({
          wilaya_id: firstString(row, ["parentId"]) ?? "",
          commune_id: firstString(row, ["id"]) ?? "",
          commune_name: firstString(row, ["name"]) ?? "",
        }))
        .filter((row) => row.wilaya_id && row.commune_id && row.commune_name),
      stopdesks: normalizedStopdesks.length > 0 ? normalizedStopdesks : fallbackStopdesks,
      prices: normalizedPrices.length > 0 ? normalizedPrices : fallbackTerritoryPrices,
    };
  }

  if (account.provider === "procolis") {
    const optional = asObject(account.endpoints?.optional ?? {});
    const wilayasEndpoint = String(optional.wilayas ?? "/wilayas");
    const communesEndpoint = String(optional.communes ?? "/communes");
    const stopdesksEndpoint = String(optional.stopdesks ?? "/stopdesks");
    const tarificationEndpoint = String(optional.tarification ?? "/tarification");

    const [wilayasPayload, communesPayload, stopdesksPayload] = await Promise.all([
      fetchProvider(account, wilayasEndpoint, undefined, context).catch(() => ({} as Record<string, unknown>)),
      fetchProvider(account, communesEndpoint, undefined, context).catch(() => ({} as Record<string, unknown>)),
      fetchProvider(account, stopdesksEndpoint, undefined, context).catch(() => ({} as Record<string, unknown>)),
    ]);

    const rawWilayas = normalizeWilayas(wilayasPayload);
    const mergedWilayas = mergeWithAlgeriaSeed(rawWilayas, "procolis");
    const communes = normalizeCommunes(communesPayload);
    const stopdesks = normalizeStopdesks(stopdesksPayload);
    const rawPrices = await fetchProcolisPrices(account, tarificationEndpoint, communes, mergedWilayas, context);
    const wilayaNameById = new Map(
      mergedWilayas.map((wilaya) => [wilaya.wilaya_id, wilaya.wilaya_name] as const)
    );

    return {
      wilayas: mergedWilayas,
      communes,
      stopdesks,
      prices: rawPrices.map((row) => ({
        ...row,
        wilaya_name: row.wilaya_name ?? wilayaNameById.get(row.wilaya_id) ?? null,
      })),
    };
  }

  return { wilayas: [], communes: [], stopdesks: [], prices: [] };
}

async function verifyYalidineSyncIntegrity(params: {
  account: Account;
  centersFetchSucceeded: boolean;
  skipPriceCheck?: boolean;
}) {
  const supabase = createClient();
  const merchantId = params.account.merchant_id;

  const [wilayaCountRes, communeCountRes, stopdeskCountRes, constantineCountRes, priceCountRes] = await Promise.all([
    supabase
      .from("delivery_wilayas")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine"),
    supabase
      .from("delivery_communes")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine"),
    supabase
      .from("delivery_stopdesks")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine"),
    supabase
      .from("delivery_communes")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("wilaya_id", "25"),
    supabase
      .from("delivery_prices")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine"),
  ]);

  const wilayaCount = wilayaCountRes.count ?? 0;
  const communeCount = communeCountRes.count ?? 0;
  const stopdeskCount = stopdeskCountRes.count ?? 0;
  const constantineCount = constantineCountRes.count ?? 0;
  const priceCount = priceCountRes.count ?? 0;

  if (wilayaCount <= 0) {
    throw new Error("yalidine_sync_integrity_failed:wilayas_empty");
  }
  if (communeCount <= 1000) {
    throw new Error(`yalidine_sync_integrity_failed:communes_too_low:${communeCount}`);
  }
  if (constantineCount < 12) {
    throw new Error(`yalidine_sync_integrity_failed:constantine_missing:${constantineCount}`);
  }
  if (params.centersFetchSucceeded && stopdeskCount <= 0) {
    throw new Error("yalidine_sync_integrity_failed:stopdesks_empty_after_centers_success");
  }
  // Price checks are skipped when delivery-cache syncs geo-only (prices: []).
  // Fees are handled by the separate /sync-fees endpoint and stored in wp_dzfs_fees.
  if (!params.skipPriceCheck) {
    if (priceCount <= 1000) {
      throw new Error(`yalidine_sync_integrity_failed:prices_too_low:${priceCount}`);
    }

    const { data: meftahByName } = await supabase
      .from("delivery_prices")
      .select("commune_id,commune_name,home_price,stopdesk_price")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("wilaya_id", "9")
      .ilike("commune_name", "mefta%")
      .limit(1)
      .maybeSingle();
    const { data: meftahById } = await supabase
      .from("delivery_prices")
      .select("commune_id,commune_name,home_price,stopdesk_price")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .eq("wilaya_id", "9")
      .eq("commune_id", "2635")
      .limit(1)
      .maybeSingle();

    const meftah = (meftahByName ?? meftahById ?? null) as {
      commune_id?: string | null;
      home_price?: number | null;
      stopdesk_price?: number | null;
    } | null;
    if (!meftah) {
      throw new Error("yalidine_sync_integrity_failed:blida_meftah_missing");
    }

    const meftahHome = Number(meftah.home_price ?? 0);
    const meftahDesk = Number(meftah.stopdesk_price ?? 0);
    if (!Number.isFinite(meftahHome) || meftahHome <= 0) {
      throw new Error(`yalidine_sync_integrity_failed:blida_meftah_home_invalid:${meftahHome}`);
    }
    if (!Number.isFinite(meftahDesk) || meftahDesk <= 0) {
      throw new Error(`yalidine_sync_integrity_failed:blida_meftah_stopdesk_invalid:${meftahDesk}`);
    }

    const { data: strictPriceRows } = await supabase
      .from("delivery_prices")
      .select("wilaya_id,home_price,stopdesk_price")
      .eq("merchant_id", merchantId)
      .eq("provider", "yalidine")
      .limit(6000);

    const coverage = buildYalidinePriceCoverage((strictPriceRows ?? []) as PriceRow[]);
    if (coverage.home.size < YALIDINE_WILAYA_TARGET_COUNT) {
      throw new Error(`yalidine_sync_integrity_failed:home_wilaya_coverage:${coverage.home.size}`);
    }
    if (coverage.stopdesk.size < YALIDINE_WILAYA_TARGET_COUNT) {
      throw new Error(`yalidine_sync_integrity_failed:stopdesk_wilaya_coverage:${coverage.stopdesk.size}`);
    }
  }
}

export async function syncDeliveryCacheForAccount(
  account: Account,
  options?: {
    force?: boolean;
    triggerSource?: SyncTriggerSource;
    currentJobId?: string;
  },
) {
  const lastSyncMs = account.last_sync_at ? new Date(account.last_sync_at).getTime() : 0;
  const nowMs = Date.now();
  const isYalidine = account.provider === "yalidine";
  if (!isYalidine && !options?.force && lastSyncMs > 0 && nowMs - lastSyncMs < DAY_MS) {
    return { synced: false, skipped: true, provider: account.provider, accountId: account.id };
  }

  if (isYalidine) {
    if (!options?.force && lastSyncMs > 0 && nowMs - lastSyncMs < YALIDINE_SYNC_COOLDOWN_MS) {
      return {
        synced: false,
        skipped: true,
        cooldown: true,
        provider: account.provider,
        accountId: account.id,
        cooldownUntil: new Date(lastSyncMs + YALIDINE_SYNC_COOLDOWN_MS).toISOString(),
      };
    }

    const failureMs = parseYalidineFailureTimestamp(account.last_error_message ?? null);
    if (!options?.force && failureMs > 0 && nowMs - failureMs < YALIDINE_SYNC_COOLDOWN_MS) {
      return {
        synced: false,
        skipped: true,
        cooldown: true,
        provider: account.provider,
        accountId: account.id,
        cooldownUntil: new Date(failureMs + YALIDINE_SYNC_COOLDOWN_MS).toISOString(),
        error: extractYalidineFailureMessage(account.last_error_message ?? null),
      };
    }

    const alreadyRunning = await hasProcessingYalidineSyncJob({
      merchantId: account.merchant_id,
      provider: account.provider,
      excludeJobId: options?.currentJobId,
    });
    if (alreadyRunning) {
      return {
        synced: false,
        skipped: true,
        alreadyRunning: true,
        provider: account.provider,
        accountId: account.id,
      };
    }
  }

  const syncedAt = new Date().toISOString();
  const requestCounter = { count: 0 };

  try {
    const cache = await fetchAndNormalizeCache(account, {
      triggerSource: options?.triggerSource ?? "unknown",
      requestCounter,
      cooldownStatus: "allowed",
    });

    // Only assert price coverage when prices were actually fetched.
    // Delivery-cache syncs are geo-only (prices: []) — fees are handled by /sync-fees.
    if (isYalidine && cache.prices.length > 0) {
      try {
        assertYalidinePriceCoverageBeforeWrite({
          account,
          prices: cache.prices,
        });
      } catch (assertErr) {
        throw assertErr; // rethrow to preserve original behavior
      }
    }

    await upsertCacheRows({ account, syncedAt, ...cache });

    if (isYalidine) {
      await verifyYalidineSyncIntegrity({
        account,
        centersFetchSucceeded: cache.diagnostics?.centersFetchSucceeded !== false,
        skipPriceCheck: cache.prices.length === 0,
      });
    }

    const supabase = createClient();

    // If the account was inactive due to a failed connection test (not a user
    // disconnect), a successful sync proves credentials are valid — re-activate.
    const accountUpdate: Record<string, unknown> = {
      last_sync_at: syncedAt,
      updated_at: syncedAt,
      last_error_message: null,
    };
    if (account.connection_status === "failed" || account.connection_status === "attention_required") {
      accountUpdate.active = true;
      accountUpdate.connection_status = "connected";
    }

    await Promise.all([
      supabase
        .from("merchant_delivery_accounts")
        .update(accountUpdate)
        .eq("id", account.id),
      upsertProviderSyncMarker(account.provider, syncedAt),
    ]);

    return {
      synced: true,
      skipped: false,
      provider: account.provider,
      accountId: account.id,
      counts: {
        wilayas: cache.wilayas.length,
        communes: cache.communes.length,
        stopdesks: cache.stopdesks.length,
        prices: cache.prices.length,
        externalRequests: requestCounter.count,
      },
      partial: cache.diagnostics?.centersFetchSucceeded === false
        ? {
            centersFetchSucceeded: false,
            centersFetchError: cache.diagnostics.centersFetchError ?? "yalidine_centers_fetch_failed",
          }
        : null,
      coverage: {
        wilayasCoveredCount: cache.wilayas.filter((w) => !(w as { is_seed?: boolean }).is_seed).length,
        seedWilayasAdded: cache.wilayas.filter((w) => (w as { is_seed?: boolean }).is_seed).length,
        missingWilayas: findMissingWilayas(cache.wilayas.filter((w) => !(w as { is_seed?: boolean }).is_seed))
          .map((w) => ({ id: w.id, name: w.name })),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "cache_sync_failed";
    const stamped = isYalidine ? withYalidineFailureMarker(message) : message;
    const supabase = createClient();
    await supabase
      .from("merchant_delivery_accounts")
      .update({
        last_error_message: stamped,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);
    throw error;
  }
}

export async function syncDeliveryCacheForMerchant(params: {
  merchantId: string;
  provider?: string;
  force?: boolean;
  triggerSource?: SyncTriggerSource;
  currentJobId?: string;
}) {
  const lockKey = `${params.merchantId}:${params.provider ?? "*"}`;
  if (_syncInProgressMerchants.has(lockKey)) {
    return { merchantId: params.merchantId, processed: 0, results: [], skipped: true };
  }
  _syncInProgressMerchants.add(lockKey);
  try {
    const accounts = await getSyncableDeliveryAccounts(params.merchantId);
    const target = accounts.filter((account) => (params.provider ? account.provider === params.provider : true));

    const results: Array<Record<string, unknown>> = [];
    for (const account of target) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await syncDeliveryCacheForAccount(account, {
          force: params.force,
          triggerSource: params.triggerSource,
          currentJobId: params.currentJobId,
        });
        results.push(result as unknown as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : "cache_sync_failed";
        results.push({
          synced: false,
          skipped: false,
          provider: account.provider,
          accountId: account.id,
          error: message,
        });
      }
    }

    return {
      merchantId: params.merchantId,
      processed: target.length,
      results,
    };
  } finally {
    _syncInProgressMerchants.delete(lockKey);
  }
}

export async function syncStaleDeliveryCache(params?: { merchantId?: string }) {
  const accounts = await getSyncableDeliveryAccounts(params?.merchantId);
  const results: Array<Record<string, unknown>> = [];

  for (const account of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await syncDeliveryCacheForAccount(account, {
        force: false,
        triggerSource: "background_job",
      });
      results.push(result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : "cache_sync_failed";
      results.push({
        synced: false,
        skipped: false,
        provider: account.provider,
        accountId: account.id,
        error: message,
      });
    }
  }

  return results;
}

export async function syncDeliveryCacheAcrossAll(
  force = false,
  options?: { triggerSource?: SyncTriggerSource; currentJobId?: string },
) {
  const accounts = await getSyncableDeliveryAccounts();
  const results: Array<Record<string, unknown>> = [];

  for (const account of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await syncDeliveryCacheForAccount(account, {
        force,
        triggerSource: options?.triggerSource,
        currentJobId: options?.currentJobId,
      });
      results.push(result as unknown as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : "cache_sync_failed";
      results.push({
        synced: false,
        skipped: false,
        provider: account.provider,
        accountId: account.id,
        error: message,
      });
    }
  }

  return results;
}

export async function getDeliveryCacheForCheckout(params: {
  merchantId: string;
  provider?: string;
  wilayaId?: string | null;
}) {
  const supabase = createClient();

  const { data: account } = await supabase
    .from("merchant_delivery_accounts")
    .select("provider")
    .eq("merchant_id", params.merchantId)
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const provider = params.provider ?? (account?.provider as string | undefined) ?? "yalidine";

  // Yalidine geo is served from the global shared cache (admin-synced, not per-merchant).
  if (provider === "yalidine") {
    return getGlobalDeliveryCacheForCheckout(params.wilayaId ?? null);
  }

  // Non-yalidine providers keep the existing per-merchant logic.
  try {
    const { data: wilayasRaw } = await supabase
      .from("delivery_wilayas")
      .select("wilaya_id,wilaya_name")
      .eq("merchant_id", params.merchantId)
      .eq("provider", provider)
      .order("wilaya_name", { ascending: true });

    const rawWilayas = (wilayasRaw ?? []) as Array<{ wilaya_id?: string | null; wilaya_name?: string | null }>;
    const wilayas = dedupeWilayas(rawWilayas);
    const effectiveWilayaId = resolveEffectiveWilayaId(rawWilayas, params.wilayaId);

    const [{ data: communes }, { data: offices }] = await Promise.all([
      effectiveWilayaId
        ? supabase
            .from("delivery_communes")
            .select("commune_id,commune_name,wilaya_id,wilaya_name")
            .eq("merchant_id", params.merchantId)
            .eq("provider", provider)
            .eq("wilaya_id", effectiveWilayaId)
            .order("commune_name", { ascending: true })
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      effectiveWilayaId
        ? supabase
            .from("delivery_stopdesks")
            .select("office_id,office_name,wilaya_id,wilaya_name,commune_id")
            .eq("merchant_id", params.merchantId)
            .eq("provider", provider)
            .eq("wilaya_id", effectiveWilayaId)
            .order("office_name", { ascending: true })
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

    const selectedWilayaName = effectiveWilayaId
      ? String(
          (rawWilayas ?? []).find((row) => String((row as { wilaya_id?: string }).wilaya_id ?? "") === effectiveWilayaId)
            ?.wilaya_name ?? "",
        ).trim()
      : "";

    let resolvedCommunes = (communes ?? []) as Array<Record<string, unknown>>;
    let resolvedOffices = (offices ?? []) as Array<Record<string, unknown>>;

    if (effectiveWilayaId && selectedWilayaName && resolvedCommunes.length === 0) {
      const [{ data: communesByName }, { data: officesByName }] = await Promise.all([
        supabase
          .from("delivery_communes")
          .select("commune_id,commune_name,wilaya_id,wilaya_name")
          .eq("merchant_id", params.merchantId)
          .eq("provider", provider)
          .ilike("wilaya_name", selectedWilayaName)
          .order("commune_name", { ascending: true }),
        supabase
          .from("delivery_stopdesks")
          .select("office_id,office_name,wilaya_id,wilaya_name,commune_id")
          .eq("merchant_id", params.merchantId)
          .eq("provider", provider)
          .ilike("wilaya_name", selectedWilayaName)
          .order("office_name", { ascending: true }),
      ]);

      if ((communesByName?.length ?? 0) > 0) {
        resolvedCommunes = communesByName as Array<Record<string, unknown>>;
      }
      if ((officesByName?.length ?? 0) > 0) {
        resolvedOffices = officesByName as Array<Record<string, unknown>>;
      }
    }

    const hasCacheRows = (wilayas?.length ?? 0) > 0;
    const hasScopedRows = !effectiveWilayaId || resolvedCommunes.length > 0;
    const stale = !hasCacheRows || !hasScopedRows;

    return {
      provider,
      wilayas: wilayas ?? [],
      communes: resolvedCommunes,
      offices: resolvedOffices,
      stale,
      staleReason: stale ? "cache_missing_or_stale" : null,
    };
  } catch (error) {
    if (!isMissingRelationError(error)) {
      throw error;
    }

    return {
      provider,
      wilayas: [],
      communes: [],
      offices: [],
      stale: true,
      staleReason: "cache_tables_missing",
    };
  }
}

async function getGlobalDeliveryCacheForCheckout(wilayaId: string | null) {
  const [rawWilayas, communes, offices] = await Promise.all([
    getGlobalWilayas(),
    wilayaId ? getGlobalCommunes(wilayaId) : Promise.resolve([] as Array<Record<string, unknown>>),
    wilayaId ? getGlobalOffices(wilayaId)  : Promise.resolve([] as Array<Record<string, unknown>>),
  ]);

  const wilayas = dedupeWilayas(rawWilayas as Array<{ wilaya_id?: string | null; wilaya_name?: string | null }>);
  const hasCacheRows = wilayas.length > 0;
  const hasScopedRows = !wilayaId || communes.length > 0;
  const stale = !hasCacheRows || !hasScopedRows;

  return {
    provider: "yalidine",
    wilayas,
    communes,
    offices,
    stale,
    staleReason: stale ? (hasCacheRows ? "cache_missing_or_stale" : "global_cache_not_synced") : null,
  };
}

// Reads delivery pricing from the shared admin-synced global_delivery_prices table.
// The merchant's origin wilaya comes from their shipping_origins row (set when
// they configured their departure center via sync-departure-center).
async function getGlobalShippingPrice(params: {
  merchantId: string;
  deliveryType: "home" | "stopdesk";
  wilayaId: string;
  communeId?: string | null;
  officeId?: string | null;
  departureCenterId?: string | null;
  started: number;
}): Promise<{
  provider: string;
  price: number | null;
  stale: boolean;
  meta: {
    wilayaName: string | null;
    communeName: string | null;
    officeName: string | null;
    latencyMs: number;
    source: string;
    stale: boolean;
    reason?: string;
    departureCenterId?: string | null;
    merchantId?: string;
  };
}> {
  const supabase = createClient();

  // Resolve origin wilaya in two passes.
  // Pass 1: match office_id = departureCenterId — sync-departure-center stores the
  //         Yalidine center ID in shipping_origins.office_id.
  // Pass 2: fall back to is_default = true if pass 1 misses or centerId absent.
  let originWilayaId = "";

  if (params.departureCenterId) {
    const { data: originByCenter } = await supabase
      .from("shipping_origins")
      .select("wilaya_id")
      .eq("merchant_id", params.merchantId)
      .eq("provider", "yalidine")
      .eq("office_id", params.departureCenterId)
      .maybeSingle();
    originWilayaId = (originByCenter as { wilaya_id?: string | null } | null)?.wilaya_id ?? "";
  }

  if (!originWilayaId) {
    const { data: originByDefault } = await supabase
      .from("shipping_origins")
      .select("wilaya_id")
      .eq("merchant_id", params.merchantId)
      .eq("provider", "yalidine")
      .eq("is_default", true)
      .maybeSingle();
    originWilayaId = (originByDefault as { wilaya_id?: string | null } | null)?.wilaya_id ?? "";
  }

  // Pass 3: infer origin wilaya from the global offices table.
  // global_delivery_offices is populated by the admin Global Sync (provider-level,
  // no merchant_id). It contains the office_id → wilaya_id mapping for all known
  // Yalidine centers. This resolves the originWilayaId without requiring any
  // per-merchant sync or a shipping_origins row to exist.
  if (!originWilayaId && params.departureCenterId) {
    const { data: globalCenter } = await supabase
      .from("global_delivery_offices")
      .select("wilaya_id")
      .eq("provider", "yalidine")
      .eq("office_id", params.departureCenterId)
      .maybeSingle();
    originWilayaId = (globalCenter as { wilaya_id?: string | null } | null)?.wilaya_id ?? "";
  }

  if (!originWilayaId) {
    const latencyMs = Date.now() - params.started;
    return {
      provider: "yalidine",
      price: null,
      stale: true,
      meta: {
        wilayaName: null,
        communeName: null,
        officeName: null,
        latencyMs,
        source: "global_cache",
        stale: true,
        reason: "missing_shipping_origin",
        departureCenterId: params.departureCenterId ?? null,
        merchantId: params.merchantId,
      },
    };
  }

  const destCommuneId = params.communeId ?? "";

  // Try merchant-synced prices first. departure_center_id stores the ORIGIN WILAYA ID
  // (e.g. "16"), so we filter by originWilayaId — not by the Yalidine office/center ID.
  type MerchantPriceRow = { home_price: number | null; stopdesk_price: number | null };
  let merchantPrice: number | null = null;

  {
    let mRow: MerchantPriceRow | null = null;
    if (destCommuneId) {
      const { data } = await supabase
        .from("delivery_prices")
        .select("home_price,stopdesk_price")
        .eq("merchant_id", params.merchantId)
        .eq("provider", "yalidine")
        .eq("departure_center_id", originWilayaId)
        .eq("wilaya_id", params.wilayaId)
        .eq("commune_id", destCommuneId)
        .maybeSingle();
      mRow = data as MerchantPriceRow | null;
    }
    if (!mRow) {
      const { data } = await supabase
        .from("delivery_prices")
        .select("home_price,stopdesk_price")
        .eq("merchant_id", params.merchantId)
        .eq("provider", "yalidine")
        .eq("departure_center_id", originWilayaId)
        .eq("wilaya_id", params.wilayaId)
        .order("commune_id", { ascending: true })
        .limit(1)
        .maybeSingle();
      mRow = data as MerchantPriceRow | null;
    }
    if (mRow) {
      merchantPrice = params.deliveryType === "home"
        ? (mRow.home_price ?? null)
        : (mRow.stopdesk_price ?? null);
    }
  }

  const price: number | null = merchantPrice;
  const priceSource = "merchant_delivery_prices";

  // Merchant checkout reads only from delivery_prices (merchant-synced via dashboard).
  // global_delivery_prices is admin-only and is never consulted here.

  const resolvedPrice = (price !== null && Number.isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const latencyMs = Date.now() - params.started;

  return {
    provider: "yalidine",
    price: resolvedPrice,
    stale: resolvedPrice === null,
    meta: {
      wilayaName: null,
      communeName: null,
      officeName: null,
      latencyMs,
      source: priceSource,
      stale: resolvedPrice === null,
    },
  };
}

export async function getCachedShippingPrice(params: {
  merchantId: string;
  provider?: string;
  deliveryType: "home" | "stopdesk";
  wilayaId: string;
  communeId?: string | null;
  officeId?: string | null;
  departureCenterId?: string | null;
}) {
  const started = Date.now();
  const supabase = createClient();

  const { data: account } = await supabase
    .from("merchant_delivery_accounts")
    .select("provider")
    .eq("merchant_id", params.merchantId)
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const provider = params.provider ?? (account?.provider as string | undefined) ?? "yalidine";

  // Yalidine: try merchant delivery_prices first, then fall back to global_delivery_prices.
  if (provider === "yalidine") {
    return getGlobalShippingPrice({ ...params, started });
  }

  const { data: wilayasRaw } = await supabase
    .from("delivery_wilayas")
    .select("wilaya_id,wilaya_name")
    .eq("merchant_id", params.merchantId)
    .eq("provider", provider)
    .limit(500);
  const rawWilayas = (wilayasRaw ?? []) as Array<{ wilaya_id?: string | null; wilaya_name?: string | null }>;
  const effectiveWilayaId = resolveEffectiveWilayaId(rawWilayas, params.wilayaId) ?? params.wilayaId;

  const selectedWilayaName = String(
    (
      await supabase
        .from("delivery_wilayas")
        .select("wilaya_name")
        .eq("merchant_id", params.merchantId)
        .eq("provider", provider)
        .eq("wilaya_id", effectiveWilayaId)
        .limit(1)
        .maybeSingle()
    ).data?.wilaya_name ?? "",
  ).trim();

  const candidateByKey = new Map<string, {
    wilaya_id?: string | null;
    commune_id?: string | null;
    office_id?: string | null;
    home_price: number | null;
    stopdesk_price: number | null;
    wilaya_name: string | null;
    commune_name: string | null;
    office_name: string | null;
  }>();

  const collectRows = (input: Array<{
    wilaya_id?: string | null;
    commune_id?: string | null;
    office_id?: string | null;
    home_price: number | null;
    stopdesk_price: number | null;
    wilaya_name: string | null;
    commune_name: string | null;
    office_name: string | null;
  }>) => {
    for (const row of input) {
      const key = [
        String(row.wilaya_id ?? "").trim(),
        String(row.commune_id ?? "").trim(),
        String(row.office_id ?? "").trim(),
      ].join("|");
      if (!candidateByKey.has(key)) {
        candidateByKey.set(key, row);
      }
    }
  };

  let rows: Array<{
    wilaya_id?: string | null;
    commune_id?: string | null;
    office_id?: string | null;
    home_price: number | null;
    stopdesk_price: number | null;
    wilaya_name: string | null;
    commune_name: string | null;
    office_name: string | null;
  }> = [];

  // departure_center_id stores the ORIGIN WILAYA ID (e.g. "16"), not the physical
  // Yalidine office/center ID. params.departureCenterId must be the wilaya ID.
  const departureCenterId = params.departureCenterId ?? "";

  try {
    let query = supabase
      .from("delivery_prices")
      .select("wilaya_id,wilaya_name,commune_id,commune_name,office_id,office_name,home_price,stopdesk_price")
      .eq("merchant_id", params.merchantId)
      .eq("provider", provider)
      .eq("departure_center_id", departureCenterId)
      .eq("wilaya_id", effectiveWilayaId)
      .limit(500);

    if (params.deliveryType === "home" && params.communeId) {
      query = query.eq("commune_id", params.communeId);
    }

    const { data } = await query;
    rows = (data ?? []) as Array<{
      wilaya_id?: string | null;
      commune_id?: string | null;
      office_id?: string | null;
      home_price: number | null;
      stopdesk_price: number | null;
      wilaya_name: string | null;
      commune_name: string | null;
      office_name: string | null;
    }>;
    collectRows(rows);
  } catch (error) {
    if (!isMissingRelationError(error)) {
      throw error;
    }
  }

  if (rows.length === 0) {
    if (selectedWilayaName) {
      let byNameQuery = supabase
        .from("delivery_prices")
        .select("wilaya_id,wilaya_name,commune_id,commune_name,office_id,office_name,home_price,stopdesk_price")
        .eq("merchant_id", params.merchantId)
        .eq("provider", provider)
        .eq("departure_center_id", departureCenterId)
        .ilike("wilaya_name", selectedWilayaName)
        .limit(200);

      if (params.deliveryType === "home" && params.communeId) {
        byNameQuery = byNameQuery.eq("commune_id", params.communeId);
      }

      const { data: rowsByName } = await byNameQuery;
      rows = (rowsByName ?? []) as Array<{
        wilaya_id?: string | null;
        commune_id?: string | null;
        office_id?: string | null;
        home_price: number | null;
        stopdesk_price: number | null;
        wilaya_name: string | null;
        commune_name: string | null;
        office_name: string | null;
      }>;
      collectRows(rows);
    }
  }

  const candidates = Array.from(candidateByKey.values());
  const resolved = resolveRankedPriceCandidate(candidates, {
    deliveryType: params.deliveryType,
    communeId: params.communeId,
    officeId: params.officeId,
  });
  const best = resolved.row;
  const resolvedPrice = (resolved.price !== null && Number.isFinite(Number(resolved.price)) && Number(resolved.price) > 0)
    ? Number(resolved.price)
    : null;
  const stale = resolvedPrice === null;

  return {
    provider,
    price: resolvedPrice,
    stale,
    meta: {
      wilayaName: best?.wilaya_name ?? null,
      communeName: best?.commune_name ?? null,
      officeName: best?.office_name ?? null,
      latencyMs: Date.now() - started,
      source: "cache",
      stale,
    },
  };
}
