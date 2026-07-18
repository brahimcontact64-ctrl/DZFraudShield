import { describe, expect, it } from "vitest";
import { buildMerchantFacingDTO, containsBlockedToken } from "@/lib/risk/merchant-facing-dto";

describe("merchant-facing privacy regression", () => {
  it("does not expose operational monitoring internals", () => {
    const dto = buildMerchantFacingDTO({
      riskScore: 42,
      trustLevel: "WATCHLIST",
      totalOrders: 12,
      deliveredOrders: 7,
      refusedOrders: 2,
      returnedOrders: 1,
      cancelledOrders: 1,
      noAnswerOrders: 1,
      fakeOrderCount: 0,
      networkMerchantCount: 3,
      estimatedDamageDzd: 5400,
      deliverySuccessRate: 58,
      riskTrend: "INCREASING",
      recentBadEvents: 2,
      recommendedAction: "manual_review"
    });

    const serialized = JSON.stringify(dto).toLowerCase();
    const forbiddenOperationalFields = [
      "lastscheduledsynctime",
      "nextscheduledsynctime",
      "lastsyncstatus",
      "providerbreakdown",
      "activeconnecteddeliveryaccounts",
      "failedrecords",
      "sync",
      "shipment_id",
      "tracking_number",
      "label_url",
      "labels_url",
      "label_pdf_url",
      "import_id",
      "shipment_status",
      "shipment_error"
    ];

    for (const key of forbiddenOperationalFields) {
      expect(serialized.includes(key)).toBe(false);
    }

    for (const reason of dto.reasons) {
      expect(containsBlockedToken(reason)).toBe(false);
    }
  });
});
