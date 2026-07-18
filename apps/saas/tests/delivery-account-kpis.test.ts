import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  logs: [] as Array<{
    account_id: string;
    status: string;
    synced_orders: number;
    imported_count: number;
    details: Record<string, unknown>;
    created_at: string;
  }>,
  notifications: [] as Array<{ account_id: string }>,
  orders: [] as Array<{ account_id: string; status: string }>,
  accounts: [
    {
      id: "acc-1",
      provider: "zr_express",
      provider_name: null,
      account_label: "Primary",
      base_url: "https://api.zr.test",
      auth_type: "AUTH_TYPE_TENANT_SECRET",
      endpoints: {},
      field_mapping: {},
      status_mapping: {},
      credentials: "encrypted",
      credential_fingerprints: {},
      active: true,
      connection_status: "connected",
      failure_streak: 0,
      suspended_until: null,
      last_connection_test_at: null,
      last_error_message: null,
      last_sync_at: "2026-06-02T10:00:00.000Z",
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-02T10:00:00.000Z",
    }
  ]
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "merchant_delivery_accounts") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: hoisted.accounts, error: null }),
            }),
          }),
        };
      }

      if (table === "delivery_sync_logs") {
        return {
          select: () => ({
            in: () => ({
              order: async () => ({ data: hoisted.logs, error: null }),
            }),
          }),
        };
      }

      if (table === "merchant_notifications") {
        return {
          select: () => ({
            eq: () => ({
              is: async () => ({ data: hoisted.notifications, error: null }),
            }),
          }),
        };
      }

      if (table === "delivery_orders") {
        return {
          select: () => ({
            in: async () => ({ data: hoisted.orders, error: null }),
          }),
        };
      }

      return {};
    },
  }),
}));

vi.mock("@/lib/security/crypto", () => ({
  decryptSecret: vi.fn(() => "{}"),
  encryptSecret: vi.fn(() => "encrypted"),
}));

vi.mock("@/lib/delivery-intelligence/provider-templates", () => ({
  resolveProviderTemplate: vi.fn(() => ({
    authType: "AUTH_TYPE_API_KEY",
    endpoints: { orders: "/orders" },
    fieldMapping: { ordersPath: "data.orders", orderId: "id" },
  })),
}));

vi.mock("@/lib/delivery-intelligence/credentials-guard", () => ({
  buildCredentialFingerprints: vi.fn(() => ({})),
  detectPlaceholderCredentials: vi.fn(() => ({ hasPlaceholders: false, issues: [] })),
  validateZrCredentialsForSave: vi.fn(),
}));

import { listMerchantDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";

describe("listMerchantDeliveryAccounts lifetime KPIs", () => {
  it("computes imported, delivered, returned and success rate", async () => {
    hoisted.orders.splice(0, hoisted.orders.length,
      ...Array.from({ length: 10 }, () => ({ account_id: "acc-1", status: "DELIVERED" })),
      ...Array.from({ length: 2 }, () => ({ account_id: "acc-1", status: "RETURNED" })),
      ...Array.from({ length: 3 }, () => ({ account_id: "acc-1", status: "PENDING" })),
    );

    const rows = await listMerchantDeliveryAccounts("merchant-1");
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.imported_orders_lifetime).toBe(15);
    expect(row.delivered_orders_lifetime).toBe(10);
    expect(row.returned_orders_lifetime).toBe(2);
    expect(row.success_rate_lifetime).toBe(83.3);
  });
});
