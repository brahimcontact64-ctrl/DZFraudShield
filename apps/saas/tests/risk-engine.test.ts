import { describe, expect, it } from "vitest";
import { calculateRisk } from "@/lib/risk/engine";

describe("risk engine", () => {
  it("returns low for trusted customer", () => {
    const result = calculateRisk(
      {
        merchantId: "m1",
        phoneHash: "hash",
        customerName: "Ahmed Ali",
        city: "Oran",
        wilaya: "Oran",
        address: "Rue 1",
        cartTotal: 5000,
        productCount: 2,
        isCod: false
      },
      {
        merchantDelivered: 5,
        merchantFailed: 0,
        merchantCancelled: 0,
        merchantReturned: 0,
        globalBadReports: 0,
        globalGoodReports: 3,
        recentIpOrders: 0,
        recentDeviceOrders: 0,
        repeatedOrdersByPhoneInWindow: 0,
        networkTotalOrders: 12,
        networkDeliveredOrders: 11,
        networkReturnedOrders: 0,
        networkRefusedOrders: 0,
        networkReputationScore: 8,
        networkMerchantCount: 2,
        identityConfidence: "HIGH",
        clusterRiskScore: 0,
        networkReasons: []
      }
    );

    expect(result.score).toBeLessThan(25);
    expect(result.level).toBe("LOW");
  });

  it("returns critical for highly suspicious order", () => {
    const result = calculateRisk(
      {
        merchantId: "m1",
        phoneHash: "hash",
        customerName: "test fake",
        city: "",
        wilaya: "",
        address: "",
        cartTotal: 0,
        productCount: 0,
        isCod: true
      },
      {
        merchantDelivered: 0,
        merchantFailed: 4,
        merchantCancelled: 2,
        merchantReturned: 3,
        globalBadReports: 5,
        globalGoodReports: 0,
        recentIpOrders: 6,
        recentDeviceOrders: 5,
        repeatedOrdersByPhoneInWindow: 4,
        networkTotalOrders: 5,
        networkDeliveredOrders: 0,
        networkReturnedOrders: 2,
        networkRefusedOrders: 3,
        networkReputationScore: 95,
        networkMerchantCount: 6,
        identityConfidence: "LOW",
        suspiciousIdentityChanges: true,
        clusterRiskScore: 40,
        networkReasons: ["+40 First refused order"]
      }
    );

    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.level).toBe("CRITICAL");
    expect(result.action).toBe("block");
  });
});
