import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Supabase mock factory ────────────────────────────────────────────────────

function makeMerchantMock(opts: {
  existingMerchant?: { id: string } | null;
  insertedMerchant?: { id: string } | null;
  insertMerchantError?: boolean;
  existingKey?: { id: string } | null;
}) {
  const maybeSingleMerchant = vi.fn().mockResolvedValue({
    data: opts.existingMerchant ?? null,
    error: null
  });
  const maybeSingleKey = vi.fn().mockResolvedValue({
    data: opts.existingKey ?? null,
    error: null
  });

  const singleMerchantInsert = vi.fn().mockResolvedValue(
    opts.insertMerchantError
      ? { data: null, error: { message: "unique_violation" } }
      : { data: opts.insertedMerchant ?? null, error: null }
  );

  const keyInsert = vi.fn().mockResolvedValue({ data: null, error: null });

  const from = vi.fn((table: string) => {
    if (table === "merchants") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: maybeSingleMerchant })
            })
          })
        }),
        insert: () => ({
          select: () => ({ single: singleMerchantInsert })
        }),
        update: () => ({
          eq: () => ({ is: () => Promise.resolve({ error: null }) })
        })
      };
    }
    if (table === "merchant_api_keys") {
      return {
        select: () => ({
          eq: () => ({
            limit: () => ({ maybeSingle: maybeSingleKey })
          })
        }),
        insert: keyInsert
      };
    }
    return {};
  });

  return { from, singleMerchantInsert, keyInsert, maybeSingleMerchant, maybeSingleKey };
}

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn()
}));

vi.mock("@/lib/security/api-key", () => ({
  hashApiKeyForStorage: vi.fn(() => "hashed_key_value")
}));

vi.mock("@/lib/security/hash", () => ({
  generateApiKey: vi.fn(() => "dzfs_testapikey1234567890")
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ensureMerchantForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing merchant id without inserting", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({ existingMerchant: { id: "existing-merchant-1" } });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { ensureMerchantForUser } = await import("@/lib/merchant/provisioning");
    const id = await ensureMerchantForUser({ id: "user-1", email: "user@example.com" });

    expect(id).toBe("existing-merchant-1");
    expect(mock.singleMerchantInsert).not.toHaveBeenCalled();
  });

  it("creates a new merchant when none exists and returns id", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({
      existingMerchant: null,
      insertedMerchant: { id: "new-merchant-1" }
    });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { ensureMerchantForUser } = await import("@/lib/merchant/provisioning");
    const id = await ensureMerchantForUser({ id: "user-2", email: "newuser@example.com" });

    expect(id).toBe("new-merchant-1");
    expect(mock.singleMerchantInsert).toHaveBeenCalledOnce();
  });

  it("recovers from race condition on insert failure", async () => {
    const { createClient } = await import("@/lib/supabase/server");

    // First select returns null, insert fails, second select (race recovery) returns a merchant
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })      // first lookup: no merchant
      .mockResolvedValueOnce({ data: { id: "race-merchant-1" }, error: null }); // race recovery

    const singleInsert = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "unique_violation" }
    });

    const from = vi.fn((table: string) => {
      if (table === "merchants") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ maybeSingle })
              })
            })
          }),
          insert: () => ({
            select: () => ({ single: singleInsert })
          })
        };
      }
      return {};
    });

    vi.mocked(createClient).mockReturnValue({ from } as any);

    const { ensureMerchantForUser } = await import("@/lib/merchant/provisioning");
    const id = await ensureMerchantForUser({ id: "user-3", email: "race@example.com" });

    expect(id).toBe("race-merchant-1");
  });

  it("does not create duplicate merchants for the same user", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({ existingMerchant: { id: "existing-merchant-1" } });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { ensureMerchantForUser } = await import("@/lib/merchant/provisioning");
    await ensureMerchantForUser({ id: "user-1", email: "user@example.com" });
    await ensureMerchantForUser({ id: "user-1", email: "user@example.com" });

    expect(mock.singleMerchantInsert).not.toHaveBeenCalled();
  });
});

describe("ensureDefaultApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not create key if one already exists", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({ existingKey: { id: "existing-key-1" } });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { ensureDefaultApiKey } = await import("@/lib/merchant/provisioning");
    await ensureDefaultApiKey("merchant-1");

    expect(mock.keyInsert).not.toHaveBeenCalled();
  });

  it("creates a default key when merchant has none", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({ existingKey: null });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { ensureDefaultApiKey } = await import("@/lib/merchant/provisioning");
    await ensureDefaultApiKey("merchant-2");

    expect(mock.keyInsert).toHaveBeenCalledOnce();
    const insertArg = mock.keyInsert.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      merchant_id: "merchant-2",
      key_name: "Default Key",
      is_active: true
    });
  });
});

describe("provisionMerchant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provisions merchant and default key for new signup", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({
      existingMerchant: null,
      insertedMerchant: { id: "new-merchant-1" },
      existingKey: null
    });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { provisionMerchant } = await import("@/lib/merchant/provisioning");
    const result = await provisionMerchant({ id: "user-new", email: "new@example.com" });

    expect(result.merchantId).toBe("new-merchant-1");
    expect(mock.singleMerchantInsert).toHaveBeenCalledOnce();
    expect(mock.keyInsert).toHaveBeenCalledOnce();
  });

  it("is idempotent for existing merchant with existing key", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({
      existingMerchant: { id: "existing-merchant-1" },
      existingKey: { id: "existing-key-1" }
    });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { provisionMerchant } = await import("@/lib/merchant/provisioning");
    const result = await provisionMerchant({ id: "user-existing", email: "existing@example.com" });

    expect(result.merchantId).toBe("existing-merchant-1");
    expect(mock.singleMerchantInsert).not.toHaveBeenCalled();
    expect(mock.keyInsert).not.toHaveBeenCalled();
  });

  it("creates key for existing merchant without a key (login without API key)", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({
      existingMerchant: { id: "existing-merchant-1" },
      existingKey: null
    });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { provisionMerchant } = await import("@/lib/merchant/provisioning");
    const result = await provisionMerchant({ id: "user-nokey", email: "nokey@example.com" });

    expect(result.merchantId).toBe("existing-merchant-1");
    expect(mock.singleMerchantInsert).not.toHaveBeenCalled();
    expect(mock.keyInsert).toHaveBeenCalledOnce();
  });

  it("creates merchant for login when merchant row missing (login without merchant)", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    const mock = makeMerchantMock({
      existingMerchant: null,
      insertedMerchant: { id: "recreated-merchant-1" },
      existingKey: null
    });
    vi.mocked(createClient).mockReturnValue({ from: mock.from } as any);

    const { provisionMerchant } = await import("@/lib/merchant/provisioning");
    const result = await provisionMerchant({ id: "user-norow", email: "norow@example.com" });

    expect(result.merchantId).toBe("recreated-merchant-1");
    expect(mock.keyInsert).toHaveBeenCalledOnce();
  });
});
