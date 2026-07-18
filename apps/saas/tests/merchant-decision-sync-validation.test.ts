import { beforeEach, describe, expect, it, vi } from "vitest";
import { markMerchantDecisionWooSync } from "@/lib/merchant-decisions";

const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ from: fromMock })
}));

describe("markMerchantDecisionWooSync", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("updates previous/new Woo status and writes timeline event", async () => {
    const insertedEvents: any[] = [];

    fromMock.mockImplementation((table: string) => {
      if (table === "merchant_decisions") {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: async () => ({
                      data: {
                        id: "d1",
                        merchant_id: "m1",
                        order_check_id: "c1",
                        previous_wc_status: "pending",
                        new_wc_status: "processing",
                        wc_sync_status: "SYNCED",
                        wc_synced_at: new Date().toISOString(),
                        wc_sync_error: null
                      },
                      error: null
                    })
                  })
                })
              })
            })
          })
        };
      }

      if (table === "risk_events") {
        return {
          insert: async (payload: any) => {
            insertedEvents.push(payload);
            return { error: null };
          }
        };
      }

      return {};
    });

    const result = await markMerchantDecisionWooSync({
      merchantId: "m1",
      decisionId: "d1",
      orderCheckId: "c1",
      previousWooStatus: "pending",
      newWooStatus: "processing"
    });

    expect(result).not.toBeNull();
    expect(result?.wc_sync_status).toBe("SYNCED");
    expect(result?.previous_wc_status).toBe("pending");
    expect(result?.new_wc_status).toBe("processing");
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0].event_type).toBe("merchant_decision_wc_synced");
  });
});
