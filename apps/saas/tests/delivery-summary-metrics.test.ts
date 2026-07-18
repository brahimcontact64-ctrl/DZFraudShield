import { describe, expect, it } from "vitest";
import { computeDeliverySummaryMetrics } from "@/lib/delivery-intelligence/dashboard";

describe("computeDeliverySummaryMetrics", () => {
  it("computes delivery and return rates for 10 delivered and 2 returned", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, idx) => ({ status: "DELIVERED", identity_id: `id-del-${idx}`, customer_phone: "0662255853", customer_name: `D-${idx}` })),
      ...Array.from({ length: 2 }, (_, idx) => ({ status: "RETURNED", identity_id: `id-ret-${idx}`, customer_phone: "0555123456", customer_name: `R-${idx}` }))
    ];

    const metrics = computeDeliverySummaryMetrics(rows);
    expect(metrics.totalOrders).toBe(12);
    expect(metrics.deliveredOrders).toBe(10);
    expect(metrics.returnedOrders).toBe(2);
    expect(metrics.deliveryRate).toBe(83.33);
    expect(metrics.returnRate).toBe(16.67);
  });

  it("computes delivery and return rates for 5 delivered and 5 returned", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, idx) => ({ status: "DELIVERED", identity_id: `id-del-${idx}`, customer_phone: "0662255853", customer_name: `D-${idx}` })),
      ...Array.from({ length: 5 }, (_, idx) => ({ status: "RETURNED", identity_id: `id-ret-${idx}`, customer_phone: "0555123456", customer_name: `R-${idx}` }))
    ];

    const metrics = computeDeliverySummaryMetrics(rows);
    expect(metrics.totalOrders).toBe(10);
    expect(metrics.deliveredOrders).toBe(5);
    expect(metrics.returnedOrders).toBe(5);
    expect(metrics.deliveryRate).toBe(50);
    expect(metrics.returnRate).toBe(50);
    expect(metrics.topRiskyCustomers.length).toBeGreaterThan(0);
    expect(metrics.topRiskyPhoneNumbers.length).toBeGreaterThan(0);
  });
});