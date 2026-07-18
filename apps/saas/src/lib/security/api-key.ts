import { createClient } from "@/lib/supabase/server";
import { hashApiKey } from "@/lib/security/hash";
import { getApiKeySigningSecret, getLegacyApiKeySigningSecret } from "@/lib/security/api-key-secret";

type ApiKeyValidationRecord = {
  id: string;
  merchant_id: string;
  store_id: string | null;
  is_active: boolean;
  expires_at: string | null;
};

type ApiKeyValidationCacheEntry = {
  expiresAt: number;
  value: ApiKeyValidationRecord | null;
};

const API_KEY_CACHE_TTL_MS = 45_000;
const API_KEY_MISS_CACHE_TTL_MS = 5_000;
const apiKeyValidationCache = new Map<string, ApiKeyValidationCacheEntry>();

function fingerprintApiKey(rawApiKey: string): string {
  const secret = getApiKeySigningSecret();
  return hashApiKey(rawApiKey, secret).slice(0, 48);
}

function readCache(cacheKey: string): ApiKeyValidationRecord | null | undefined {
  const cached = apiKeyValidationCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    apiKeyValidationCache.delete(cacheKey);
    return undefined;
  }
  return cached.value;
}

function writeCache(cacheKey: string, value: ApiKeyValidationRecord | null, ttlMs: number) {
  apiKeyValidationCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

function buildCandidateApiKeyHashes(rawApiKey: string): string[] {
  const hashes = new Set<string>();

  const canonicalSecret = getApiKeySigningSecret();
  hashes.add(hashApiKey(rawApiKey, canonicalSecret));

  const legacySecret = getLegacyApiKeySigningSecret();
  if (legacySecret) {
    hashes.add(hashApiKey(rawApiKey, legacySecret));
  }

  return Array.from(hashes);
}

export function hashApiKeyForStorage(rawApiKey: string): string {
  return hashApiKey(rawApiKey, getApiKeySigningSecret());
}

export async function validateApiKey(rawApiKey: string) {
  const cacheKey = `api_key:${fingerprintApiKey(rawApiKey)}`;
  const cached = readCache(cacheKey);
  if (typeof cached !== "undefined") {
    return cached;
  }

  const hashCandidates = buildCandidateApiKeyHashes(rawApiKey);
  const supabase = createClient();

  const { data, error } = await supabase
    .from("merchant_api_keys")
    .select("id, merchant_id, store_id, is_active, expires_at")
    .in("api_key_hash", hashCandidates)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    writeCache(cacheKey, null, API_KEY_MISS_CACHE_TTL_MS);
    return null;
  }

  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    writeCache(cacheKey, null, API_KEY_MISS_CACHE_TTL_MS);
    return null;
  }

  await supabase
    .from("merchant_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  writeCache(cacheKey, data as ApiKeyValidationRecord, API_KEY_CACHE_TTL_MS);
  return data;
}

export function __clearApiKeyValidationCache() {
  apiKeyValidationCache.clear();
}

export function __getApiKeyValidationCacheKeys(): string[] {
  return Array.from(apiKeyValidationCache.keys());
}
