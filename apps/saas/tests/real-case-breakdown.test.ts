import { describe, expect, it } from "vitest";
import { buildClusterInsights, buildIdentityInsights } from "@/lib/network-intelligence/identity";
import { buildNetworkRecommendation } from "@/lib/network-intelligence/scoring";
import { calculateRisk } from "@/lib/risk/engine";

describe("real case breakdown", () => {
  it("prints full factor breakdown for +213665267413 scenario", () => {
    const identity = buildIdentityInsights({
      normalizedName: "customer test",
      normalizedAddress: "alger centre bloc 5",
      wilaya: "alger",
      commune: "alger centre",
      candidates: [
        {
          id: "x1",
          phoneHashMatch: true,
          normalizedName: "customer tst",
          normalizedAddress: "alger centre bloc 5",
          wilaya: "alger",
          commune: "centre alger"
        },
        {
          id: "x2",
          phoneHashMatch: true,
          normalizedName: "other name",
          normalizedAddress: "alger centre bloc 7",
          wilaya: "alger",
          commune: "alger"
        }
      ]
    });

    const cluster = buildClusterInsights({
      addressLinkedRefusedCustomers: 2,
      phoneIdentityCount: identity.phoneIdentityCount,
      multiMerchantIncidents: 3
    });

    const network = buildNetworkRecommendation({
      totalOrders: 2,
      deliveredOrders: 0,
      returnedOrders: 0,
      refusedOrders: 1,
      cancelledOrders: 1,
      merchantCount: 2,
      suspiciousIdentityChanges: identity.suspiciousIdentityChanges,
      addressLinkedRefusedCustomers: cluster.addressLinkedRefusedCustomers,
      phoneIdentityCount: cluster.phoneIdentityCount
    });

    const risk = calculateRisk(
      {
        merchantId: "m1",
        phoneHash: "hash",
        customerName: "Customer Test",
        address: "Alger Centre Bloc 5",
        cartTotal: 2500,
        totalAmount: 2500,
        productCount: 1,
        isCod: true
      },
      {
        merchantDelivered: 0,
        merchantFailed: 0,
        merchantCancelled: 0,
        merchantReturned: 0,
        globalBadReports: 0,
        globalGoodReports: 0,
        recentIpOrders: 0,
        recentDeviceOrders: 0,
        repeatedOrdersByPhoneInWindow: 0,
        networkTotalOrders: 2,
        networkDeliveredOrders: 0,
        networkReturnedOrders: 0,
        networkRefusedOrders: 1,
        networkCancelledOrders: 1,
        networkMerchantCount: 2,
        networkReputationScore: network.score,
        networkReasons: network.reasons,
        identityConfidence: identity.confidence,
        clusterRiskScore: cluster.score,
        clusterReasons: cluster.reasons,
        suspiciousIdentityChanges: identity.suspiciousIdentityChanges
      }
    );

    console.log("REAL_CASE_BREAKDOWN", {
      phone: "+213665267413",
      networkScore: network.score,
      networkLevel: network.level,
      networkReasons: network.reasons,
      identityConfidence: identity.confidence,
      identityConfidenceScore: identity.confidenceScore,
      identityReasons: identity.reasons,
      clusterScore: cluster.score,
      clusterSummary: cluster.summary,
      clusterReasons: cluster.reasons,
      finalScore: risk.score,
      finalLevel: risk.level,
      finalAction: risk.action,
      finalReasons: risk.reasons
    });

    expect(risk.level === "HIGH" || risk.level === "CRITICAL" || risk.level === "BLOCK").toBe(true);
    expect(risk.action).not.toBe("accept");
  });
});
