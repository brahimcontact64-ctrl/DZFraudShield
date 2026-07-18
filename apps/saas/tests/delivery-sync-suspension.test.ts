import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  account: {
    id: "acc-1",
    merchant_id: "merchant-1",
    provider: "zr_express",
    provider_name: null,
    base_url: "https://api.zr.test",
    auth_type: "AUTH_TYPE_TENANT_SECRET" as const,
    credentials: { tenantId: "tenant", secretKey: "key" },
    endpoints: { orders: "/api/v1/parcels/search" },
    field_mapping: { ordersPath: "parcels", orderId: "parcelId", createdAt: "createdAt", lastStateUpdateAt: "lastStateUpdateAt" },
    status_mapping: null,
    connection_status: "failed",
    failure_streak: 2,
    suspended_until: null as string | null,
    last_error_message: null,
    last_sync_at: null as string | null,
    last_created_at_synced: null,
    last_state_update_at_synced: null,
    updated_at: null,
  },
  adapterCalls: 0,
  logs: [] as Array<Record<string, unknown>>,
  accountUpdates: [] as Array<Record<string, unknown>>,
  notificationInserts: [] as Array<Record<string, unknown>>,
  failMode: true,
}));

vi.mock("@/lib/delivery-intelligence/accounts", () => ({
  getSyncableDeliveryAccounts: vi.fn(async () => [state.account]),
}));

vi.mock("@/lib/delivery-intelligence/adapters", () => ({
  ProviderRegistry: {
    get: () => ({
      provider: "zr_express",
      testConnection: vi.fn(),
      mapOrder: vi.fn(),
      normalizeStatus: vi.fn((s: string) => s),
      syncOrders: vi.fn(async () => {
        state.adapterCalls += 1;
        if (state.failMode) {
          throw new Error("401 unauthorized");
        }
        return {
          orders: [],
          nextCursor: null,
          latestCreatedAt: null,
          latestStateUpdateAt: null,
          metrics: { pagesFetched: 1, totalFetched: 0, totalKept: 0, totalDropped: 0 },
        };
      }),
    }),
  },
}));

vi.mock("@/lib/delivery-intelligence/market-insights", () => ({
  recomputeMarketIntelligence: vi.fn(async () => {}),
}));

vi.mock("@/lib/delivery-intelligence/reputation", () => ({
  recomputeIdentityReputation: vi.fn(async () => {}),
  upsertCustomerIdentityFromDeliveryOrder: vi.fn(async () => ({ identityId: "id-1" })),
}));

vi.mock("@/lib/delivery-intelligence/normalize", () => ({
  normalizeAddress: vi.fn((v: string | null | undefined) => v ?? null),
}));

vi.mock("@/lib/delivery-intelligence/credentials-guard", () => ({
  detectPlaceholderCredentials: vi.fn(() => ({ hasPlaceholders: false, issues: [] })),
}));

vi.mock("@/lib/security/hash", () => ({
  hashWithSecret: vi.fn(() => "hash"),
}));

vi.mock("@/lib/security/phone", () => ({
  normalizeAlgerianPhone: vi.fn((v: string | null | undefined) => v ?? null),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "delivery_sync_logs") {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.logs.push(row);
            return { error: null };
          },
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }

      if (table === "merchant_delivery_accounts") {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              state.accountUpdates.push(row);
              if (typeof row.failure_streak === "number") {
                state.account.failure_streak = row.failure_streak;
              }
              if ("suspended_until" in row) {
                state.account.suspended_until = (row.suspended_until as string | null) ?? null;
              }
              if (typeof row.connection_status === "string") {
                state.account.connection_status = row.connection_status;
              }
              if (typeof row.last_sync_at === "string" || row.last_sync_at === null) {
                state.account.last_sync_at = row.last_sync_at ?? null;
              }
              return { error: null };
            },
          }),
        };
      }

      if (table === "merchant_notifications") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            state.notificationInserts.push(row);
            return { error: null };
          },
        };
      }

      if (table === "delivery_orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
          upsert: async () => ({ error: null }),
        };
      }

      return {
        insert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  }),
}));

import { runDeliverySync } from "@/lib/delivery-intelligence/sync";

describe("runDeliverySync suspension behavior", () => {
  beforeEach(() => {
    state.account.failure_streak = 2;
    state.account.suspended_until = null;
    state.account.connection_status = "failed";
    state.account.last_sync_at = null;
    state.adapterCalls = 0;
    state.logs.length = 0;
    state.accountUpdates.length = 0;
    state.notificationInserts.length = 0;
    state.failMode = true;
    process.env.PHONE_HASH_SECRET = "secret";
  });

  it("suspends account after 3rd consecutive credential failure", async () => {
    await runDeliverySync({ merchantId: "merchant-1", maxAttempts: 1 });

    const update = state.accountUpdates.find((row) => row.connection_status === "credentials_invalid");
    expect(update).toBeTruthy();
    expect(state.account.failure_streak).toBeGreaterThanOrEqual(3);
    expect(typeof state.account.suspended_until).toBe("string");
    expect(state.notificationInserts.length).toBe(1);
    expect(String(state.notificationInserts[0].message)).toContain("suspended");
  });

  it("skips sync when suspended", async () => {
    state.account.suspended_until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await runDeliverySync({ merchantId: "merchant-1", maxAttempts: 1 });

    expect(state.adapterCalls).toBe(0);
    expect(state.logs.some((row) => row.error_message === "SYNC_SKIPPED_ACCOUNT_SUSPENDED")).toBe(true);
  });

  it("resumes and resets streak after successful sync", async () => {
    state.failMode = false;
    state.account.failure_streak = 3;
    state.account.suspended_until = new Date(Date.now() - 60 * 1000).toISOString();

    await runDeliverySync({ merchantId: "merchant-1", maxAttempts: 1 });

    const successReset = state.accountUpdates.find((row) => row.connection_status === "connected");
    expect(successReset).toBeTruthy();
    expect(state.account.failure_streak).toBe(0);
    expect(state.account.suspended_until).toBeNull();
  });
});
