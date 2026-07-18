import { describe, expect, it } from "vitest";
import { buildNetworkRecommendation } from "@/lib/network-intelligence/scoring";
import { buildClusterInsights, buildIdentityInsights } from "@/lib/network-intelligence/identity";

describe("network intelligence scoring", () => {
  it("escalates single refused history out of one order", () => {
    const result = buildNetworkRecommendation({
      totalOrders: 1,
      deliveredOrders: 0,
      returnedOrders: 0,
      refusedOrders: 1,
      cancelledOrders: 0,
      merchantCount: 1,
      suspiciousIdentityChanges: false,
      addressLinkedRefusedCustomers: 0,
      phoneIdentityCount: 1
    });

    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.level).not.toBe("LOW");
    expect(result.recommendation).toBe("REVIEW");
  });

  it("blocks when network and identity risk stack together", () => {
    const result = buildNetworkRecommendation({
      totalOrders: 8,
      deliveredOrders: 1,
      returnedOrders: 2,
      refusedOrders: 3,
      cancelledOrders: 2,
      merchantCount: 4,
      suspiciousIdentityChanges: true,
      addressLinkedRefusedCustomers: 3,
      phoneIdentityCount: 4
    });

    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.level).toBe("CRITICAL");
    expect(result.recommendation).toBe("BLOCK");
  });
});

describe("identity and cluster insights", () => {
  it("returns low confidence when aliases are noisy", () => {
    const insights = buildIdentityInsights({
      normalizedName: "ahmed ali",
      normalizedAddress: "rue test alger",
      wilaya: "alger",
      commune: "alger centre",
      candidates: [
        {
          id: "i2",
          phoneHashMatch: true,
          normalizedName: "ahmed a",
          normalizedAddress: "rue test alger",
          wilaya: "Alger",
          commune: "Alger Centre"
        },
        {
          id: "i3",
          phoneHashMatch: true,
          normalizedName: "karim",
          normalizedAddress: "rue 2 alger",
          wilaya: "Alger",
          commune: "Bab Ezzouar"
        },
        {
          id: "i4",
          phoneHashMatch: true,
          normalizedName: "nour",
          normalizedAddress: "rue 3 alger",
          wilaya: "Alger",
          commune: "Hydra"
        }
      ]
    });

    expect(insights.phoneIdentityCount).toBe(4);
    expect(insights.suspiciousIdentityChanges).toBe(true);
  });

  it("flags medium or high cluster score on connected incidents", () => {
    const cluster = buildClusterInsights({
      addressLinkedRefusedCustomers: 3,
      phoneIdentityCount: 3,
      multiMerchantIncidents: 4
    });

    expect(cluster.score).toBeGreaterThanOrEqual(20);
    expect(cluster.reasons.length).toBeGreaterThan(0);
  });
});
