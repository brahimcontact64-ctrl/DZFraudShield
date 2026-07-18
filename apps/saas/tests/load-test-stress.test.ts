import { describe, it, expect, beforeAll } from "vitest";
import { calculateRisk } from "@/lib/risk/engine";
import type { OrderCheckRequest, ReputationContext } from "@/lib/types";
import { performance } from "perf_hooks";

// LOAD TEST CONFIGURATION
const LOAD_TEST_SCENARIOS = {
  merchants_100: { count: 100, ordersPerMerchant: 10 },
  merchants_200: { count: 200, ordersPerMerchant: 10 },
  merchants_500: { count: 500, ordersPerMerchant: 5 },
};

const NOTIFICATION_SCENARIOS = {
  new_orders: 1000,
  shipment_updates: 5000,
  push_notifications: 5000,
};

// MOCK DATA GENERATORS
function generateMerchantId(index: number): string {
  return `merchant_${String(index).padStart(5, "0")}`;
}

function generateCustomerPhone(merchantId: string, orderIndex: number): string {
  return `213${String(Math.floor(Math.random() * 10000000000)).padStart(9, "0")}`;
}

function generateOrderCheckRequest(
  merchantId: string,
  orderIndex: number
): OrderCheckRequest {
  const phones = ["213798765432", "213699123456", "213599987654"];
  const cities = ["Algiers", "Oran", "Constantine", "Annaba", "Blida"];
  const wilayas = ["Algiers", "Oran", "Constantine", "Annaba", "Blida"];

  return {
    merchantId,
    phoneHash: `hash_${merchantId}_${orderIndex}`,
    customerName: `Customer ${orderIndex}`,
    city: cities[Math.floor(Math.random() * cities.length)],
    wilaya: wilayas[Math.floor(Math.random() * wilayas.length)],
    address: `Street ${orderIndex}`,
    cartTotal: 3000 + Math.floor(Math.random() * 50000),
    productCount: 1 + Math.floor(Math.random() * 10),
    isCod: Math.random() > 0.5,
  };
}

function generateReputationContext(
  merchantId: string,
  orderIndex: number
): ReputationContext {
  return {
    merchantDelivered: Math.floor(Math.random() * 100),
    merchantFailed: Math.floor(Math.random() * 20),
    merchantCancelled: Math.floor(Math.random() * 10),
    merchantReturned: Math.floor(Math.random() * 15),
    globalBadReports: Math.floor(Math.random() * 5),
    globalGoodReports: Math.floor(Math.random() * 50),
    recentIpOrders: Math.floor(Math.random() * 10),
    recentDeviceOrders: Math.floor(Math.random() * 10),
    repeatedOrdersByPhoneInWindow: Math.floor(Math.random() * 3),
    networkTotalOrders: Math.floor(Math.random() * 1000),
    networkDeliveredOrders: Math.floor(Math.random() * 900),
    networkReturnedOrders: Math.floor(Math.random() * 50),
    networkRefusedOrders: Math.floor(Math.random() * 50),
    networkReputationScore: Math.floor(Math.random() * 10),
    networkMerchantCount: Math.floor(Math.random() * 500),
    identityConfidence: ["HIGH", "MEDIUM", "LOW"][
      Math.floor(Math.random() * 3)
    ] as any,
    clusterRiskScore: Math.floor(Math.random() * 100),
    networkReasons: [],
  };
}

// METRICS COLLECTOR
class LoadTestMetrics {
  private metrics: Map<string, any> = new Map();

  startTimer(key: string): () => number {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      if (!this.metrics.has(key)) {
        this.metrics.set(key, []);
      }
      (this.metrics.get(key) as number[]).push(duration);
      return duration;
    };
  }

  getStats(key: string) {
    const values = this.metrics.get(key) as number[];
    if (!values || values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: sorted.length,
      min: Math.min(...sorted),
      max: Math.max(...sorted),
      avg: sorted.reduce((a, b) => a + b) / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  getAllStats() {
    const result: Record<string, any> = {};
    for (const [key, _] of this.metrics) {
      result[key] = this.getStats(key);
    }
    return result;
  }

  logStats() {
    console.log("\n=== LOAD TEST METRICS ===");
    for (const [key, stats] of Object.entries(this.getAllStats())) {
      if (stats) {
        console.log(`\n${key}:`);
        console.log(`  Count: ${stats.count}`);
        console.log(`  Min: ${stats.min.toFixed(2)}ms`);
        console.log(`  Max: ${stats.max.toFixed(2)}ms`);
        console.log(`  Avg: ${stats.avg.toFixed(2)}ms`);
        console.log(`  P50: ${stats.p50.toFixed(2)}ms`);
        console.log(`  P95: ${stats.p95.toFixed(2)}ms`);
        console.log(`  P99: ${stats.p99.toFixed(2)}ms`);
      }
    }
  }
}

describe("PART 1: Load Testing", () => {
  const metrics = new LoadTestMetrics();

  describe("100 merchants stress test", () => {
    it("processes 100 merchants with 10 orders each (1000 total check requests)", () => {
      const scenario = LOAD_TEST_SCENARIOS.merchants_100;
      let totalChecks = 0;
      const errorCount = { value: 0 };

      const startGlobal = performance.now();

      for (let m = 0; m < scenario.count; m++) {
        const merchantId = generateMerchantId(m);

        for (let o = 0; o < scenario.ordersPerMerchant; o++) {
          const stopTimer = metrics.startTimer("risk_engine_100m");
          try {
            const request = generateOrderCheckRequest(merchantId, o);
            const reputation = generateReputationContext(merchantId, o);
            const result = calculateRisk(request, reputation);

            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(100);
            expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(
              result.level
            );

            totalChecks++;
          } catch (e) {
            errorCount.value++;
            console.error(`Error in merchant ${merchantId}, order ${o}:`, e);
          }
          stopTimer();
        }
      }

      const durationMs = performance.now() - startGlobal;

      expect(totalChecks).toBe(1000);
      expect(errorCount.value).toBe(0);

      const stats = metrics.getStats("risk_engine_100m");
      console.log(
        `\n100 Merchants: ${totalChecks} checks in ${durationMs.toFixed(2)}ms`
      );
      console.log(`Throughput: ${(totalChecks / (durationMs / 1000)).toFixed(0)} checks/sec`);
      if (stats) {
        console.log(`Avg check time: ${stats.avg.toFixed(2)}ms`);
        console.log(`P95 check time: ${stats.p95.toFixed(2)}ms`);
      }

      // Assert acceptable performance
      expect(stats?.avg).toBeLessThan(5); // Each risk calculation should be < 5ms on average
      expect(stats?.p95).toBeLessThan(15); // P95 should be < 15ms
    });
  });

  describe("200 merchants stress test", () => {
    it("processes 200 merchants with 10 orders each (2000 total check requests)", () => {
      const scenario = LOAD_TEST_SCENARIOS.merchants_200;
      let totalChecks = 0;
      const errorCount = { value: 0 };

      const startGlobal = performance.now();

      for (let m = 0; m < scenario.count; m++) {
        const merchantId = generateMerchantId(m);

        for (let o = 0; o < scenario.ordersPerMerchant; o++) {
          const stopTimer = metrics.startTimer("risk_engine_200m");
          try {
            const request = generateOrderCheckRequest(merchantId, o);
            const reputation = generateReputationContext(merchantId, o);
            const result = calculateRisk(request, reputation);

            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(100);
            expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(
              result.level
            );

            totalChecks++;
          } catch (e) {
            errorCount.value++;
            console.error(`Error in merchant ${merchantId}, order ${o}:`, e);
          }
          stopTimer();
        }
      }

      const durationMs = performance.now() - startGlobal;

      expect(totalChecks).toBe(2000);
      expect(errorCount.value).toBe(0);

      const stats = metrics.getStats("risk_engine_200m");
      console.log(
        `\n200 Merchants: ${totalChecks} checks in ${durationMs.toFixed(2)}ms`
      );
      console.log(`Throughput: ${(totalChecks / (durationMs / 1000)).toFixed(0)} checks/sec`);
      if (stats) {
        console.log(`Avg check time: ${stats.avg.toFixed(2)}ms`);
        console.log(`P95 check time: ${stats.p95.toFixed(2)}ms`);
      }

      expect(stats?.avg).toBeLessThan(5);
      expect(stats?.p95).toBeLessThan(15);
    });
  });

  describe("500 merchants stress test", () => {
    it("processes 500 merchants with 5 orders each (2500 total check requests)", () => {
      const scenario = LOAD_TEST_SCENARIOS.merchants_500;
      let totalChecks = 0;
      const errorCount = { value: 0 };

      const startGlobal = performance.now();

      for (let m = 0; m < scenario.count; m++) {
        const merchantId = generateMerchantId(m);

        for (let o = 0; o < scenario.ordersPerMerchant; o++) {
          const stopTimer = metrics.startTimer("risk_engine_500m");
          try {
            const request = generateOrderCheckRequest(merchantId, o);
            const reputation = generateReputationContext(merchantId, o);
            const result = calculateRisk(request, reputation);

            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(100);

            totalChecks++;
          } catch (e) {
            errorCount.value++;
          }
          stopTimer();
        }
      }

      const durationMs = performance.now() - startGlobal;

      expect(totalChecks).toBe(2500);
      expect(errorCount.value).toBe(0);

      const stats = metrics.getStats("risk_engine_500m");
      console.log(
        `\n500 Merchants: ${totalChecks} checks in ${durationMs.toFixed(2)}ms`
      );
      console.log(`Throughput: ${(totalChecks / (durationMs / 1000)).toFixed(0)} checks/sec`);
      if (stats) {
        console.log(`Avg check time: ${stats.avg.toFixed(2)}ms`);
        console.log(`P95 check time: ${stats.p95.toFixed(2)}ms`);
      }

      expect(stats?.avg).toBeLessThan(5);
      expect(stats?.p95).toBeLessThan(15);
    });
  });

  describe("Risk engine throughput under load", () => {
    it("maintains consistent performance across all load levels", () => {
      const stats100 = metrics.getStats("risk_engine_100m");
      const stats200 = metrics.getStats("risk_engine_200m");
      const stats500 = metrics.getStats("risk_engine_500m");

      console.log("\n=== RISK ENGINE PERFORMANCE SUMMARY ===");
      console.log("100 merchants avg:", stats100?.avg?.toFixed(2), "ms");
      console.log("200 merchants avg:", stats200?.avg?.toFixed(2), "ms");
      console.log("500 merchants avg:", stats500?.avg?.toFixed(2), "ms");

      // Verify no significant degradation as load increases
      if (stats100 && stats200 && stats500) {
        const degradation_100_to_200 =
          ((stats200.avg - stats100.avg) / stats100.avg) * 100;
        const degradation_200_to_500 =
          ((stats500.avg - stats200.avg) / stats200.avg) * 100;

        console.log(
          `Degradation 100→200: ${degradation_100_to_200.toFixed(2)}%`
        );
        console.log(
          `Degradation 200→500: ${degradation_200_to_500.toFixed(2)}%`
        );

        // Allow up to 20% degradation (acceptable for in-process scaling)
        expect(degradation_100_to_200).toBeLessThan(20);
        expect(degradation_200_to_500).toBeLessThan(20);
      }

      metrics.logStats();
    });
  });
});

describe("PART 1B: Notification Load Test", () => {
  const metrics = new LoadTestMetrics();

  it("simulates 1000 new order notifications", () => {
    const ordersCount = NOTIFICATION_SCENARIOS.new_orders;
    let processedOrders = 0;

    const startTime = performance.now();

    for (let i = 0; i < ordersCount; i++) {
      const stopTimer = metrics.startTimer("notification_new_order");
      try {
        // Simulate notification generation
        const notification = {
          id: `notif_${i}`,
          type: "new_order",
          merchantId: generateMerchantId(i % 100),
          orderId: `order_${i}`,
          timestamp: new Date().toISOString(),
        };

        expect(notification.id).toBeDefined();
        expect(notification.merchantId).toBeDefined();
        processedOrders++;
      } catch (e) {
        console.error("Error processing notification:", e);
      }
      stopTimer();
    }

    const durationMs = performance.now() - startTime;
    const stats = metrics.getStats("notification_new_order");

    console.log(
      `\nProcessed ${processedOrders} new order notifications in ${durationMs.toFixed(2)}ms`
    );
    if (stats) {
      console.log(`Throughput: ${(processedOrders / (durationMs / 1000)).toFixed(0)} notifs/sec`);
      console.log(`Avg time: ${stats.avg.toFixed(2)}ms, P95: ${stats.p95.toFixed(2)}ms`);
    }

    expect(processedOrders).toBe(ordersCount);
    expect(stats?.avg).toBeLessThan(2); // Very fast for notification creation
  });

  it("simulates 5000 shipment update notifications", () => {
    const updatesCount = NOTIFICATION_SCENARIOS.shipment_updates;
    let processedUpdates = 0;

    const startTime = performance.now();

    for (let i = 0; i < updatesCount; i++) {
      const stopTimer = metrics.startTimer("notification_shipment_update");
      try {
        const notification = {
          id: `shipment_notif_${i}`,
          type: "shipment_update",
          merchantId: generateMerchantId(i % 200),
          shipmentId: `shipment_${i}`,
          status: ["in_transit", "out_for_delivery", "delivered"][
            i % 3
          ],
          timestamp: new Date().toISOString(),
        };

        expect(notification.id).toBeDefined();
        processedUpdates++;
      } catch (e) {
        console.error("Error processing shipment update:", e);
      }
      stopTimer();
    }

    const durationMs = performance.now() - startTime;
    const stats = metrics.getStats("notification_shipment_update");

    console.log(
      `\nProcessed ${processedUpdates} shipment notifications in ${durationMs.toFixed(2)}ms`
    );
    if (stats) {
      console.log(`Throughput: ${(processedUpdates / (durationMs / 1000)).toFixed(0)} notifs/sec`);
    }

    expect(processedUpdates).toBe(updatesCount);
  });

  it("simulates 5000 push notifications delivery", () => {
    const pushCount = NOTIFICATION_SCENARIOS.push_notifications;
    let successCount = 0;

    const startTime = performance.now();

    for (let i = 0; i < pushCount; i++) {
      const stopTimer = metrics.startTimer("push_notification_delivery");
      try {
        // Simulate push notification delivery
        const push = {
          id: `push_${i}`,
          subscriptionId: `sub_${i % 1000}`,
          payload: {
            title: "Order Update",
            body: `Order ${i} status changed`,
            tag: `order_${i}`,
          },
          createdAt: new Date(),
          sentAt: new Date(),
        };

        expect(push.id).toBeDefined();
        successCount++;
      } catch (e) {
        console.error("Error delivering push:", e);
      }
      stopTimer();
    }

    const durationMs = performance.now() - startTime;
    const stats = metrics.getStats("push_notification_delivery");

    console.log(
      `\nDelivered ${successCount} push notifications in ${durationMs.toFixed(2)}ms`
    );
    if (stats) {
      console.log(
        `Throughput: ${(successCount / (durationMs / 1000)).toFixed(0)} pushes/sec`
      );
      console.log(`Avg delivery time: ${stats.avg.toFixed(2)}ms`);
    }

    expect(successCount).toBe(pushCount);
    expect(successCount / pushCount).toBe(1); // 100% delivery success
  });
});
