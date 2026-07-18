import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMerchantDecisionDashboardStats } from "@/lib/dashboard-data";

const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ from: fromMock })
}));

vi.mock("@/lib/auth/session-server", () => ({
  getDashboardSessionUser: vi.fn(async () => ({ id: "user-1" }))
}));

describe("getMerchantDecisionDashboardStats", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("computes counts, accuracy and overrides", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "merchant_decisions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    {
                      id: "d1",
                      created_at: "2026-06-05T10:00:00Z",
                      order_check_id: "c1",
                      phone: "0555000001",
                      decision: "ACCEPTED",
                      risk_level: "HIGH",
                      recommended_action: "manual_review"
                    },
                    {
                      id: "d2",
                      created_at: "2026-06-05T11:00:00Z",
                      order_check_id: "c2",
                      phone: "0555000002",
                      decision: "BLOCKED",
                      risk_level: "CRITICAL",
                      recommended_action: "block"
                    },
                    {
                      id: "d3",
                      created_at: "2026-06-05T12:00:00Z",
                      order_check_id: "c3",
                      phone: "0555000003",
                      decision: "VERIFY_FIRST",
                      risk_level: "MEDIUM",
                      recommended_action: "verify"
                    }
                  ]
                })
              })
            })
          })
        };
      }

      if (table === "order_checks") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: [
                  { id: "c1", customer_name: "Customer One" },
                  { id: "c2", customer_name: "Customer Two" },
                  { id: "c3", customer_name: "Customer Three" }
                ]
              })
            })
          })
        };
      }

      return {};
    });

    const stats = await getMerchantDecisionDashboardStats("m1");

    expect(stats.acceptedOrders).toBe(1);
    expect(stats.verificationRequired).toBe(1);
    expect(stats.blockedOrders).toBe(1);
    expect(stats.systemBlockedMerchantBlocked).toBe(1);
    expect(stats.systemAcceptedMerchantAccepted).toBe(0);
    expect(stats.overrideAcceptedDespiteWarning).toBe(1);
    expect(stats.overrideRate).toBe(33);
    expect(stats.recent).toHaveLength(3);
  });
});
