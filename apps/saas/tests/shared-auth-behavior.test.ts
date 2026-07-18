import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as orderDecisionPOST } from "@/app/api/v1/order-decision/route";
import { POST as checkOrderPOST } from "@/app/api/v1/check-order/route";

vi.mock("@/lib/security/api-key", () => ({
  validateApiKey: vi.fn(async (key: string) => (key === "valid_key" ? { merchant_id: "m1", store_id: "s1" } : null))
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => true)
}));

vi.mock("@/lib/order-decision/engine", () => ({
  evaluateOrderDecision: vi.fn(async () => ({
    decision: "SAFE_TO_SHIP",
    trustScore: 90,
    customerType: "Reliable Customer",
    successRate: 92,
    merchantCount: 3,
    riskFactors: [],
    recommendation: "PROCEED_WITH_STANDARD_SHIPPING",
    extensions: {
      estimatedLoss: null,
      fraudProbability: null,
      networkReputationScore: null,
      aiRecommendation: null
    }
  }))
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
  upsertCustomerIdentityFromDeliveryOrder: vi.fn(async () => ({ identityId: "identity-1" }))
}));

vi.mock("@/lib/pwa/push-delivery", () => ({
  deliverMerchantPushNotifications: vi.fn(async () => ({ sent: 0, failed: 0, skipped: 0 })),
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

describe("shared auth behavior", () => {
  it("returns 401 for invalid key on both endpoints", async () => {
    const orderDecisionReq = new NextRequest("http://localhost:3000/api/v1/order-decision", {
      method: "POST",
      headers: { authorization: "Bearer invalid_key" },
      body: JSON.stringify({ phone: "0555123456" })
    });

    const checkOrderReq = new NextRequest("http://localhost:3000/api/v1/check-order", {
      method: "POST",
      headers: { authorization: "Bearer invalid_key" },
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

    const [orderDecisionRes, checkOrderRes] = await Promise.all([
      orderDecisionPOST(orderDecisionReq),
      checkOrderPOST(checkOrderReq)
    ]);

    expect(orderDecisionRes.status).toBe(401);
    expect(checkOrderRes.status).toBe(401);
  });

  it("accepts X-API-Key on both endpoints", async () => {
    process.env.PHONE_HASH_SECRET = "phone_secret";

    const orderDecisionReq = new NextRequest("http://localhost:3000/api/v1/order-decision", {
      method: "POST",
      headers: { "x-api-key": "valid_key" },
      body: JSON.stringify({ phone: "0555123456" })
    });

    const checkOrderReq = new NextRequest("http://localhost:3000/api/v1/check-order", {
      method: "POST",
      headers: { "x-api-key": "valid_key" },
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

    const [orderDecisionRes, checkOrderRes] = await Promise.all([
      orderDecisionPOST(orderDecisionReq),
      checkOrderPOST(checkOrderReq)
    ]);

    expect(orderDecisionRes.status).toBe(200);
    expect(checkOrderRes.status).toBe(200);
  });
});
