import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  row: {
    id: "acc-1",
    merchant_id: "merchant-1",
    provider: "zr_express",
    provider_name: "ZR Express",
    account_label: "Primary account",
    base_url: "https://api.zrexpress.app",
    auth_type: "AUTH_TYPE_TENANT_SECRET",
    credentials: "encrypted-zr-creds",
    credential_fingerprints: { tenantId: "fp_tenant", apiKey: "fp_key" },
    endpoints: { orders: "/api/v1/parcels/search" },
    field_mapping: { ordersPath: "data.items", orderId: "id" },
    status_mapping: { Delivered: "DELIVERED" },
    active: true,
    connection_status: "connected",
    last_error_message: null,
    failure_streak: 0,
    suspended_until: null,
    last_connection_test_at: null,
    last_sync_at: "2026-06-01T10:00:00.000Z",
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:00:00.000Z",
  } as Record<string, unknown>,
  lastUpdatePayload: null as Record<string, unknown> | null,
  adapterTestConnection: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; fetchedOrders: number; error?: string }>>(async () => ({ ok: true, fetchedOrders: 2 })),
}));

vi.mock("@/lib/supabase/server", () => {
  function isMatch(filters: Record<string, unknown>) {
    return Object.entries(filters).every(([key, value]) => hoisted.row[key] === value);
  }

  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === "delivery_sync_logs") {
          return {
            select: () => ({
              in: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }

        if (table === "merchant_notifications") {
          return {
            select: () => ({
              eq: () => ({
                is: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }

        if (table === "delivery_orders") {
          return {
            select: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          };
        }

        if (table !== "merchant_delivery_accounts") {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select: () => {
            const filters: Record<string, unknown> = {};
            return {
              eq: (key: string, value: unknown) => {
                filters[key] = value;
                return {
                  order: async () => ({
                    data: isMatch(filters) ? [{ ...hoisted.row }] : [],
                    error: null,
                  }),
                  eq: (nextKey: string, nextValue: unknown) => {
                    filters[nextKey] = nextValue;
                    return {
                      maybeSingle: async () => ({
                        data: isMatch(filters) ? { ...hoisted.row } : null,
                        error: null,
                      }),
                    };
                  },
                  maybeSingle: async () => ({
                    data: isMatch(filters) ? { ...hoisted.row } : null,
                    error: null,
                  }),
                };
              },
            };
          },
          update: (payload: Record<string, unknown>) => {
            hoisted.lastUpdatePayload = payload;
            const filters: Record<string, unknown> = {};
            return {
              eq: (key: string, value: unknown) => {
                filters[key] = value;
                return {
                  eq: (nextKey: string, nextValue: unknown) => {
                    filters[nextKey] = nextValue;
                    return {
                      select: () => ({
                        maybeSingle: async () => {
                          if (!isMatch(filters)) {
                            return { data: null, error: null };
                          }

                          hoisted.row = {
                            ...hoisted.row,
                            ...payload,
                          };

                          return {
                            data: { ...hoisted.row },
                            error: null,
                          };
                        },
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    }),
  };
});

vi.mock("@/lib/security/crypto", () => ({
  decryptSecret: vi.fn((value: string) => {
    if (value === "encrypted-zr-creds") {
      return JSON.stringify({
        tenantHeaderName: "X-Tenant",
        tenantId: "tenant-prod-1",
        secretHeaderName: "X-Api-Key",
        secretKey: "key-prod-1",
      });
    }

    return "{}";
  }),
  encryptSecret: vi.fn((value: string) => value),
}));

vi.mock("@/lib/delivery-intelligence/provider-templates", () => ({
  resolveProviderTemplate: vi.fn(() => ({
    authType: "AUTH_TYPE_TENANT_SECRET",
    endpoints: { orders: "/api/v1/parcels/search" },
    fieldMapping: { ordersPath: "data.items", orderId: "id" },
  })),
}));

vi.mock("@/lib/delivery-intelligence/credentials-guard", () => ({
  buildCredentialFingerprints: vi.fn(() => ({ tenantId: "fp_tenant", apiKey: "fp_key" })),
  detectPlaceholderCredentials: vi.fn(() => ({ hasPlaceholders: false, issues: [] })),
  validateZrCredentialsForSave: vi.fn(),
  // Pass-through for non-Yalidine providers (zr_express is used in this test)
  buildYalidineRuntimeCredentials: vi.fn((_provider: string, credentials: Record<string, string>) => credentials),
  normalizeYalidineCredentialsForStorage: vi.fn((_provider: string, credentials: Record<string, string>) => credentials),
}));

vi.mock("@/lib/delivery-intelligence/adapters", () => ({
  ProviderRegistry: {
    get: () => ({
      provider: "zr_express",
      testConnection: hoisted.adapterTestConnection,
      syncOrders: vi.fn(),
      mapOrder: vi.fn(),
      normalizeStatus: vi.fn(),
    }),
  },
}));

import { disconnectMerchantDeliveryAccount, reconnectMerchantDeliveryAccount } from "@/lib/delivery-intelligence/accounts";
import { listMerchantDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";

describe("delivery reconnect state", () => {
  beforeEach(() => {
    hoisted.row = {
      id: "acc-1",
      merchant_id: "merchant-1",
      provider: "zr_express",
      provider_name: "ZR Express",
      account_label: "Primary account",
      base_url: "https://api.zrexpress.app",
      auth_type: "AUTH_TYPE_TENANT_SECRET",
      credentials: "encrypted-zr-creds",
      credential_fingerprints: { tenantId: "fp_tenant", apiKey: "fp_key" },
      endpoints: { orders: "/api/v1/parcels/search" },
      field_mapping: { ordersPath: "data.items", orderId: "id" },
      status_mapping: { Delivered: "DELIVERED" },
      active: true,
      connection_status: "connected",
      last_error_message: null,
      failure_streak: 0,
      suspended_until: null,
      last_connection_test_at: null,
      last_sync_at: "2026-06-01T10:00:00.000Z",
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-01T10:00:00.000Z",
    };
    hoisted.lastUpdatePayload = null;
    hoisted.adapterTestConnection.mockReset();
    hoisted.adapterTestConnection.mockResolvedValue({ ok: true, fetchedOrders: 2 });
  });

  it("disconnect only changes active and status while preserving credentials and mappings", async () => {
    const before = { ...hoisted.row };

    const result = await disconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });

    expect(result.active).toBe(false);
    expect(result.connection_status).toBe("inactive");

    expect(hoisted.lastUpdatePayload).toBeTruthy();
    const updateKeys = Object.keys(hoisted.lastUpdatePayload ?? {}).sort();
    expect(updateKeys).toEqual(["active", "connection_status", "updated_at"]);

    expect(hoisted.row.credentials).toBe(before.credentials);
    expect(hoisted.row.credential_fingerprints).toEqual(before.credential_fingerprints);
    expect(hoisted.row.field_mapping).toEqual(before.field_mapping);
    expect(hoisted.row.endpoints).toEqual(before.endpoints);
  });

  it("reconnect uses stored encrypted credentials and reactivates account without credential input", async () => {
    await disconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });

    const reconnectResult = await reconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });

    expect(hoisted.adapterTestConnection).toHaveBeenCalledTimes(1);
    const firstCall = hoisted.adapterTestConnection.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected reconnect testConnection call");
    }
    const adapterCall = firstCall[0] as {
      config: { credentials: Record<string, string>; baseUrl: string };
    };
    expect(adapterCall.config.baseUrl).toBe("https://api.zrexpress.app");
    expect(adapterCall.config.credentials.tenantId).toBe("tenant-prod-1");
    expect(adapterCall.config.credentials.secretKey).toBe("key-prod-1");

    expect(reconnectResult.ok).toBe(true);
    expect(reconnectResult.account.active).toBe(true);
    expect(reconnectResult.account.connection_status).toBe("connected");
    expect(hoisted.row.credentials).toBe("encrypted-zr-creds");
    expect(hoisted.row.credential_fingerprints).toEqual({ tenantId: "fp_tenant", apiKey: "fp_key" });
  });

  it("reconnect failure keeps account disconnected and sets failed status", async () => {
    await disconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });

    hoisted.adapterTestConnection.mockResolvedValue({
      ok: false,
      fetchedOrders: 0,
      error: "401 Unauthorized",
    });

    const reconnectResult = await reconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });

    expect(reconnectResult.ok).toBe(false);
    expect(reconnectResult.error).toBe("401 Unauthorized");
    expect(reconnectResult.account.active).toBe(false);
    expect(reconnectResult.account.connection_status).toBe("failed");
    expect(hoisted.row.credentials).toBe("encrypted-zr-creds");
  });

  it("persists account across refresh-style reads through disconnect and reconnect", async () => {
    const beforeRows = await listMerchantDeliveryAccounts("merchant-1");
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].active).toBe(true);
    expect(beforeRows[0].has_stored_credentials).toBe(true);

    await disconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });

    const afterDisconnectRows = await listMerchantDeliveryAccounts("merchant-1");
    expect(afterDisconnectRows).toHaveLength(1);
    expect(afterDisconnectRows[0].active).toBe(false);
    expect(afterDisconnectRows[0].has_stored_credentials).toBe(true);
    expect(afterDisconnectRows[0].connection_status).toBe("inactive");

    const reconnectResult = await reconnectMerchantDeliveryAccount({
      merchantId: "merchant-1",
      accountId: "acc-1",
    });
    expect(reconnectResult.ok).toBe(true);

    const afterReconnectRows = await listMerchantDeliveryAccounts("merchant-1");
    expect(afterReconnectRows).toHaveLength(1);
    expect(afterReconnectRows[0].active).toBe(true);
    expect(afterReconnectRows[0].connection_status).toBe("connected");
    expect(afterReconnectRows[0].has_stored_credentials).toBe(true);
  });
});
