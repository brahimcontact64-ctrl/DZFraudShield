import { createClient } from "@/lib/supabase/server";

const bucket = new Map<string, { count: number; resetAt: number }>();

type RateLimitBackend = "local" | "supabase";

function resolveBackend(): RateLimitBackend {
  const raw = String(process.env.RATE_LIMIT_BACKEND ?? "local").trim().toLowerCase();
  return raw === "supabase" ? "supabase" : "local";
}

function enforceLocalRateLimit(identity: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = bucket.get(identity);

  if (!current || current.resetAt < now) {
    bucket.set(identity, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (current.count >= limit) {
    return false;
  }

  current.count += 1;
  return true;
}

export async function enforceRateLimit(identity: string, limit = 120, windowMs = 60_000): Promise<boolean> {
  const trimmedIdentity = String(identity ?? "").trim();
  if (!trimmedIdentity || limit <= 0 || windowMs <= 0) {
    return false;
  }

  if (resolveBackend() !== "supabase") {
    return enforceLocalRateLimit(trimmedIdentity, limit, windowMs);
  }

  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_identity: trimmedIdentity,
      p_limit: limit,
      p_window_ms: windowMs,
    });

    if (!error && typeof data === "boolean") {
      return data;
    }

    // Degrade safely: keep limiting enabled even if RPC is unavailable.
    return enforceLocalRateLimit(trimmedIdentity, limit, windowMs);
  } catch {
    return enforceLocalRateLimit(trimmedIdentity, limit, windowMs);
  }
}
