import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getActions } from "@/app/api/v1/plugin/merchant-decision-actions/route";
import { POST as postSync } from "@/app/api/v1/plugin/merchant-decision-sync/route";

vi.mock("@/lib/security/request-auth", () => ({
  requireApiKeyAuth: vi.fn(async () => ({ ok: true, keyRecord: { merchant_id: "m1" } }))
}));

const listPendingWooDecisionActionsMock = vi.fn();
const markMerchantDecisionWooSyncMock = vi.fn();

vi.mock("@/lib/merchant-decisions", () => ({
  listPendingWooDecisionActions: (...args: any[]) => listPendingWooDecisionActionsMock(...args),
  markMerchantDecisionWooSync: (...args: any[]) => markMerchantDecisionWooSyncMock(...args)
}));

describe("plugin merchant decision endpoints", () => {
  it("returns pending actions", async () => {
    listPendingWooDecisionActionsMock.mockResolvedValueOnce([
      {
        decisionId: "dec-1",
        orderCheckId: "check-1",
        orderId: "1001",
        externalOrderId: "1001",
        decision: "VERIFY_FIRST",
        decisionReason: "merchant_call_first",
        notes: null,
        recommendedAction: "verify",
        riskLevel: "MEDIUM",
        riskScore: 44,
        createdAt: new Date().toISOString()
      }
    ]);

    const req = new NextRequest("http://localhost:3000/api/v1/plugin/merchant-decision-actions?limit=10");
    const res = await getActions(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.actions[0].decision).toBe("VERIFY_FIRST");
  });

  it("persists sync status callback", async () => {
    markMerchantDecisionWooSyncMock.mockResolvedValueOnce({
      id: "dec-1",
      wc_sync_status: "SYNCED",
      previous_wc_status: "pending",
      new_wc_status: "on-hold"
    });

    const req = new NextRequest("http://localhost:3000/api/v1/plugin/merchant-decision-sync", {
      method: "POST",
      body: JSON.stringify({
        decisionId: "2fac5dc1-516b-4469-a3d6-4b327f67194a",
        orderCheckId: "c5f5c8f5-17f9-4fc8-a08f-c1cc7c83f25c",
        previousWooStatus: "pending",
        newWooStatus: "on-hold"
      })
    });

    const res = await postSync(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.decision.wc_sync_status).toBe("SYNCED");
  });
});
