import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/check-order/route";

const hoisted = vi.hoisted(() => ({
  enqueueBackgroundJobMock: vi.fn(async () => ({ id: "job_1" })),
}));

vi.mock("@/lib/security/api-key", () => ({
  validateApiKey: vi.fn(async () => ({ merchant_id: "m1", store_id: "s1" }))
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => true)
}));

vi.mock("@/lib/api/context", () => ({
  getRiskContext: vi.fn(async () => ({
    merchantDelivered: 0,
    merchantFailed: 0,
    merchantCancelled: 0,
    merchantReturned: 0,
    globalBadReports: 0,
    globalGoodReports: 0,
    recentIpOrders: 0,
    recentDeviceOrders: 0,
    repeatedOrdersByPhoneInWindow: 0
  }))
}));

vi.mock("@/lib/delivery-intelligence/reputation", () => ({
  getGlobalReputationSnapshot: vi.fn(async () => ({
    totalOrders: 0,
    deliveredOrders: 0,
    returnedOrders: 0,
    refusedOrders: 0,
    cancelledOrders: 0,
    merchantCount: 0,
    reputationScore: 50,
  })),
  upsertCustomerIdentityFromDeliveryOrder: vi.fn(async () => ({ identityId: "identity-1" })),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: hoisted.enqueueBackgroundJobMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "merchant_delivery_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ count: 1, error: null })
            })
          })
        };
      }

      if (table === "order_checks") {
        return {
          select: () => {
            let lookupCount = 0;
            const chain: any = {
              eq: () => chain,
              maybeSingle: async () => {
                lookupCount += 1;
                if (lookupCount > 1) {
                  return {
                    data: {
                      id: "check_1",
                      risk_score: 50,
                      risk_level: "LOW",
                      risk_reasons: [],
                      recommended_action: "review",
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
            };
            return chain;
          },
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => ({ data: { id: String(row.order_id ?? row.external_order_id ?? "check_1") }, error: null })
            })
          })
        };
      }

      if (table === "customer_identity") {
        return {
          select: () => {
            const chain: any = {
              eq: () => chain,
              in: () => ({
                limit: async () => ({ data: [], error: null })
              }),
              limit: async () => ({ data: [], error: null })
            };
            return chain;
          }
        };
      }

      if (table === "customer_reputation") {
        return {
          select: () => ({
            in: () => ({
              limit: async () => ({ data: [], error: null })
            })
          })
        };
      }

      if (table === "customer_delivery_stats") {
        return {
          select: () => ({
            in: () => ({
              limit: async () => ({ data: [], error: null })
            })
          })
        };
      }

      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: "check_1" }, error: null }) }) })
      };
    }
  })
}));

describe("POST /api/v1/check-order", () => {
  it("returns risk decision", async () => {
    process.env.PHONE_HASH_SECRET = "phone_secret";
    const req = new NextRequest("http://localhost:3000/api/v1/check-order", {
      method: "POST",
      headers: { authorization: "Bearer test_key" },
      body: JSON.stringify({
        orderId: "20",
        phone: "0555123456",
        customerName: "Ahmed",
        city: "Alger",
        wilaya: "Alger",
        address: "Rue 1",
        cartTotal: 2500,
        productCount: 1,
        paymentMethod: "cod",
        isCod: true
      })
    });

    const res = await POST(req);
    const body = await res.json();

    const reqRepeat = new NextRequest("http://localhost:3000/api/v1/check-order", {
      method: "POST",
      headers: { authorization: "Bearer test_key" },
      body: JSON.stringify({
        phone: "0555123456",
        customerName: "Ahmed",
        city: "Alger",
        wilaya: "Alger",
        address: "Rue 1",
        cartTotal: 2500,
        productCount: 1,
        paymentMethod: "cod",
        isCod: true
      })
    });
    const resRepeat = await POST(reqRepeat);
    const bodyRepeat = await resRepeat.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "checkId",
      "customerType",
      "duplicate",
      "estimatedDamage",
      "level",
      "localHistory",
      "reasons",
      "recommendedAction",
      "riskScore",
      "score",
      "trustLevel",
      "why",
    ]);
    expect(typeof body.riskScore).toBe("number");
    expect(Array.isArray(body.why)).toBe(true);
    expect(["NEW", "RETURNING"]).toContain(body.customerType);
    expect(body.localHistory).toMatchObject({
      customerType: body.customerType,
      totalOrders: expect.any(Number),
      deliveredOrders: expect.any(Number),
      failedOrders: expect.any(Number),
      deliverySuccessRate: expect.any(Number),
      summary: expect.any(String),
    });
    expect(body).not.toHaveProperty("merchantId");
    expect(body).not.toHaveProperty("providerId");
    expect(body).not.toHaveProperty("fingerprint");
    expect(body).not.toHaveProperty("merge_reason");
    expect(body.duplicate).toBe(false);
    expect(body.checkId).toEqual(expect.any(String));
    expect(hoisted.enqueueBackgroundJobMock).toHaveBeenCalled();
    expect(bodyRepeat.riskScore).toBe(body.riskScore);
    expect(bodyRepeat.recommendedAction).toBe(body.recommendedAction);
    expect(bodyRepeat.checkId).toEqual(expect.any(String));

    const diagnosticsHeader = res.headers.get("x-dz-risk-diagnostics");
    expect(diagnosticsHeader).toBeTruthy();
    const diagnostics = JSON.parse(String(diagnosticsHeader));
    expect(diagnostics).toMatchObject({
      phoneNormalizationMs: expect.any(Number),
      rpcSnapshotMs: expect.any(Number),
      fallbackUsed: expect.any(Boolean),
      identityLookupMs: expect.any(Number),
      customerProfileLookupMs: expect.any(Number),
      merchantHistoryLookupMs: expect.any(Number),
      networkHistoryLookupMs: expect.any(Number),
      riskEventLookupMs: expect.any(Number),
      scoringCalculationMs: expect.any(Number),
      recommendationCalculationMs: expect.any(Number),
      dbReads: expect.any(Number),
      dbWrites: expect.any(Number),
    });
  });
});
