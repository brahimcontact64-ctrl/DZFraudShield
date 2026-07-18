import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  account: {
    id: "acc-yal-1",
    merchant_id: "merchant-1",
    provider: "yalidine",
    provider_name: null,
    base_url: "https://api.yalidine.app",
    auth_type: "AUTH_TYPE_API_KEY" as const,
    credentials: { tenantId: "tenant", apiKey: "token" },
    endpoints: { orders: "/v1/parcels/?page_size=200" },
    field_mapping: { ordersPath: "data", orderId: "id", createdAt: "created_at", lastStateUpdateAt: "updated_at" },
    status_mapping: null,
    connection_status: "connected",
    failure_streak: 0,
    suspended_until: null as string | null,
    last_error_message: null as string | null,
    last_sync_at: null as string | null,
    last_created_at_synced: null,
    last_state_update_at_synced: null,
    updated_at: null,
  },
  logs: [] as Array<Record<string, unknown>>,
  accountUpdates: [] as Array<Record<string, unknown>>,
  syncErrorMessage: "fetch failed",
}));

vi.mock("@/lib/delivery-intelligence/accounts", () => ({
  getSyncableDeliveryAccounts: vi.fn(async () => [state.account]),
}));

vi.mock("@/lib/delivery-intelligence/adapters", () => ({
  ProviderRegistry: {
    get: () => ({
      provider: "yalidine",
      testConnection: vi.fn(),
      mapOrder: vi.fn(),
      normalizeStatus: vi.fn((s: string) => s),
      syncOrders: vi.fn(async () => {
        throw new Error(state.syncErrorMessage);
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

vi.mock("@/lib/delivery-intelligence/delivery-cache", () => ({
  syncStaleDeliveryCache: vi.fn(async () => []),
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
              if (typeof row.connection_status === "string") {
                state.account.connection_status = row.connection_status;
              }
              if ("suspended_until" in row) {
                state.account.suspended_until = (row.suspended_until as string | null) ?? null;
              }
              if (typeof row.last_error_message === "string" || row.last_error_message === null) {
                state.account.last_error_message = (row.last_error_message as string | null) ?? null;
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
          insert: async () => ({ error: null }),
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

describe("Yalidine account state safety", () => {
  beforeEach(() => {
    state.account.connection_status = "connected";
    state.account.failure_streak = 0;
    state.account.suspended_until = null;
    state.account.last_error_message = null;
    state.logs.length = 0;
    state.accountUpdates.length = 0;
  });

  it("marks Yalidine transport sync failures as attention_required", async () => {
    state.syncErrorMessage = "fetch failed";

    await runDeliverySync({ merchantId: "merchant-1", maxAttempts: 1 });

    const update = state.accountUpdates.find((row) => row.connection_status === "attention_required");
    expect(update).toBeTruthy();

    const failureLog = state.logs.find((row) => row.status === "failed");
    expect(failureLog).toBeTruthy();
    expect(failureLog?.details).toMatchObject({
      credentialsInvalid: false,
    });
  });

  it("marks Yalidine 401/403 as failed", async () => {
    state.syncErrorMessage = "Provider yalidine responded 401 at https://api.yalidine.app/v1/parcels/?page_size=200: unauthorized";

    await runDeliverySync({ merchantId: "merchant-1", maxAttempts: 1 });

    const update = state.accountUpdates.find((row) => row.connection_status === "failed");
    expect(update).toBeTruthy();

    const failureLog = state.logs.find((row) => row.status === "failed");
    expect(failureLog).toBeTruthy();
    expect(failureLog?.details).toMatchObject({
      credentialsInvalid: true,
    });
  });
});
