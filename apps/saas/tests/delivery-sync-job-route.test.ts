import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/v1/jobs/delivery-sync/route";

const hoisted = vi.hoisted(() => ({
  enqueueMock: vi.fn(async () => "job-1"),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: hoisted.enqueueMock,
}));

describe("/api/v1/jobs/delivery-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DELIVERY_SYNC_CRON_SECRET;
    delete process.env.CRON_SECRET;
  });

  it("returns 500 when no cron secret is configured", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/jobs/delivery-sync", {
      method: "POST",
      headers: { authorization: "Bearer test" },
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it("accepts CRON_SECRET bearer auth and supports GET", async () => {
    process.env.CRON_SECRET = "cron_secret_value";

    const req = new NextRequest("http://localhost:3000/api/v1/jobs/delivery-sync", {
      method: "GET",
      headers: { authorization: "Bearer cron_secret_value" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(hoisted.enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid bearer token", async () => {
    process.env.DELIVERY_SYNC_CRON_SECRET = "expected_token";

    const req = new NextRequest("http://localhost:3000/api/v1/jobs/delivery-sync", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(hoisted.enqueueMock).not.toHaveBeenCalled();
  });
});
