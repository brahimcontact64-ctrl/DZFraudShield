import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "@/lib/security/crypto";
import { zrExpressAdapter } from "@/lib/delivery-intelligence/adapters/zr-express-adapter";
import { buildCredentialFingerprints } from "@/lib/delivery-intelligence/credentials-guard";

const savedRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => ({
      upsert: (payload: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            savedRows.push(payload);
            return {
              data: {
                id: "acc-1",
                ...payload,
              },
              error: null,
            };
          },
        }),
      }),
    }),
  }),
}));

import { upsertMerchantDeliveryAccount } from "@/lib/delivery-intelligence/accounts";

describe("delivery credential guards", () => {
  beforeEach(() => {
    savedRows.length = 0;
    process.env.DELIVERY_ACCOUNT_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  it("fails save for placeholder ZR credentials", async () => {
    await expect(
      upsertMerchantDeliveryAccount({
        merchantId: "merchant-1",
        provider: "zr_express",
        providerName: "ZR Express",
        accountLabel: "Primary",
        baseUrl: "https://api.zrexpress.app",
        authType: "AUTH_TYPE_TENANT_SECRET",
        credentials: {
          tenantHeaderName: "X-Tenant",
          tenantId: "tenant-audit",
          secretHeaderName: "X-Api-Key",
          secretKey: "key-audit",
        },
      }),
    ).rejects.toThrow("Invalid ZR Express credentials");

    expect(savedRows).toHaveLength(0);
  });

  it("keeps tenant/api fingerprints stable across save -> encrypt -> decrypt -> adapter", async () => {
    const originalCredentials = {
      tenantHeaderName: "X-Tenant",
      tenantId: "tenant-prod-123",
      secretHeaderName: "X-Api-Key",
      secretKey: "key-prod-abc",
    };

    await upsertMerchantDeliveryAccount({
      merchantId: "merchant-1",
      provider: "zr_express",
      providerName: "ZR Express",
      accountLabel: "Primary",
      baseUrl: "https://api.zrexpress.app",
      authType: "AUTH_TYPE_TENANT_SECRET",
      credentials: originalCredentials,
    });

    expect(savedRows).toHaveLength(1);
    const persisted = savedRows[0];
    const encryptedCredentials = String(persisted.credentials ?? "");
    const decryptedCredentials = JSON.parse(decryptSecret(encryptedCredentials)) as Record<string, string>;

    const beforeSave = buildCredentialFingerprints("zr_express", originalCredentials);
    const afterDecrypt = buildCredentialFingerprints("zr_express", decryptedCredentials);
    expect(afterDecrypt).toEqual(beforeSave);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], hasNext: false })));
    vi.stubGlobal("fetch", fetchMock);

    await zrExpressAdapter.fetchLatestOrders({
      since: "2026-01-01T00:00:00.000Z",
      config: {
        baseUrl: "https://api.zrexpress.app",
        authType: "AUTH_TYPE_TENANT_SECRET",
        credentials: decryptedCredentials,
        endpoints: {
          orders: "/api/v1/parcels/search",
        },
        fieldMapping: {
          ordersPath: "items",
          orderId: "id",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers["X-Tenant"]).toBe(originalCredentials.tenantId);
    expect(headers["X-Api-Key"]).toBe(originalCredentials.secretKey);
  });
});
