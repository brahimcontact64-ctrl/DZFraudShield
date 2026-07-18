import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as subscribePost } from "@/app/api/v1/pwa/push/subscribe/route";
import { POST as unsubscribePost } from "@/app/api/v1/pwa/push/unsubscribe/route";

const hoisted = vi.hoisted(() => ({
  resolveDashboardMerchantIdMock: vi.fn(async () => "merchant-1"),
  upsertMock: vi.fn(async () => ({ error: null })),
  settingsUpsertMock: vi.fn(async () => ({ error: null })),
  updateEqEndpointMock: vi.fn(async () => ({ error: null })),
  updateEqMerchantMock: vi.fn(),
  updateMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/dashboard-data", () => ({
  resolveDashboardMerchantId: hoisted.resolveDashboardMerchantIdMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: hoisted.fromMock,
  }),
}));

describe("push subscription routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    hoisted.updateEqMerchantMock.mockReturnValue({
      eq: hoisted.updateEqEndpointMock,
    });

    hoisted.updateMock.mockReturnValue({
      eq: hoisted.updateEqMerchantMock,
    });

    hoisted.fromMock.mockImplementation((table: string) => {
      if (table === "merchant_push_subscriptions") {
        return {
          upsert: hoisted.upsertMock,
          update: hoisted.updateMock,
        };
      }
      if (table === "merchant_notification_settings") {
        return {
          upsert: hoisted.settingsUpsertMock,
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("subscribes an authenticated merchant push endpoint", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/pwa/push/subscribe", {
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://push.example/subscription",
        keys: {
          p256dh: "p256dh",
          auth: "auth",
        },
      }),
    });

    const res = await subscribePost(req);
    expect(res.status).toBe(200);
    expect(hoisted.upsertMock).toHaveBeenCalledTimes(1);
    expect(hoisted.settingsUpsertMock).toHaveBeenCalledTimes(1);
  });

  it("disables an existing push endpoint on unsubscribe", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/pwa/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://push.example/subscription",
      }),
    });

    const res = await unsubscribePost(req);
    expect(res.status).toBe(200);
    expect(hoisted.updateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.updateEqMerchantMock).toHaveBeenCalledWith("merchant_id", "merchant-1");
    expect(hoisted.updateEqEndpointMock).toHaveBeenCalledWith("endpoint", "https://push.example/subscription");
  });
});
