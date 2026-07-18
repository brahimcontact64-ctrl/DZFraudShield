import { describe, expect, it, vi } from "vitest";
import { evaluateOrderDecision } from "@/lib/order-decision/engine";

vi.mock("@/lib/risk/unified-evaluator", () => ({
  evaluateUnifiedRisk: vi.fn()
}));

describe("order decision engine", () => {
  it("maps unified critical risk to high-risk legacy decision", async () => {
    const { evaluateUnifiedRisk } = await import("@/lib/risk/unified-evaluator");
    vi.mocked(evaluateUnifiedRisk).mockResolvedValueOnce({
      normalizedPhone: "+213555123456",
      phoneHash: "hash",
      ipHash: "ip",
      deviceHash: "device",
      addressHash: "address",
      identityId: "id-1",
      risk: {
        score: 82,
        level: "CRITICAL",
        reasons: ["+40 First refused order", "+20 Suspicious identity changes"],
        action: "block"
      },
      globalReputation: {
        totalOrders: 4,
        deliveredOrders: 1,
        returnedOrders: 1,
        refusedOrders: 2,
        cancelledOrders: 0,
        merchantCount: 3,
        providerCount: 1,
        firstSeen: null,
        lastSeen: null,
        reputationScore: 75,
        riskLevel: "HIGH"
      },
      networkIntelligence: {
        score: 79,
        level: "CRITICAL",
        recommendation: "BLOCK",
        reasons: ["+40 First refused order"],
        contributions: [],
        metrics: {
          deliveryRate: 25,
          cancellationRate: 0,
          refusedRate: 50,
          returnedRate: 25
        }
      },
      identityInsights: {
        confidence: "LOW",
        confidenceScore: 28,
        linkedIdentityCount: 3,
        phoneIdentityCount: 4,
        suspiciousIdentityChanges: true,
        reasons: ["Phone linked to 4 identities"]
      },
      clusterInsights: {
        score: 35,
        summary: "HIGH_CLUSTER_RISK",
        reasons: ["High-risk fraud cluster detected"],
        addressLinkedRefusedCustomers: 3,
        phoneIdentityCount: 4
      }
    } as any);

    const result = await evaluateOrderDecision({
      merchantId: "m1",
      phone: "0555123456",
      customerName: "Ahmed",
      address: "Rue 1",
      wilaya: "Alger",
      commune: "Alger Centre"
    });

    expect(result.decision).toBe("HIGH_RISK");
    expect(result.recommendation).toBe("DO_NOT_SHIP_HIGH_VALUE_PRODUCTS");
    expect(result.level).toBe("CRITICAL");
    expect(result.recommendedAction).toBe("block");
    expect(result.globalReputation?.merchantCount).toBe(3);
  });

  it("maps unified low risk to safe-to-ship decision", async () => {
    const { evaluateUnifiedRisk } = await import("@/lib/risk/unified-evaluator");
    vi.mocked(evaluateUnifiedRisk).mockResolvedValueOnce({
      normalizedPhone: "+213555123456",
      phoneHash: "hash",
      ipHash: "ip",
      deviceHash: "device",
      addressHash: "address",
      identityId: "id-1",
      risk: {
        score: 12,
        level: "LOW",
        reasons: ["-15 Delivery rate above 90%"],
        action: "accept"
      },
      globalReputation: {
        totalOrders: 10,
        deliveredOrders: 9,
        returnedOrders: 1,
        refusedOrders: 0,
        cancelledOrders: 0,
        merchantCount: 2,
        providerCount: 1,
        firstSeen: null,
        lastSeen: null,
        reputationScore: 15,
        riskLevel: "LOW"
      },
      networkIntelligence: {
        score: 10,
        level: "LOW",
        recommendation: "APPROVE",
        reasons: ["-15 Delivery rate above 90%"],
        contributions: [],
        metrics: {
          deliveryRate: 90,
          cancellationRate: 0,
          refusedRate: 0,
          returnedRate: 10
        }
      },
      identityInsights: {
        confidence: "HIGH",
        confidenceScore: 88,
        linkedIdentityCount: 1,
        phoneIdentityCount: 1,
        suspiciousIdentityChanges: false,
        reasons: ["Strong deterministic identity linkage"]
      },
      clusterInsights: {
        score: 0,
        summary: "LOW_CLUSTER_RISK",
        reasons: ["No strong cluster signal"],
        addressLinkedRefusedCustomers: 0,
        phoneIdentityCount: 1
      }
    } as any);

    const result = await evaluateOrderDecision({
      merchantId: "m1",
      phone: "0555123456"
    });

    expect(result.decision).toBe("SAFE_TO_SHIP");
    expect(result.recommendation).toBe("PROCEED_WITH_STANDARD_SHIPPING");
    expect(result.level).toBe("LOW");
    expect(result.recommendedAction).toBe("accept");
  });
});
