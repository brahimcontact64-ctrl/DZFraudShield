import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/merchant-decision/route";

vi.mock("@/lib/security/api-key", () => ({
  validateApiKey: vi.fn(async () => ({ merchant_id: "m1", store_id: "s1" }))
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => true)
}));

const createMerchantDecisionMock = vi.fn();

vi.mock("@/lib/merchant-decisions", () => ({
  createMerchantDecision: (...args: any[]) => createMerchantDecisionMock(...args)
}));

describe("POST /api/v1/merchant-decision", () => {
  it("creates a merchant decision", async () => {
    createMerchantDecisionMock.mockResolvedValueOnce({
      duplicate: false,
      eventType: "merchant_accepted_order",
      decision: {
        id: "d1",
        created_at: new Date().toISOString(),
        merchant_id: "m1",
        order_check_id: "2fac5dc1-516b-4469-a3d6-4b327f67194a",
        customer_identity_id: null,
        phone: "0555123456",
        decision: "ACCEPTED",
        decision_reason: null,
        risk_score: 22,
        risk_level: "LOW",
        network_trust_level: "NORMAL",
        recommended_action: "accept",
        notes: null
      }
    });

    const req = new NextRequest("http://localhost:3000/api/v1/merchant-decision", {
      method: "POST",
      headers: { authorization: "Bearer test_key" },
      body: JSON.stringify({
        orderCheckId: "2fac5dc1-516b-4469-a3d6-4b327f67194a",
        decision: "ACCEPTED"
      })
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.eventType).toBe("merchant_accepted_order");
    expect(body.decision.decision).toBe("ACCEPTED");
  });

  it("prevents duplicate decisions", async () => {
    createMerchantDecisionMock.mockResolvedValueOnce({
      duplicate: true,
      eventType: "merchant_accepted_order",
      decision: {
        id: "d1",
        created_at: new Date().toISOString(),
        merchant_id: "m1",
        order_check_id: "2fac5dc1-516b-4469-a3d6-4b327f67194a",
        customer_identity_id: null,
        phone: "0555123456",
        decision: "ACCEPTED",
        decision_reason: null,
        risk_score: 22,
        risk_level: "LOW",
        network_trust_level: "NORMAL",
        recommended_action: "accept",
        notes: null
      }
    });

    const req = new NextRequest("http://localhost:3000/api/v1/merchant-decision", {
      method: "POST",
      headers: { authorization: "Bearer test_key" },
      body: JSON.stringify({
        orderCheckId: "2fac5dc1-516b-4469-a3d6-4b327f67194a",
        decision: "ACCEPTED"
      })
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("already");
  });
});
