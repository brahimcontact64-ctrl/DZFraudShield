import { beforeEach, describe, expect, it, vi } from "vitest";

describe("rate limit", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.RATE_LIMIT_BACKEND;
  });

  it("enforces local in-memory limits", async () => {
    const { enforceRateLimit } = await import("@/lib/security/rate-limit");
    const identity = `local-test-${Date.now()}`;

    await expect(enforceRateLimit(identity, 1, 60_000)).resolves.toBe(true);
    await expect(enforceRateLimit(identity, 1, 60_000)).resolves.toBe(false);
  });

  it("uses Supabase RPC backend when configured", async () => {
    process.env.RATE_LIMIT_BACKEND = "supabase";
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    vi.doMock("@/lib/supabase/server", () => ({
      createClient: () => ({ rpc }),
    }));

    const { enforceRateLimit } = await import("@/lib/security/rate-limit");
    await expect(enforceRateLimit("rpc-identity", 2, 60_000)).resolves.toBe(true);
    await expect(enforceRateLimit("rpc-identity", 2, 60_000)).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      p_identity: "rpc-identity",
      p_limit: 2,
      p_window_ms: 60_000,
    });
  });
});
