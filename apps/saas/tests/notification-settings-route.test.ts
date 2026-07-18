import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/v1/merchant/notification-settings/route";

const hoisted = vi.hoisted(() => ({
  merchantId: "merchant-1" as string | null,
  settings: {
    merchantId: "merchant-1",
    preferredLanguage: "fr",
    enableNotifications: true,
    enableNewOrder: true,
    enableShipmentUpdates: true,
    enableRiskAlerts: true,
    permissionState: "granted" as const,
    permissionPromptedAt: null as string | null,
  },
  upsertMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/lib/dashboard-data", () => ({
  resolveDashboardMerchantId: vi.fn(async () => hoisted.merchantId),
}));

vi.mock("@/lib/notifications/settings", () => ({
  getMerchantNotificationSettings: vi.fn(async () => hoisted.settings),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== "merchant_notification_settings") {
        throw new Error(`Unexpected table ${table}`);
      }
      return {
        upsert: hoisted.upsertMock,
      };
    },
  }),
}));

describe("merchant notification settings route", () => {
  beforeEach(() => {
    hoisted.merchantId = "merchant-1";
    hoisted.settings = {
      merchantId: "merchant-1",
      preferredLanguage: "fr",
      enableNotifications: true,
      enableNewOrder: true,
      enableShipmentUpdates: true,
      enableRiskAlerts: true,
      permissionState: "granted",
      permissionPromptedAt: null,
    };
    hoisted.upsertMock.mockClear();
  });

  it("returns settings for the authenticated merchant", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ settings: { preferredLanguage: "fr" } });
  });

  it("rejects unsupported locale updates", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/merchant/notification-settings", {
      method: "PATCH",
      body: JSON.stringify({ preferredLanguage: "de" }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(400);
    expect(hoisted.upsertMock).not.toHaveBeenCalled();
  });

  it("persists settings patch and returns normalized settings", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/merchant/notification-settings", {
      method: "PATCH",
      body: JSON.stringify({
        preferredLanguage: "en",
        enableNotifications: false,
        enableShipmentUpdates: false,
      }),
    });

    hoisted.settings = {
      ...hoisted.settings,
      preferredLanguage: "en",
      enableNotifications: false,
      enableShipmentUpdates: false,
    };

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    expect(hoisted.upsertMock).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant_id: "merchant-1",
        preferred_language: "en",
        enable_notifications: false,
        enable_shipment_updates: false,
      }),
      { onConflict: "merchant_id" }
    );
    await expect(res.json()).resolves.toMatchObject({ ok: true, settings: { preferredLanguage: "en", enableNotifications: false } });
  });
});
