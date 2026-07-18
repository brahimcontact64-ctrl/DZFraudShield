import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearApiKeyValidationCache,
  __getApiKeyValidationCacheKeys,
  validateApiKey,
} from "@/lib/security/api-key";
import { hashApiKey } from "@/lib/security/hash";

const maybeSingle = vi.fn();
const update = vi.fn().mockReturnThis();
const eq = vi.fn().mockReturnThis();
const limit = vi.fn(() => ({ maybeSingle }));
const order = vi.fn(() => ({ limit }));
const inQuery = vi.fn(() => ({ eq, order }));
const select = vi.fn(() => ({ in: inQuery }));
const from = vi.fn(() => ({ select, update, eq }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ from })
}));

vi.mock("@/lib/security/api-key-secret", () => ({
  getApiKeySigningSecret: vi.fn(() => "secret"),
  getLegacyApiKeySigningSecret: vi.fn(() => null)
}));

describe("validateApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearApiKeyValidationCache();
  });

  it("returns null when key not found", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await validateApiKey("dzfs_key");
    expect(result).toBeNull();
  });

  it("returns key record when active", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        id: "k1",
        merchant_id: "m1",
        store_id: "s1",
        is_active: true,
        expires_at: null
      },
      error: null
    });

    const result = await validateApiKey("dzfs_key");
    expect(result?.merchant_id).toBe("m1");
    expect(hashApiKey("dzfs_key", "secret")).toHaveLength(64);
  });

  it("uses cache on repeated key validation", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        id: "k1",
        merchant_id: "m1",
        store_id: "s1",
        is_active: true,
        expires_at: null
      },
      error: null
    });

    const first = await validateApiKey("dzfs_key");
    const second = await validateApiKey("dzfs_key");

    expect(first?.merchant_id).toBe("m1");
    expect(second?.merchant_id).toBe("m1");
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong key without poisoning success cache", async () => {
    maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "k1",
          merchant_id: "m1",
          store_id: "s1",
          is_active: true,
          expires_at: null
        },
        error: null
      })
      .mockResolvedValueOnce({ data: null, error: null });

    const valid = await validateApiKey("dzfs_key");
    const invalid = await validateApiKey("dzfs_wrong");

    expect(valid?.merchant_id).toBe("m1");
    expect(invalid).toBeNull();
  });

  it("refreshes cache after ttl expires", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "k1",
          merchant_id: "m1",
          store_id: "s1",
          is_active: true,
          expires_at: null
        },
        error: null
      })
      .mockResolvedValueOnce({
        data: {
          id: "k1",
          merchant_id: "m1",
          store_id: "s1",
          is_active: true,
          expires_at: null
        },
        error: null
      });

    await validateApiKey("dzfs_key");
    nowSpy.mockReturnValue(1_050_000);
    await validateApiKey("dzfs_key");

    expect(maybeSingle).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("never stores raw key in cache keys", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        id: "k1",
        merchant_id: "m1",
        store_id: "s1",
        is_active: true,
        expires_at: null
      },
      error: null
    });

    await validateApiKey("dzfs_key_super_secret");
    const keys = __getApiKeyValidationCacheKeys();

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join("|")).not.toContain("dzfs_key_super_secret");
  });

  it("does not leak cache between different merchants", async () => {
    maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: "k1",
          merchant_id: "merchant_a",
          store_id: "s1",
          is_active: true,
          expires_at: null
        },
        error: null
      })
      .mockResolvedValueOnce({
        data: {
          id: "k2",
          merchant_id: "merchant_b",
          store_id: "s2",
          is_active: true,
          expires_at: null
        },
        error: null
      });

    const merchantA = await validateApiKey("key_for_merchant_a");
    const merchantB = await validateApiKey("key_for_merchant_b");

    expect(merchantA?.merchant_id).toBe("merchant_a");
    expect(merchantB?.merchant_id).toBe("merchant_b");
    expect(merchantA?.merchant_id).not.toBe(merchantB?.merchant_id);
  });
});
