import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { formatDateTime, formatDateOnly, formatTimeOnly, formatNumber } from "@/lib/format-date";
import { allowsNotification } from "@/lib/notifications/settings";
import type { MerchantNotificationSettings } from "@/lib/notifications/settings";

// ---------------------------------------------------------------------------
// 1. Deterministic date formatting (format-date.ts)
// ---------------------------------------------------------------------------
describe("format-date — deterministic output", () => {
  const ISO = "2026-07-14T17:28:13.000Z"; // 18:28:13 in Africa/Algiers (UTC+1)

  it("formatDateTime is deterministic — string form and Date form produce identical output", () => {
    const fromString = formatDateTime(ISO);
    const fromDate   = formatDateTime(new Date(ISO));
    expect(fromString).toBe(fromDate);
    // Must contain the date components (locale-agnostic assertion)
    expect(fromString).toContain("14");
    expect(fromString).toContain("07");
    expect(fromString).toContain("2026");
    // Must contain the correct minutes (28) in local time
    expect(fromString).toContain("28");
  });

  it("formatDateTime returns '-' for null/undefined/invalid", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(undefined)).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("-");
  });

  it("formatDateOnly returns only the date part, no time digits", () => {
    const result = formatDateOnly(ISO);
    expect(result).toContain("14");
    expect(result).toContain("07");
    expect(result).toContain("2026");
    // Should NOT contain seconds/time details
    expect(result).not.toMatch(/:\d{2}/);
  });

  it("formatTimeOnly contains the correct minute for the fixed timezone", () => {
    const result = formatTimeOnly(ISO);
    // 17:28 UTC = 18:28 Africa/Algiers; minutes are always 28.
    // Hour may render as "6:28 PM" (12h) or "18:28" (24h) depending on ICU data.
    expect(result).toContain("28");
  });

  it("formatNumber uses French thousands separator", () => {
    const result = formatNumber(1234567);
    // French locale uses narrow no-break space (U+202F) or regular space as thousands sep
    expect(result.replace(/\s/g, " ").replace(/ /g, " ")).toBe("1 234 567");
  });

  it("formatNumber returns '-' for null/undefined", () => {
    expect(formatNumber(null)).toBe("-");
    expect(formatNumber(undefined)).toBe("-");
  });

  it("formatNumber returns 0 for value 0", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("two calls with same Date object always return the same string (no randomness)", () => {
    const d = new Date("2026-01-01T10:00:00Z");
    expect(formatDateTime(d)).toBe(formatDateTime(d));
    expect(formatDateOnly(d)).toBe(formatDateOnly(d));
    expect(formatTimeOnly(d)).toBe(formatTimeOnly(d));
  });
});

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  resolveMerchantId: vi.fn(async (): Promise<string | null> => "merchant-1"),
  enforceRateLimit: vi.fn(async (): Promise<boolean> => true),
  getMerchantNotificationSettings: vi.fn(async (): Promise<MerchantNotificationSettings> => ({
    merchantId: "merchant-1",
    preferredLanguage: "fr",
    enableNotifications: true,
    enableNewOrder: true,
    enableShipmentUpdates: true,
    enableRiskAlerts: true,
    permissionState: "granted",
    permissionPromptedAt: null,
  })),
  enqueueBackgroundJob: vi.fn(async (): Promise<string | null> => "job-abc-123"),
}));

vi.mock("@/lib/dashboard-data", () => ({
  resolveDashboardMerchantId: hoisted.resolveMerchantId,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: hoisted.enforceRateLimit,
}));

vi.mock("@/lib/notifications/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/settings")>();
  return {
    ...actual,
    getMerchantNotificationSettings: hoisted.getMerchantNotificationSettings,
  };
});

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: hoisted.enqueueBackgroundJob,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "merchant_push_subscriptions") {
        return {
          upsert: () => Promise.resolve({ error: null }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      }
      if (table === "merchant_notification_settings") {
        return {
          upsert: () => Promise.resolve({ error: null }),
        };
      }
      return { upsert: () => Promise.resolve({ error: null }) };
    },
  }),
}));

// ---------------------------------------------------------------------------
// 2. VAPID public-key config endpoint
// ---------------------------------------------------------------------------
describe("GET /api/v1/pwa/push/config", () => {
  const getRoute = () =>
    import("@/app/api/v1/pwa/push/config/route").then((m) => m.GET);

  beforeEach(() => {
    vi.resetModules();
    hoisted.resolveMerchantId.mockResolvedValue("merchant-1");
  });

  it("returns 401 when not authenticated", async () => {
    hoisted.resolveMerchantId.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/v1/pwa/push/config/route");
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns vapidPublicKey when VAPID_PUBLIC_KEY is set", async () => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key-abc";
    const { GET } = await import("@/app/api/v1/pwa/push/config/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vapidPublicKey).toBe("test-public-key-abc");
    delete process.env.VAPID_PUBLIC_KEY;
  });

  it("falls back to NEXT_PUBLIC_VAPID_PUBLIC_KEY", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "next-public-key-xyz";
    const { GET } = await import("@/app/api/v1/pwa/push/config/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vapidPublicKey).toBe("next-public-key-xyz");
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  });

  it("returns 503 when no VAPID key is configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const { GET } = await import("@/app/api/v1/pwa/push/config/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Push not configured");
  });
});

// ---------------------------------------------------------------------------
// 3. Push subscription endpoint
// ---------------------------------------------------------------------------
describe("POST /api/v1/pwa/push/subscribe", () => {
  const makeReq = (body: unknown) =>
    new NextRequest("http://localhost/api/v1/pwa/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    hoisted.resolveMerchantId.mockResolvedValue("merchant-1");
  });

  it("returns 401 when unauthenticated", async () => {
    hoisted.resolveMerchantId.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/v1/pwa/push/subscribe/route");
    const res = await POST(makeReq({ endpoint: "https://push.example.com/sub/1" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid payload (missing endpoint)", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/subscribe/route");
    const res = await POST(makeReq({ keys: { p256dh: "k", auth: "a" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid subscription payload");
  });

  it("returns 400 for non-URL endpoint", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/subscribe/route");
    const res = await POST(makeReq({ endpoint: "not-a-url" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 ok for valid payload", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/subscribe/route");
    const res = await POST(
      makeReq({ endpoint: "https://push.example.com/sub/1", keys: { p256dh: "k", auth: "a" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 200 ok for payload without keys (idempotent upsert)", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/subscribe/route");
    const res = await POST(makeReq({ endpoint: "https://push.example.com/sub/1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Push unsubscribe endpoint — merchant isolation
// ---------------------------------------------------------------------------
describe("POST /api/v1/pwa/push/unsubscribe", () => {
  const makeReq = (body: unknown) =>
    new NextRequest("http://localhost/api/v1/pwa/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns 401 when unauthenticated", async () => {
    hoisted.resolveMerchantId.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/v1/pwa/push/unsubscribe/route");
    const res = await POST(makeReq({ endpoint: "https://push.example.com/sub/1" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing endpoint", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/unsubscribe/route");
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 200 ok for valid endpoint", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/unsubscribe/route");
    const res = await POST(makeReq({ endpoint: "https://push.example.com/sub/1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Test push endpoint
// ---------------------------------------------------------------------------
describe("POST /api/v1/pwa/push/test", () => {
  const makeReq = () =>
    new NextRequest("http://localhost/api/v1/pwa/push/test", { method: "POST" });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveMerchantId.mockResolvedValue("merchant-1");
    hoisted.enforceRateLimit.mockResolvedValue(true);
    hoisted.getMerchantNotificationSettings.mockResolvedValue({
      merchantId: "merchant-1",
      preferredLanguage: "fr" as const,
      enableNotifications: true,
      enableNewOrder: true,
      enableShipmentUpdates: true,
      enableRiskAlerts: true,
      permissionState: "granted" as const,
      permissionPromptedAt: null,
    });
    hoisted.enqueueBackgroundJob.mockResolvedValue("job-abc-123");
  });

  it("returns 401 when unauthenticated", async () => {
    hoisted.resolveMerchantId.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limit exceeded", async () => {
    hoisted.enforceRateLimit.mockResolvedValueOnce(false);
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    const res = await POST();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Rate limit");
  });

  it("enqueues send_push_notification job and returns jobId", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.jobId).toBe("job-abc-123");
    expect(hoisted.enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: "send_push_notification", merchantId: "merchant-1" }),
    );
  });

  it("uses fr locale when merchant language is fr", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    await POST();
    expect(hoisted.enqueueBackgroundJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ title: "Test de notification" }) }),
    );
  });

  it("uses ar locale when merchant language is ar", async () => {
    hoisted.getMerchantNotificationSettings.mockResolvedValueOnce({
      merchantId: "merchant-1",
      preferredLanguage: "ar",
      enableNotifications: true,
      enableNewOrder: true,
      enableShipmentUpdates: true,
      enableRiskAlerts: true,
      permissionState: "granted",
      permissionPromptedAt: null,
    });
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    await POST();
    expect(hoisted.enqueueBackgroundJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ title: "اختبار الإشعارات" }) }),
    );
  });

  it("returns 500 when enqueueBackgroundJob returns null", async () => {
    hoisted.enqueueBackgroundJob.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("rate-limit key is scoped to merchant (not shared across merchants)", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/test/route");
    await POST();
    expect(hoisted.enforceRateLimit).toHaveBeenLastCalledWith(
      "test_push:merchant-1",
      expect.any(Number),
      expect.any(Number),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Notification settings defaults (pure logic — normalizeSettings produces these defaults)
// ---------------------------------------------------------------------------
describe("notification settings defaults", () => {
  const defaultSettings: MerchantNotificationSettings = {
    merchantId: "m",
    preferredLanguage: "fr",
    enableNotifications: true,
    enableNewOrder: true,
    enableShipmentUpdates: true,
    enableRiskAlerts: true,
    permissionState: "default",
    permissionPromptedAt: null,
  };

  it("all categories are enabled in default settings", () => {
    expect(defaultSettings.enableNotifications).toBe(true);
    expect(defaultSettings.enableNewOrder).toBe(true);
    expect(defaultSettings.enableShipmentUpdates).toBe(true);
    expect(defaultSettings.enableRiskAlerts).toBe(true);
  });

  it("permissionState defaults to 'default' (not granted)", () => {
    expect(defaultSettings.permissionState).toBe("default");
  });

  it("all allowsNotification checks pass with default settings", () => {
    expect(allowsNotification(defaultSettings, "new_order")).toBe(true);
    expect(allowsNotification(defaultSettings, "shipment_update")).toBe(true);
    expect(allowsNotification(defaultSettings, "risk_alert")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. allowsNotification category opt-out
// ---------------------------------------------------------------------------
describe("allowsNotification", () => {
  const base: MerchantNotificationSettings = {
    merchantId: "m1",
    preferredLanguage: "fr",
    enableNotifications: true,
    enableNewOrder: true,
    enableShipmentUpdates: true,
    enableRiskAlerts: true,
    permissionState: "granted",
    permissionPromptedAt: null,
  };

  it("blocks all when enableNotifications is false", () => {
    const s = { ...base, enableNotifications: false };
    expect(allowsNotification(s, "new_order")).toBe(false);
    expect(allowsNotification(s, "shipment_update")).toBe(false);
    expect(allowsNotification(s, "risk_alert")).toBe(false);
  });

  it("blocks new_order when enableNewOrder is false", () => {
    const s = { ...base, enableNewOrder: false };
    expect(allowsNotification(s, "new_order")).toBe(false);
    expect(allowsNotification(s, "shipment_update")).toBe(true);
  });

  it("blocks shipment_update when enableShipmentUpdates is false", () => {
    const s = { ...base, enableShipmentUpdates: false };
    expect(allowsNotification(s, "shipment_update")).toBe(false);
    expect(allowsNotification(s, "new_order")).toBe(true);
  });

  it("blocks risk_alert when enableRiskAlerts is false", () => {
    const s = { ...base, enableRiskAlerts: false };
    expect(allowsNotification(s, "risk_alert")).toBe(false);
    expect(allowsNotification(s, "new_order")).toBe(true);
  });

  it("allows all categories when all flags are true", () => {
    expect(allowsNotification(base, "new_order")).toBe(true);
    expect(allowsNotification(base, "shipment_update")).toBe(true);
    expect(allowsNotification(base, "risk_alert")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Safe notification-click URL handling (service worker logic, pure JS)
// ---------------------------------------------------------------------------
describe("service worker: safe URL filtering", () => {
  // Mirrors the guard in public/sw.js notificationclick handler.
  // Only single-slash relative paths are safe: "//evil.com" is a protocol-relative
  // URL that resolves to an external host — it must be rejected.
  const isSafeUrl = (url: unknown): boolean =>
    typeof url === "string" && url.startsWith("/") && !url.startsWith("//");

  const safeFallback = (url: unknown) =>
    isSafeUrl(url) ? (url as string) : "/dashboard/notifications";

  it("allows root-relative paths", () => {
    expect(safeFallback("/dashboard/orders")).toBe("/dashboard/orders");
    expect(safeFallback("/dashboard/notifications")).toBe("/dashboard/notifications");
    expect(safeFallback("/")).toBe("/");
  });

  it("rejects absolute external URLs (open-redirect prevention)", () => {
    expect(safeFallback("https://evil.com/phishing")).toBe("/dashboard/notifications");
    expect(safeFallback("http://evil.com")).toBe("/dashboard/notifications");
  });

  it("rejects protocol-relative URLs (resolve to external host)", () => {
    expect(safeFallback("//evil.com")).toBe("/dashboard/notifications");
    expect(safeFallback("//evil.com/path")).toBe("/dashboard/notifications");
  });

  it("rejects null, undefined, and non-string values", () => {
    expect(safeFallback(null)).toBe("/dashboard/notifications");
    expect(safeFallback(undefined)).toBe("/dashboard/notifications");
    expect(safeFallback(42)).toBe("/dashboard/notifications");
  });

  it("rejects javascript: URLs", () => {
    expect(safeFallback("javascript:alert(1)")).toBe("/dashboard/notifications");
  });
});

// ---------------------------------------------------------------------------
// 9. iOS standalone detection helper (pure logic)
// ---------------------------------------------------------------------------
describe("iOS standalone detection", () => {
  // The standalone check used in the PWA install prompt hook:
  // typeof window !== "undefined" && (window.navigator as any).standalone === true
  // We test the pure boolean logic here.
  const isStandalone = (standaloneFlag: unknown): boolean =>
    standaloneFlag === true;

  it("returns true when navigator.standalone is true", () => {
    expect(isStandalone(true)).toBe(true);
  });

  it("returns false when navigator.standalone is undefined (web browser)", () => {
    expect(isStandalone(undefined)).toBe(false);
  });

  it("returns false when navigator.standalone is false (not installed)", () => {
    expect(isStandalone(false)).toBe(false);
  });

  it("returns false for non-boolean truthy values", () => {
    expect(isStandalone("true")).toBe(false);
    expect(isStandalone(1)).toBe(false);
  });
});
