import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  merchantIdMock: vi.fn(async () => "merchant-1"),
  settingsMock: vi.fn(async () => ({ preferredLanguage: "fr" })),
  enqueueMock: vi.fn(async () => "job-1"),
}));

vi.mock("@/lib/dashboard-data", () => ({
  resolveDashboardMerchantId: hoisted.merchantIdMock,
}));

vi.mock("@/lib/notifications/settings", () => ({
  getMerchantNotificationSettings: hoisted.settingsMock,
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: hoisted.enqueueMock,
}));

describe("pwa push verify route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns quickly and queues notification job", async () => {
    const { POST } = await import("@/app/api/v1/pwa/push/verify/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(hoisted.enqueueMock).toHaveBeenCalledTimes(1);
    const json = await res.json();
    expect(json.queued).toBe(true);
  });
});
