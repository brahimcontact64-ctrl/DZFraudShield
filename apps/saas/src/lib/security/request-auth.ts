import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { validateApiKey } from "@/lib/security/api-key";
import { enforceRateLimit } from "@/lib/security/rate-limit";

type AuthContextRecord = Awaited<ReturnType<typeof validateApiKey>>;
type AuthCacheEntry = {
  expiresAt: number;
  value: AuthContextRecord;
};

const AUTH_CACHE_TTL_MS = 45_000;
const AUTH_MISS_CACHE_TTL_MS = 5_000;
const authContextCache = new Map<string, AuthCacheEntry>();

function authCacheKey(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("hex");
  return `auth_ctx:${digest.slice(0, 48)}`;
}

function readAuthCache(key: string): AuthContextRecord | undefined {
  const cached = authContextCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    authContextCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function writeAuthCache(key: string, value: AuthContextRecord, ttlMs: number) {
  authContextCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

export function getApiKeyFromRequest(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return req.headers.get("x-api-key");
}

export async function requireApiKeyAuth(req: NextRequest, scope: string) {
  const apiKey = getApiKeyFromRequest(req);
  if (!apiKey) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Missing API key" }, { status: 401 })
    };
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const keyFingerprint = apiKey.slice(0, 12);
  if (!await enforceRateLimit(`${scope}:${keyFingerprint}:${ip}`)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
    };
  }

  const cacheKey = authCacheKey(apiKey);
  const cachedRecord = readAuthCache(cacheKey);
  const keyRecord = typeof cachedRecord === "undefined"
    ? await validateApiKey(apiKey)
    : cachedRecord;

  if (typeof cachedRecord === "undefined") {
    writeAuthCache(cacheKey, keyRecord, keyRecord ? AUTH_CACHE_TTL_MS : AUTH_MISS_CACHE_TTL_MS);
  }

  if (!keyRecord) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Invalid API key" }, { status: 401 })
    };
  }

  return {
    ok: true as const,
    keyRecord
  };
}
