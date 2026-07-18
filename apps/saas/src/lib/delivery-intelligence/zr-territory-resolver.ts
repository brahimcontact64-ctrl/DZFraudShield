import { createClient } from "@/lib/supabase/server";
import type { ProviderAuthConfig } from "@/lib/delivery-intelligence/types";

type ZrTerritory = {
  id: string;
  name: string;
  level: string;
  parentId: string | null;
};

type ZrTerritoryPage = {
  items?: Array<{
    id?: string;
    name?: string | null;
    level?: string | null;
    parentId?: string | null;
  }>;
  hasNext?: boolean;
  pageNumber?: number;
};

type CacheRow = {
  city_territory_id: string;
  district_territory_id: string;
  normalized_city_name: string | null;
  normalized_district_name: string | null;
  confidence: string;
};

type MatchConfidence = "exact" | "accent-insensitive" | "case-insensitive" | "fuzzy-safe" | "cache";

export type ZrTerritoryResolutionInput = {
  provider: string;
  config: ProviderAuthConfig;
  wilaya: string;
  commune: string;
  address?: string | null;
};

export type ZrTerritoryResolution = {
  cityTerritoryId: string;
  districtTerritoryId: string;
  normalizedCityName: string;
  normalizedDistrictName: string;
  confidence: MatchConfidence;
  sourcePayload: Record<string, unknown>;
};

export class ZrTerritoryResolutionError extends Error {
  public readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "ZrTerritoryResolutionError";
    this.details = details;
  }
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function extractWilayaCode(value: string): string | null {
  const raw = normalizeWhitespace(value);
  if (!raw) return null;

  const dzPrefixed = raw.match(/^DZ[-_\s]?(\d{1,2})$/i);
  if (dzPrefixed) {
    return String(Number.parseInt(dzPrefixed[1] ?? "", 10));
  }

  if (/^\d{1,2}$/.test(raw)) {
    return String(Number.parseInt(raw, 10));
  }

  return null;
}

function normalizeAccentInsensitive(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['`´’]/g, "")
    .replace(/[-_]/g, " ");
}

function normalizeCaseInsensitive(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("fr-FR");
}

function normalizeLoose(value: string): string {
  return normalizeAccentInsensitive(value).toLocaleLowerCase("fr-FR");
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });

  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function similarityScore(a: string, b: string): number {
  const left = normalizeLoose(a);
  const right = normalizeLoose(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function matchesExact(candidate: string, input: string): boolean {
  return normalizeWhitespace(candidate) === normalizeWhitespace(input);
}

function matchesAccentInsensitive(candidate: string, input: string): boolean {
  return normalizeAccentInsensitive(candidate) === normalizeAccentInsensitive(input);
}

function matchesCaseInsensitive(candidate: string, input: string): boolean {
  return normalizeCaseInsensitive(candidate) === normalizeCaseInsensitive(input);
}

function resolveEndpoint(config: ProviderAuthConfig): URL {
  const optional = config.endpoints.optional ?? {};
  const path = optional.territoriesSearch
    ?? optional.searchTerritories
    ?? optional.territories
    ?? "/api/v1/territories/search";
  return new URL(path, config.baseUrl);
}

function normalizeTerritoryRow(value: unknown): ZrTerritory | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? normalizeWhitespace(row.name) : "";
  const level = typeof row.level === "string" ? normalizeLoose(row.level) : "";
  const parentId = typeof row.parentId === "string" && row.parentId.trim() ? row.parentId : null;

  if (!id || !name || !level) return null;
  return { id, name, level, parentId };
}

async function fetchTerritories(config: ProviderAuthConfig): Promise<ZrTerritory[]> {
  const endpoint = resolveEndpoint(config);
  const apiKey = config.credentials.apiKey
    ?? config.credentials.secretKey
    ?? config.credentials.key
    ?? config.credentials.token;
  const tenantId = config.credentials.tenantId
    ?? config.credentials.tenant
    ?? config.credentials["X-Tenant"];
  const apiHeaderName = config.credentials.headerName
    ?? config.credentials.secretHeaderName
    ?? "X-Api-Key";
  const tenantHeaderName = config.credentials.tenantHeaderName
    ?? "X-Tenant";

  if (!apiKey || !tenantId) {
    throw new ZrTerritoryResolutionError("ZR territory resolution cannot run without tenant credentials", {
      missingApiKey: !apiKey,
      missingTenantId: !tenantId,
    });
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    [apiHeaderName]: apiKey,
    [tenantHeaderName]: tenantId,
    ...(config.customHeaders ?? {}),
  };

  const rows: ZrTerritory[] = [];
  let pageNumber = 1;
  let hasNext = true;
  while (hasNext && pageNumber <= 200) {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ pageNumber, pageSize: 100, includeUnavailable: true }),
      cache: "no-store",
    });

    const body = (await response.json().catch(() => ({}))) as ZrTerritoryPage;
    if (!response.ok) {
      throw new ZrTerritoryResolutionError(`ZR territories search failed (${response.status})`, {
        status: response.status,
        endpoint: endpoint.toString(),
        body,
      });
    }

    for (const item of body.items ?? []) {
      const normalized = normalizeTerritoryRow(item);
      if (normalized) {
        rows.push(normalized);
      }
    }

    hasNext = Boolean(body.hasNext);
    pageNumber += 1;
  }

  return rows;
}

async function readCache(provider: string, wilaya: string, commune: string): Promise<CacheRow | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("delivery_territory_resolution_cache")
      .select("city_territory_id,district_territory_id,normalized_city_name,normalized_district_name,confidence")
      .eq("provider", provider)
      .eq("wilaya", normalizeLoose(wilaya))
      .eq("commune", normalizeLoose(commune))
      .maybeSingle();

    if (error || !data) return null;
    return data as CacheRow;
  } catch {
    return null;
  }
}

async function resolveWilayaNameFromCode(provider: string, wilaya: string): Promise<string | null> {
  const code = extractWilayaCode(wilaya);
  if (!code) {
    return null;
  }

  try {
    const supabase = createClient();
    const { data } = await supabase
      .from("delivery_wilayas")
      .select("wilaya_id,wilaya_name")
      .eq("provider", provider)
      .limit(500);

    const rows = Array.isArray(data) ? data : [];
    const exact = rows.find((row) => String(row?.wilaya_id ?? "") === code);
    if (exact && typeof exact.wilaya_name === "string" && exact.wilaya_name.trim()) {
      return normalizeWhitespace(exact.wilaya_name);
    }

    const prefixed = rows.find((row) => {
      const id = String(row?.wilaya_id ?? "");
      return id.endsWith(`_${code}`) || id.endsWith(`-${code}`);
    });
    if (prefixed && typeof prefixed.wilaya_name === "string" && prefixed.wilaya_name.trim()) {
      return normalizeWhitespace(prefixed.wilaya_name);
    }

    return null;
  } catch {
    return null;
  }
}

async function writeCache(params: {
  provider: string;
  wilaya: string;
  commune: string;
  cityTerritoryId: string;
  districtTerritoryId: string;
  normalizedCityName: string;
  normalizedDistrictName: string;
  confidence: MatchConfidence;
  sourcePayload: Record<string, unknown>;
}) {
  try {
    const supabase = createClient();
    await supabase
      .from("delivery_territory_resolution_cache")
      .upsert({
        provider: params.provider,
        wilaya: normalizeLoose(params.wilaya),
        commune: normalizeLoose(params.commune),
        city_territory_id: params.cityTerritoryId,
        district_territory_id: params.districtTerritoryId,
        normalized_city_name: params.normalizedCityName,
        normalized_district_name: params.normalizedDistrictName,
        confidence: params.confidence,
        source_payload: params.sourcePayload,
        updated_at: new Date().toISOString(),
      }, { onConflict: "provider,wilaya,commune" });
  } catch {
    // Cache failures are non-fatal because resolution can still proceed from API data.
  }
}

function pickBestCity(cities: ZrTerritory[], wilaya: string): { city: ZrTerritory; confidence: MatchConfidence } | null {
  const exact = cities.find((item) => matchesExact(item.name, wilaya));
  if (exact) return { city: exact, confidence: "exact" };

  const accent = cities.find((item) => matchesAccentInsensitive(item.name, wilaya));
  if (accent) return { city: accent, confidence: "accent-insensitive" };

  const caseInsensitive = cities.find((item) => matchesCaseInsensitive(item.name, wilaya));
  if (caseInsensitive) return { city: caseInsensitive, confidence: "case-insensitive" };

  const ranked = cities
    .map((item) => ({ item, score: similarityScore(item.name, wilaya) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];

  if (top && top.score >= 0.9 && (!second || top.score - second.score >= 0.08)) {
    return { city: top.item, confidence: "fuzzy-safe" };
  }

  return null;
}

function pickBestDistrict(params: {
  districts: ZrTerritory[];
  commune: string;
}): { district: ZrTerritory; confidence: MatchConfidence } | null {
  const exact = params.districts.find((item) => matchesExact(item.name, params.commune));
  if (exact) return { district: exact, confidence: "exact" };

  const accent = params.districts.find((item) => matchesAccentInsensitive(item.name, params.commune));
  if (accent) return { district: accent, confidence: "accent-insensitive" };

  const caseInsensitive = params.districts.find((item) => matchesCaseInsensitive(item.name, params.commune));
  if (caseInsensitive) return { district: caseInsensitive, confidence: "case-insensitive" };

  const ranked = params.districts
    .map((item) => ({ item, score: similarityScore(item.name, params.commune) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];

  if (top && top.score >= 0.9 && (!second || top.score - second.score >= 0.08)) {
    return { district: top.item, confidence: "fuzzy-safe" };
  }

  return null;
}

export async function resolveZrTerritories(input: ZrTerritoryResolutionInput): Promise<ZrTerritoryResolution> {
  const rawWilaya = normalizeWhitespace(input.wilaya);
  const wilaya = (await resolveWilayaNameFromCode(input.provider, rawWilaya)) ?? rawWilaya;
  const commune = normalizeWhitespace(input.commune);

  if (!wilaya || !commune) {
    throw new ZrTerritoryResolutionError("ZR territory resolution requires both wilaya and commune", {
      wilaya,
      commune,
      address: input.address ?? null,
    });
  }

  const cached = await readCache(input.provider, wilaya, commune);
  if (cached) {
    return {
      cityTerritoryId: cached.city_territory_id,
      districtTerritoryId: cached.district_territory_id,
      normalizedCityName: cached.normalized_city_name ?? wilaya,
      normalizedDistrictName: cached.normalized_district_name ?? commune,
      confidence: "cache",
      sourcePayload: { cache: true },
    };
  }

  const territories = await fetchTerritories(input.config);
  const cities = territories.filter((item) => item.level === "wilaya");
  const allDistricts = territories.filter((item) => item.level === "commune");

  const cityMatch = pickBestCity(cities, wilaya);
  if (!cityMatch) {
    throw new ZrTerritoryResolutionError("Unable to resolve ZR city territory from wilaya", {
      wilaya,
      commune,
      address: input.address ?? null,
      availableCitiesSample: cities.slice(0, 25).map((item) => item.name),
    });
  }

  const districts = allDistricts.filter((item) => item.parentId === cityMatch.city.id);
  const districtMatch = pickBestDistrict({ districts, commune });
  if (!districtMatch) {
    throw new ZrTerritoryResolutionError("Unable to resolve ZR district territory from commune", {
      wilaya,
      commune,
      resolvedCity: cityMatch.city,
      address: input.address ?? null,
      districtCandidatesSample: districts.slice(0, 25).map((item) => item.name),
    });
  }

  const confidence = [cityMatch.confidence, districtMatch.confidence].includes("fuzzy-safe")
    ? "fuzzy-safe"
    : [cityMatch.confidence, districtMatch.confidence].includes("case-insensitive")
      ? "case-insensitive"
      : [cityMatch.confidence, districtMatch.confidence].includes("accent-insensitive")
        ? "accent-insensitive"
        : "exact";

  const resolved: ZrTerritoryResolution = {
    cityTerritoryId: cityMatch.city.id,
    districtTerritoryId: districtMatch.district.id,
    normalizedCityName: cityMatch.city.name,
    normalizedDistrictName: districtMatch.district.name,
    confidence,
    sourcePayload: {
      endpoint: resolveEndpoint(input.config).toString(),
      city: cityMatch.city,
      district: districtMatch.district,
      matching: {
        city: cityMatch.confidence,
        district: districtMatch.confidence,
      },
    },
  };

  await writeCache({
    provider: input.provider,
    wilaya,
    commune,
    cityTerritoryId: resolved.cityTerritoryId,
    districtTerritoryId: resolved.districtTerritoryId,
    normalizedCityName: resolved.normalizedCityName,
    normalizedDistrictName: resolved.normalizedDistrictName,
    confidence: resolved.confidence,
    sourcePayload: resolved.sourcePayload,
  });

  return resolved;
}