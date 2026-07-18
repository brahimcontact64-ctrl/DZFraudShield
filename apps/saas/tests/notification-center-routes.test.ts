import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH as patchAll } from "@/app/api/v1/merchant/notifications/route";
import { PATCH as patchOne, DELETE as deleteOne } from "@/app/api/v1/merchant/notifications/[id]/route";

const hoisted = vi.hoisted(() => ({
  merchantId: "merchant-1" as string | null,
  updateArgs: [] as Array<Record<string, unknown>>,
  eqCalls: [] as Array<{ column: string; value: unknown }>,
  isCalls: [] as Array<{ column: string; value: unknown }>,
}));

vi.mock("@/lib/dashboard-data", () => ({
  resolveDashboardMerchantId: vi.fn(async () => hoisted.merchantId),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== "merchant_notifications") {
        throw new Error(`Unexpected table ${table}`);
      }

      const query = {
        error: null,
        eq(column: string, value: unknown) {
          hoisted.eqCalls.push({ column, value });
          return this;
        },
        is(column: string, value: unknown) {
          hoisted.isCalls.push({ column, value });
          return this;
        },
      };

      return {
        update(values: Record<string, unknown>) {
          hoisted.updateArgs.push(values);
          return query;
        },
      };
    },
  }),
}));

describe("merchant notification center routes", () => {
  beforeEach(() => {
    hoisted.merchantId = "merchant-1";
    hoisted.updateArgs = [];
    hoisted.eqCalls = [];
    hoisted.isCalls = [];
  });

  it("marks all notifications as read", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/merchant/notifications?action=mark-all-read", {
      method: "PATCH",
    });

    const res = await patchAll(req);
    expect(res.status).toBe(200);
    expect(hoisted.updateArgs[0]).toHaveProperty("resolved_at");
    expect(hoisted.eqCalls).toContainEqual({ column: "merchant_id", value: "merchant-1" });
  });

  it("marks a single notification unread", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/merchant/notifications/n-1", {
      method: "PATCH",
      body: JSON.stringify({ read: false }),
    });

    const res = await patchOne(req, { params: { id: "n-1" } });
    expect(res.status).toBe(200);
    expect(hoisted.updateArgs[0]).toMatchObject({ resolved_at: null });
    expect(hoisted.eqCalls).toContainEqual({ column: "id", value: "n-1" });
  });

  it("soft deletes one notification", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/merchant/notifications/n-2", {
      method: "DELETE",
    });

    const res = await deleteOne(req, { params: { id: "n-2" } });
    expect(res.status).toBe(200);
    expect(hoisted.updateArgs[0]).toHaveProperty("deleted_at");
    expect(hoisted.eqCalls).toContainEqual({ column: "id", value: "n-2" });
    expect(hoisted.isCalls).toContainEqual({ column: "deleted_at", value: null });
  });
});
