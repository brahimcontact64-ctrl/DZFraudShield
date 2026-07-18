/**
 * provider-rate-limiter.ts
 *
 * Generic, header-aware rate limiter for delivery providers.
 *
 * Each provider can configure per-window limits and optional response header
 * names that carry server-side remaining quota. When quota headers are present
 * the limiter defers to the server's count; when absent it falls back to local
 * sliding-window counting.
 *
 * The Yalidine-specific YalidineRateLimiter (delivery-sync-engine.ts) is NOT
 * replaced by this module. This is for other providers (Noest, ProColis, etc.).
 *
 * Usage:
 *   const limiter = getProviderRateLimiter("noest", accountId, NOEST_RATE_LIMIT);
 *   await limiter.waitIfNeeded(url);
 *   const res = await fetch(url, ...);
 *   limiter.recordHeaders(res.headers);
 *   limiter.recordRequest();
 */

export type RateLimitWindow = "second" | "minute" | "hour" | "day";

export type ProviderRateLimitConfig = {
  provider: string;
  /** Maximum requests allowed per window (enforced locally when no header is present). */
  limits: Partial<Record<RateLimitWindow, number>>;
  /** Response header names that carry server-side remaining quota per window. */
  headerNames?: Partial<Record<RateLimitWindow, string>>;
};

export type ProviderRateLimitStats = {
  provider: string;
  accountId: string;
  pauseCount: number;
  pauseTotalMs: number;
  quotaLeft: Partial<Record<RateLimitWindow, number | null>>;
  localCounts: Partial<Record<RateLimitWindow, number>>;
};

// Window durations in ms — ordered from largest to smallest for priority checks.
const WINDOW_MS: Record<RateLimitWindow, number> = {
  day:    86_400_000,
  hour:    3_600_000,
  minute:     60_000,
  second:      1_000,
};

const WINDOWS_PRIORITY: RateLimitWindow[] = ["day", "hour", "minute", "second"];

type WindowState = {
  /** Server-supplied remaining quota (null = not yet received). */
  quotaLeft: number | null;
  /** Approx timestamp of when this window opened (for calculating expiry). */
  windowStart: number;
  /** Local request count within the current window (fallback tracking). */
  count: number;
};

// Module-scope registry — one instance per (provider, accountId) pair.
// Lost on cold start; correct behaviour resumes after the first response headers arrive.
const _registry = new Map<string, ProviderRateLimiter>();

export function getProviderRateLimiter(
  provider: string,
  accountId: string,
  config: ProviderRateLimitConfig,
): ProviderRateLimiter {
  const key = `${provider}:${accountId}`;
  let limiter = _registry.get(key);
  if (!limiter) {
    limiter = new ProviderRateLimiter(accountId, config);
    _registry.set(key, limiter);
  }
  return limiter;
}

export class ProviderRateLimiter {
  private readonly provider: string;
  private readonly accountId: string;
  private readonly limits: Partial<Record<RateLimitWindow, number>>;
  private readonly headerNames: Partial<Record<RateLimitWindow, string>>;

  private readonly _windows: Record<RateLimitWindow, WindowState> = {
    day:    { quotaLeft: null, windowStart: 0, count: 0 },
    hour:   { quotaLeft: null, windowStart: 0, count: 0 },
    minute: { quotaLeft: null, windowStart: 0, count: 0 },
    second: { quotaLeft: null, windowStart: 0, count: 0 },
  };

  private _pauseCount = 0;
  private _pauseTotalMs = 0;
  private _retryAfterMs: number | null = null;

  constructor(accountId: string, config: ProviderRateLimitConfig) {
    this.provider    = config.provider;
    this.accountId   = accountId;
    this.limits      = config.limits;
    this.headerNames = config.headerNames ?? {};
  }

  /**
   * Parse response headers and update server-supplied quota tracking.
   * Call immediately after every successful response.
   */
  recordHeaders(headers: Headers | Record<string, string>): void {
    const get = (name: string): string | null =>
      headers instanceof Headers
        ? headers.get(name)
        : ((headers as Record<string, string>)[name] ?? null);

    // Retry-After (seconds or HTTP-date — we only handle seconds here).
    const retryAfter = get("retry-after") ?? get("Retry-After");
    if (retryAfter !== null) {
      const secs = parseInt(retryAfter, 10);
      if (!isNaN(secs) && secs > 0) {
        this._retryAfterMs = secs * 1_000;
      }
    }

    // Per-window quota headers.
    for (const window of WINDOWS_PRIORITY) {
      const headerName = this.headerNames[window];
      if (!headerName) continue;
      const raw = get(headerName) ?? get(headerName.toLowerCase());
      if (raw === null) continue;
      const val = parseInt(raw, 10);
      if (!isNaN(val)) {
        const state = this._windows[window];
        // Detect window reset: quota went up → new window started.
        const prevLeft = state.quotaLeft;
        const limit    = this.limits[window] ?? 0;
        if (prevLeft !== null && val > prevLeft && val >= limit * 0.9) {
          state.windowStart = Date.now();
        } else if (state.windowStart === 0) {
          state.windowStart = Date.now();
        }
        state.quotaLeft = val;
      }
    }
  }

  /**
   * Increment local sliding-window counts. Call after every successful request
   * for windows that have no server-supplied quota header.
   */
  recordRequest(): void {
    const now = Date.now();
    for (const window of WINDOWS_PRIORITY) {
      if (!this.limits[window]) continue;
      if (this.headerNames[window]) continue; // Server tracks this window.

      const state   = this._windows[window];
      const elapsed = now - state.windowStart;
      if (state.windowStart === 0 || elapsed >= WINDOW_MS[window]) {
        state.count       = 0;
        state.windowStart = now;
      }
      state.count++;
    }
  }

  /**
   * Notify the limiter that a 429 was received with a Retry-After value.
   * The next `waitIfNeeded()` call will pause for at least that duration.
   */
  setRetryAfter(ms: number): void {
    this._retryAfterMs = Math.max(ms, this._retryAfterMs ?? 0);
  }

  /**
   * Sleep until the current request is safe to send.
   * Must be called before every outbound request.
   *
   * @param context - Optional label (URL, operation name) for log lines.
   */
  async waitIfNeeded(context = ""): Promise<void> {
    const ctx = context ? ` | url=${context}` : "";

    // ── 0. Pending Retry-After ───────────────────────────────────────────────
    if (this._retryAfterMs !== null && this._retryAfterMs > 0) {
      const waitMs = this._retryAfterMs;
      this._retryAfterMs = null;
      console.warn(
        `[${this.provider}:${this.accountId}] WAIT retry-after` +
        ` duration=${Math.ceil(waitMs / 1_000)}s${ctx}`,
      );
      await this._sleep(waitMs);
      return;
    }

    // ── 1. Server-supplied quota (day → hour → minute → second) ─────────────
    for (const window of WINDOWS_PRIORITY) {
      const state = this._windows[window];
      if (state.quotaLeft === null || state.quotaLeft > 0) continue;

      const expiresAt = state.windowStart > 0
        ? state.windowStart + WINDOW_MS[window]
        : Date.now() + WINDOW_MS[window];
      const waitMs = Math.max(1_000, expiresAt - Date.now());

      console.warn(
        `[${this.provider}:${this.accountId}] WAIT window=${window}` +
        ` duration=${Math.ceil(waitMs / 1_000)}s quota_left=0${ctx}`,
      );
      await this._sleep(waitMs);
      state.quotaLeft = null;
      return; // Re-evaluate on the next call.
    }

    // ── 2. Local fallback counting (windows without quota headers) ───────────
    const now = Date.now();
    for (const window of WINDOWS_PRIORITY) {
      const limit = this.limits[window];
      if (!limit) continue;
      if (this.headerNames[window]) continue; // Server-tracked.

      const state   = this._windows[window];
      const elapsed = now - state.windowStart;

      if (state.windowStart === 0 || elapsed >= WINDOW_MS[window]) {
        state.count       = 0;
        state.windowStart = now;
      }

      if (state.count >= limit) {
        const waitMs = Math.max(0, state.windowStart + WINDOW_MS[window] - Date.now());
        if (waitMs > 0) {
          console.warn(
            `[${this.provider}:${this.accountId}] WAIT window=${window}(local)` +
            ` duration=${Math.ceil(waitMs / 1_000)}s limit=${limit}/${window}${ctx}`,
          );
          await this._sleep(waitMs);
        }
        state.count       = 0;
        state.windowStart = Date.now();
        return;
      }
    }
  }

  getStats(): ProviderRateLimitStats {
    return {
      provider:    this.provider,
      accountId:   this.accountId,
      pauseCount:  this._pauseCount,
      pauseTotalMs: this._pauseTotalMs,
      quotaLeft: Object.fromEntries(
        WINDOWS_PRIORITY.map((w) => [w, this._windows[w].quotaLeft]),
      ) as Partial<Record<RateLimitWindow, number | null>>,
      localCounts: Object.fromEntries(
        WINDOWS_PRIORITY
          .filter((w) => !this.headerNames[w])
          .map((w) => [w, this._windows[w].count]),
      ) as Partial<Record<RateLimitWindow, number>>,
    };
  }

  private async _sleep(ms: number): Promise<void> {
    const t0 = Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    this._pauseCount++;
    this._pauseTotalMs += Date.now() - t0;
  }
}

// ── Built-in configs for known providers ──────────────────────────────────────

/** Conservative limits for providers with no published quota policy. */
export const GENERIC_RATE_LIMIT: Omit<ProviderRateLimitConfig, "provider"> = {
  limits: { second: 2, minute: 80, hour: 2_000 },
};

/** Noest — no published quota; conservative defaults. */
export const NOEST_RATE_LIMIT: Omit<ProviderRateLimitConfig, "provider"> = {
  limits: { second: 2, minute: 60, hour: 1_500 },
};

/** ProColis — no published quota; conservative defaults. */
export const PROCOLIS_RATE_LIMIT: Omit<ProviderRateLimitConfig, "provider"> = {
  limits: { second: 2, minute: 60, hour: 1_500 },
};

/** Ecotrack — no published quota; conservative defaults. */
export const ECOTRACK_RATE_LIMIT: Omit<ProviderRateLimitConfig, "provider"> = {
  limits: { second: 2, minute: 60, hour: 1_500 },
};
