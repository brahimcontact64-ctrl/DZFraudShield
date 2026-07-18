import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  fetchLatestOrdersMock: vi.fn(),
  recomputeMarketIntelligenceMock: vi.fn(async () => {}),
  recomputeIdentityReputationMock: vi.fn(async () => {}),
  upsertCustomerIdentityFromDeliveryOrderMock: vi.fn(async () => ({ identityId: "identity-1" })),
  accountsState: [] as Array<{
    id: string;
    merchant_id: string;
    provider: string;
    provider_name: string | null;
    base_url: string;
    auth_type: "AUTH_TYPE_TENANT_SECRET";
    credentials: Record<string, string>;
    endpoints: { orders: string; tracking?: string | null; webhook?: string | null; status?: string | null; customer?: string | null; optional?: Record<string, string> };
    field_mapping: { ordersPath: string; orderId: string; createdAt: string; lastStateUpdateAt: string };
    status_mapping: Record<string, string> | null;
    last_sync_at: string | null;
    last_created_at_synced: string | null;
    last_state_update_at_synced: string | null;
    failure_streak?: number;
    suspended_until?: string | null;
    connection_status?: string | null;
    last_error_message?: string | null;
  }> ,
  storedOrders: new Set<string>(),
}));

const { fetchLatestOrdersMock, recomputeMarketIntelligenceMock, recomputeIdentityReputationMock, upsertCustomerIdentityFromDeliveryOrderMock } = hoisted;

vi.mock("@/lib/delivery-intelligence/accounts", () => ({
  getSyncableDeliveryAccounts: vi.fn(async () => hoisted.accountsState),
}));

vi.mock("@/lib/delivery-intelligence/adapters", () => ({
  ProviderRegistry: {
    get: vi.fn(() => ({
      provider: "zr_express",
      syncOrders: hoisted.fetchLatestOrdersMock,
      testConnection: vi.fn(),
      mapOrder: vi.fn(),
      normalizeStatus: vi.fn((status: string) => status),
    })),
  },
}));

vi.mock("@/lib/delivery-intelligence/market-insights", () => ({
  recomputeMarketIntelligence: hoisted.recomputeMarketIntelligenceMock,
}));

vi.mock("@/lib/delivery-intelligence/reputation", () => ({
  recomputeIdentityReputation: hoisted.recomputeIdentityReputationMock,
  upsertCustomerIdentityFromDeliveryOrder: hoisted.upsertCustomerIdentityFromDeliveryOrderMock,
}));

vi.mock("@/lib/delivery-intelligence/normalize", () => ({
  normalizeAddress: vi.fn((value: string | null | undefined) => value ?? null),
}));

vi.mock("@/lib/security/hash", () => ({
  hashWithSecret: vi.fn(() => "phone_hash"),
}));

vi.mock("@/lib/security/phone", () => ({
  normalizeAlgerianPhone: vi.fn((value: string | null | undefined) => value ?? null),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "delivery_sync_logs") {
        return {
          insert: async () => ({ error: null }),
        };
      }

      if (table === "merchant_delivery_accounts") {
        return {
          update: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }

      if (table === "delivery_orders") {
        return {
          select: () => ({
            eq: (_merchantKey: string, merchantId: string) => ({
              eq: (_providerKey: string, provider: string) => ({
                eq: (_externalOrderIdKey: string, externalOrderId: string) => ({
                  maybeSingle: async () => {
                    const key = `${merchantId}::${provider}::${externalOrderId}`;
                    return {
                      data: hoisted.storedOrders.has(key) ? { id: key } : null,
                      error: null,
                    };
                  },
                }),
              }),
            }),
          }),
          upsert: async (row: { merchant_id: string; provider: string; external_order_id: string }) => {
            const key = `${row.merchant_id}::${row.provider}::${row.external_order_id}`;
            hoisted.storedOrders.add(key);
            return { error: null };
          },
        };
      }

      return {
        insert: async () => ({ error: null }),
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    },
  }),
}));

import { runDeliverySync } from "@/lib/delivery-intelligence/sync";

function buildOrders(count: number, prefix = "ZR", startAt = 1) {
  return Array.from({ length: count }).map((_, idx) => {
    const orderId = `${prefix}-${String(startAt + idx).padStart(3, "0")}`;
    return {
      external_order_id: orderId,
      customer_external_id: null,
      tracking_number: `TR-${orderId}`,
      customer_name: "Customer",
      customer_phone: "0555000000",
      customer_address: "Address",
      wilaya: "Alger",
      commune: "Bab Ezzouar",
      order_amount: 100,
      status: "DELIVERED" as const,
      created_at: "2026-05-01T10:00:00.000Z",
      delivered_at: null,
      returned_at: null,
      last_state_update_at: "2026-05-01T12:00:00.000Z",
      synced_at: "2026-06-01T11:00:00.000Z",
      items: [],
      raw_payload: { parcelId: orderId },
    };
  });
}

describe("runDeliverySync mode selection", () => {
  beforeEach(() => {
    fetchLatestOrdersMock.mockReset();
    recomputeMarketIntelligenceMock.mockClear();
    recomputeIdentityReputationMock.mockClear();
    upsertCustomerIdentityFromDeliveryOrderMock.mockClear();
    hoisted.accountsState.splice(0, hoisted.accountsState.length);
    hoisted.storedOrders.clear();
    process.env.PHONE_HASH_SECRET = "phone-secret";
  });

  it("uses automatic full sync on first run with no successful checkpoint and keeps all 123", async () => {
    hoisted.accountsState.push({
      id: "acc-1",
      merchant_id: "merchant-1",
      provider: "zr_express",
      provider_name: null,
      base_url: "https://api.zr.test",
      auth_type: "AUTH_TYPE_TENANT_SECRET",
      credentials: { tenantId: "tenant", secretKey: "api-key" },
      endpoints: { orders: "/api/v1/parcels/search" },
      field_mapping: { ordersPath: "parcels", orderId: "parcelId", createdAt: "createdAt", lastStateUpdateAt: "lastStateUpdateAt" },
      status_mapping: null,
      last_sync_at: null,
      last_created_at_synced: null,
      last_state_update_at_synced: null,
      failure_streak: 0,
      suspended_until: null,
      connection_status: "unknown",
      last_error_message: null,
    });

    fetchLatestOrdersMock.mockResolvedValueOnce({
      orders: buildOrders(123),
      nextCursor: null,
      latestCreatedAt: "2026-05-01T10:00:00.000Z",
      latestStateUpdateAt: "2026-05-01T12:00:00.000Z",
      metrics: {
        pagesFetched: 2,
        totalFetched: 123,
        totalKept: 123,
        totalDropped: 0,
      },
    });

    const summary = await runDeliverySync({ merchantId: "merchant-1", maxAttempts: 1 });

    expect(fetchLatestOrdersMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchLatestOrdersMock.mock.calls[0]?.[0] as { sinceCreatedAt?: string; sinceStateUpdatedAt?: string };
    expect(firstCall.sinceCreatedAt).toBeUndefined();
    expect(firstCall.sinceStateUpdatedAt).toBeUndefined();

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      mode: "full",
      pagesFetched: 2,
      parcelsFetched: 123,
      parcelsKept: 123,
      parcelsDroppedByIncrementalFilter: 0,
      ordersInserted: 123,
      ordersUpdated: 0,
      syncedOrders: 123,
      failedOrders: 0,
    });
  });

  it("uses incremental sync after successful checkpoints and tracks dropped parcels", async () => {
    hoisted.accountsState.push({
      id: "acc-2",
      merchant_id: "merchant-2",
      provider: "zr_express",
      provider_name: null,
      base_url: "https://api.zr.test",
      auth_type: "AUTH_TYPE_TENANT_SECRET",
      credentials: { tenantId: "tenant", secretKey: "api-key" },
      endpoints: { orders: "/api/v1/parcels/search" },
      field_mapping: { ordersPath: "parcels", orderId: "parcelId", createdAt: "createdAt", lastStateUpdateAt: "lastStateUpdateAt" },
      status_mapping: null,
      last_sync_at: "2026-06-01T10:00:00.000Z",
      last_created_at_synced: "2026-06-01T10:00:00.000Z",
      last_state_update_at_synced: null,
      failure_streak: 0,
      suspended_until: null,
      connection_status: "connected",
      last_error_message: null,
    });

    fetchLatestOrdersMock.mockResolvedValueOnce({
      orders: [buildOrders(1, "ZR", 500)[0]],
      nextCursor: null,
      latestCreatedAt: "2026-06-01T11:00:00.000Z",
      latestStateUpdateAt: "2026-06-01T11:30:00.000Z",
      metrics: {
        pagesFetched: 1,
        totalFetched: 2,
        totalKept: 1,
        totalDropped: 1,
      },
    });

    const summary = await runDeliverySync({ merchantId: "merchant-2", maxAttempts: 1 });

    expect(fetchLatestOrdersMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchLatestOrdersMock.mock.calls[0]?.[0] as { sinceCreatedAt?: string; sinceStateUpdatedAt?: string };
    expect(firstCall.sinceCreatedAt).toBe("2026-06-01T10:00:00.000Z");
    expect(firstCall.sinceStateUpdatedAt).toBeUndefined();

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      mode: "incremental",
      pagesFetched: 1,
      parcelsFetched: 2,
      parcelsKept: 1,
      parcelsDroppedByIncrementalFilter: 1,
      ordersInserted: 1,
      ordersUpdated: 0,
      syncedOrders: 1,
      failedOrders: 0,
    });
  });

  it("fails before fetch when placeholder credentials are detected", async () => {
    hoisted.accountsState.push({
      id: "acc-3",
      merchant_id: "merchant-3",
      provider: "zr_express",
      provider_name: null,
      base_url: "https://api.zr.test",
      auth_type: "AUTH_TYPE_TENANT_SECRET",
      credentials: {
        tenantHeaderName: "X-Tenant",
        tenantId: "tenant-audit",
        secretHeaderName: "X-Api-Key",
        secretKey: "key-audit",
      },
      endpoints: { orders: "/api/v1/parcels/search" },
      field_mapping: { ordersPath: "parcels", orderId: "parcelId", createdAt: "createdAt", lastStateUpdateAt: "lastStateUpdateAt" },
      status_mapping: null,
      last_sync_at: null,
      last_created_at_synced: null,
      last_state_update_at_synced: null,
      failure_streak: 0,
      suspended_until: null,
      connection_status: "unknown",
      last_error_message: null,
    });

    const summary = await runDeliverySync({ merchantId: "merchant-3", maxAttempts: 1 });

    expect(fetchLatestOrdersMock).not.toHaveBeenCalled();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      mode: "full",
      pagesFetched: 0,
      parcelsFetched: 0,
      parcelsKept: 0,
      parcelsDroppedByIncrementalFilter: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
      syncedOrders: 0,
      failedOrders: 1,
    });
  });
});
