import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  resolveDashboardMerchantIdMock: vi.fn(async () => null as string | null),
  enforceRateLimitMock: vi.fn(() => true),
  updateEqMock: vi.fn(async () => ({ error: null })),
  selectSingleMock: vi.fn(async () => ({ data: { id: "merchant-owner", category: "electronics", category_updated_at: "2026-06-14T00:00:00.000Z" }, error: null })),
}));

vi.mock("@/lib/dashboard-data", () => ({
  resolveDashboardMerchantId: hoisted.resolveDashboardMerchantIdMock,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: hoisted.enforceRateLimitMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== "merchants") {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        update: () => ({
          eq: hoisted.updateEqMock,
        }),
        select: () => ({
          eq: () => ({
            single: hoisted.selectSingleMock,
          }),
        }),
      };
    },
  }),
}));

function adminAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

describe("/api/v1/category/sync auth and ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_NETWORK_USER;
    delete process.env.ADMIN_NETWORK_PASSWORD;
    hoisted.resolveDashboardMerchantIdMock.mockResolvedValue(null);
  });

  it("returns 401 for anonymous GET", async () => {
    const { GET } = await import("@/app/api/v1/category/sync/route");
    const req = new NextRequest("http://localhost:3000/api/v1/category/sync?merchantId=merchant-owner", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 for anonymous POST", async () => {
    const { POST } = await import("@/app/api/v1/category/sync/route");
    const req = new NextRequest("http://localhost:3000/api/v1/category/sync", {
      method: "POST",
      body: JSON.stringify({ merchantId: "merchant-owner", category: "Electronics" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 when merchant tries another merchantId", async () => {
    hoisted.resolveDashboardMerchantIdMock.mockResolvedValue("merchant-owner");
    const { POST } = await import("@/app/api/v1/category/sync/route");
    const req = new NextRequest("http://localhost:3000/api/v1/category/sync", {
      method: "POST",
      body: JSON.stringify({ merchantId: "merchant-other", category: "Electronics" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(hoisted.updateEqMock).not.toHaveBeenCalled();
  });

  it("returns 200 for owner merchant", async () => {
    hoisted.resolveDashboardMerchantIdMock.mockResolvedValue("merchant-owner");
    const { POST } = await import("@/app/api/v1/category/sync/route");
    const req = new NextRequest("http://localhost:3000/api/v1/category/sync", {
      method: "POST",
      body: JSON.stringify({ merchantId: "merchant-owner", category: "Electronics" }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.category).toBe("electronics");
    expect(hoisted.updateEqMock).toHaveBeenCalledWith("id", "merchant-owner");
  });

  it("returns 200 for admin request", async () => {
    process.env.ADMIN_NETWORK_USER = "admin";
    process.env.ADMIN_NETWORK_PASSWORD = "secret";

    const { POST } = await import("@/app/api/v1/category/sync/route");
    const req = new NextRequest("http://localhost:3000/api/v1/category/sync", {
      method: "POST",
      headers: {
        authorization: adminAuthHeader("admin", "secret"),
      },
      body: JSON.stringify({ merchantId: "merchant-any", category: "Food" }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.category).toBe("food");
  });
});
