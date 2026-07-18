import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantDecision } from "@/lib/merchant-decisions";

const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ from: fromMock })
}));

describe("createMerchantDecision", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("creates timeline event after decision insert", async () => {
    const insertedRiskEvents: any[] = [];

    fromMock.mockImplementation((table: string) => {
      if (table === "merchant_decisions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null })
              })
            })
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: {
                  id: "decision-1",
                  created_at: "2026-06-05T00:00:00Z",
                  merchant_id: "m1",
                  order_check_id: "o1",
                  customer_identity_id: "cid-1",
                  phone: "0555123456",
                  decision: "VERIFY_FIRST",
                  decision_reason: "call_customer",
                  risk_score: 65,
                  risk_level: "HIGH",
                  network_trust_level: "HIGH_RISK",
                  recommended_action: "manual_review",
                  notes: null
                },
                error: null
              })
            })
          })
        };
      }

      if (table === "order_checks") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "o1",
                    merchant_id: "m1",
                    identity_id: "cid-1",
                    customer_phone: "0555123456",
                    phone_raw: "0555123456",
                    risk_score: 65,
                    risk_level: "HIGH",
                    recommended_action: "manual_review"
                  }
                })
              })
            })
          })
        };
      }

      if (table === "risk_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: {
                          payload: {
                            intelligence: { customerNetworkProfile: { networkTrustLevel: "HIGH_RISK" } }
                          }
                        }
                      })
                    })
                  })
                })
              })
            })
          }),
          insert: async (payload: any) => {
            insertedRiskEvents.push(payload);
            return { error: null };
          }
        };
      }

      return {};
    });

    const result = await createMerchantDecision({
      merchantId: "m1",
      orderCheckId: "o1",
      decision: "VERIFY_FIRST",
      decisionReason: "call_customer"
    });

    expect(result.duplicate).toBe(false);
    expect(result.eventType).toBe("merchant_requested_verification");
    expect(insertedRiskEvents).toHaveLength(1);
    expect(insertedRiskEvents[0].event_type).toBe("merchant_requested_verification");
  });
});
