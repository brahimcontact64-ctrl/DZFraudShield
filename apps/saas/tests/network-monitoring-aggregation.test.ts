import { describe, expect, it } from "vitest";
import { aggregateMonitoringData, classifyMonitoringHealth } from "@/lib/admin/network-monitoring";

describe("network monitoring aggregation", () => {
  it("aggregates sync operational metrics and provider breakdown", () => {
    const snapshot = aggregateMonitoringData({
      now: new Date("2026-06-09T12:00:00.000Z"),
      syncLogs: [
        {
          status: "success",
          provider: "zr_express",
          imported_count: 20,
          updated_count: 10,
          failed_count: 2,
          failed_orders: 2,
          error_message: null,
          created_at: "2026-06-09T11:40:00.000Z"
        }
      ],
      accounts: [
        { id: "1", provider: "yalidine", active: true, connection_status: "connected", last_error_message: null, credentials: "enc" },
        { id: "2", provider: "zr_express", active: true, connection_status: "connected", last_error_message: null, credentials: "enc" },
        { id: "3", provider: "future_ship", active: true, connection_status: "failed", last_error_message: "401", credentials: "enc" }
      ],
      totalIdentities: 150,
      totalDeliveryOrders: 800,
      totalMerchants: 12,
      returningCustomersCount: 44,
      merchantCountGte2: 8,
      providerCountGte2: 3
    });

    expect(snapshot.lastSyncStatus).toBe("success");
    expect(snapshot.ordersImported).toBe(20);
    expect(snapshot.ordersUpdated).toBe(10);
    expect(snapshot.failedRecords).toBe(2);
    expect(snapshot.activeConnectedDeliveryAccounts).toBe(2);
    expect(snapshot.providerBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "yalidine", activeAccounts: 1, connectedAccounts: 1, errorAccounts: 0 }),
        expect.objectContaining({ provider: "zr_express", activeAccounts: 1, connectedAccounts: 1, errorAccounts: 0 }),
        expect.objectContaining({ provider: "future_ship", activeAccounts: 1, connectedAccounts: 0, errorAccounts: 1 })
      ])
    );
    expect(snapshot.growth).toMatchObject({
      totalIdentities: 150,
      totalDeliveryOrders: 800,
      totalMerchants: 12,
      totalProviders: 3,
      returningCustomersCount: 44,
      merchantCountGte2: 8,
      providerCountGte2: 3
    });
  });
});

describe("network monitoring health classification", () => {
  it("marks no recent sync as critical", () => {
    const health = classifyMonitoringHealth({
      now: new Date("2026-06-09T12:00:00.000Z"),
      lastScheduledSyncTime: "2026-06-08T22:00:00.000Z",
      providerAccountErrorCount: 0,
      missingCredentialsCount: 0,
      hasAuthOrRateLimitErrors: false,
      failedRate: 0.01
    });

    expect(health.find((item) => item.key === "no_sync_12h")?.status).toBe("critical");
  });

  it("flags provider/account/auth issues and high failed rate", () => {
    const health = classifyMonitoringHealth({
      now: new Date("2026-06-09T12:00:00.000Z"),
      lastScheduledSyncTime: "2026-06-09T11:50:00.000Z",
      providerAccountErrorCount: 2,
      missingCredentialsCount: 1,
      hasAuthOrRateLimitErrors: true,
      failedRate: 0.3
    });

    expect(health.find((item) => item.key === "provider_account_error")?.status).toBe("warning");
    expect(health.find((item) => item.key === "missing_credentials")?.status).toBe("critical");
    expect(health.find((item) => item.key === "api_rate_limit_or_auth_error")?.status).toBe("warning");
    expect(health.find((item) => item.key === "high_failed_rate")?.status).toBe("warning");
  });
});
