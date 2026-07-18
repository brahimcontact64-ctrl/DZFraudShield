import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  claimMock: vi.fn(async () => []),
  completeMock: vi.fn(async () => undefined),
  failMock: vi.fn(async () => undefined),
  deliverMock: vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 })),
  recomputeMock: vi.fn(async () => undefined),
  syncMock: vi.fn(async () => []),
}));

vi.mock("@/lib/background-jobs", () => ({
  claimBackgroundJobs: hoisted.claimMock,
  completeBackgroundJob: hoisted.completeMock,
  failBackgroundJob: hoisted.failMock,
}));

vi.mock("@/lib/pwa/push-delivery", () => ({
  deliverMerchantPushNotifications: hoisted.deliverMock,
}));

vi.mock("@/lib/delivery-intelligence/reputation", () => ({
  recomputeIdentityReputation: hoisted.recomputeMock,
}));

vi.mock("@/lib/delivery-intelligence/sync", () => ({
  runDeliverySync: hoisted.syncMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ count: 0 }),
      }),
    }),
  }),
}));

describe("jobs/process-background route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BACKGROUND_JOBS_SECRET = "jobs-secret";
  });

  it("rejects unauthorized calls", async () => {
    const { POST } = await import("@/app/api/v1/jobs/process-background/route");
    const req = new NextRequest("http://localhost:3000/api/v1/jobs/process-background", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("processes claimed jobs and completes them", async () => {
    hoisted.claimMock.mockResolvedValueOnce([
      {
        id: "job-1",
        type: "send_push_notification" as const,
        merchant_id: "merchant-1",
        payload: { title: "T", body: "B", url: "/dashboard" },
        status: "processing",
        run_after: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        processed_at: null,
        last_error: null,
        attempts: 1,
      },
      {
        id: "job-2",
        type: "recompute_reputation" as const,
        merchant_id: "merchant-1",
        payload: { identityId: "identity-1" },
        status: "processing",
        run_after: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        processed_at: null,
        last_error: null,
        attempts: 1,
      },
    ] as any);

    const { POST } = await import("@/app/api/v1/jobs/process-background/route");
    const req = new NextRequest("http://localhost:3000/api/v1/jobs/process-background", {
      method: "POST",
      headers: {
        authorization: "Bearer jobs-secret",
      },
      body: JSON.stringify({ limit: 10 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(hoisted.deliverMock).toHaveBeenCalledTimes(1);
    expect(hoisted.recomputeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.completeMock).toHaveBeenCalledTimes(2);
    expect(hoisted.failMock).not.toHaveBeenCalled();
  });
});
