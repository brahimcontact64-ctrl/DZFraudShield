import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/report-outcome/route";

vi.mock("@/lib/security/api-key", () => ({
  validateApiKey: vi.fn(async () => ({ merchant_id: "m1", store_id: "s1" }))
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => true)
}));

const single = vi.fn(async () => ({ data: { id: "check_1", merchant_id: "m1", phone_hash: "hash" }, error: null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single }) }) }),
      update: () => ({ eq: async () => ({}) }),
      insert: async () => ({})
    }),
    rpc: async () => ({})
  })
}));

describe("POST /api/v1/report-outcome", () => {
  it("accepts valid outcome report", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/report-outcome", {
      method: "POST",
      headers: { authorization: "Bearer test_key" },
      body: JSON.stringify({
        orderCheckId: "99999999-9999-4999-8999-999999999999",
        outcome: "delivered"
      })
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
