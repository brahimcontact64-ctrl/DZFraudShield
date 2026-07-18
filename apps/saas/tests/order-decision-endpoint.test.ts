import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/order-decision/route";

vi.mock("@/lib/security/api-key", () => ({
  validateApiKey: vi.fn(async () => ({ merchant_id: "m1", store_id: "s1" }))
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => true)
}));

vi.mock("@/lib/order-decision/engine", () => ({
  evaluateOrderDecision: vi.fn(async () => ({
    decision: "HIGH_RISK",
    trustScore: 22,
    customerType: "Possible Fake Buyer",
    successRate: 18,
    merchantCount: 7,
    riskFactors: ["FAKE_ORDER", "CLIENT_CANCELLED", "NO_ANSWER"],
    recommendation: "DO_NOT_SHIP_HIGH_VALUE_PRODUCTS",
    extensions: {
      estimatedLoss: null,
      fraudProbability: null,
      networkReputationScore: null,
      aiRecommendation: null
    }
  }))
}));

describe("POST /api/v1/order-decision", () => {
  it("returns order decision response with Authorization Bearer", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/order-decision", {
      method: "POST",
      headers: { authorization: "Bearer test_key" },
      body: JSON.stringify({
        phone: "0555123456",
        customerName: "Ahmed",
        address: "Rue 1",
        wilaya: "Alger",
        commune: "Alger Centre"
      })
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.decision).toBe("HIGH_RISK");
    expect(body.trustScore).toBe(22);
    expect(body.riskFactors).toContain("FAKE_ORDER");
  });

  it("returns order decision response with X-API-Key", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/order-decision", {
      method: "POST",
      headers: { "x-api-key": "test_key" },
      body: JSON.stringify({
        phone: "0555123456"
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 for invalid key", async () => {
    const { validateApiKey } = await import("@/lib/security/api-key");
    vi.mocked(validateApiKey).mockResolvedValueOnce(null as any);

    const req = new NextRequest("http://localhost:3000/api/v1/order-decision", {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
      body: JSON.stringify({ phone: "0555123456" })
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid API key");
  });
});
