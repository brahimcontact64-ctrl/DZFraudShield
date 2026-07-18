import { beforeEach, describe, expect, it, vi } from "vitest";

type TableName = "delivery_wilayas" | "delivery_communes" | "delivery_stopdesks" | "delivery_prices";

type MockState = {
  rows: Record<TableName, Array<Record<string, unknown>>>;
  accountUpdates: Array<Record<string, unknown>>;
  providerUpdates: Array<Record<string, unknown>>;
};

const state = vi.hoisted<MockState>(() => ({
  rows: {
    delivery_wilayas: [],
    delivery_communes: [],
    delivery_stopdesks: [],
    delivery_prices: [],
  },
  accountUpdates: [],
  providerUpdates: [],
}));

function resetState() {
  state.rows.delivery_wilayas = [];
  state.rows.delivery_communes = [];
  state.rows.delivery_stopdesks = [];
  state.rows.delivery_prices = [];
  state.accountUpdates = [];
  state.providerUpdates = [];
}

function countRows(table: TableName, filters: Record<string, unknown>) {
  return state.rows[table].filter((row) => {
    for (const [key, expected] of Object.entries(filters)) {
      if (String(row[key] ?? "") !== String(expected ?? "")) {
        return false;
      }
    }
    return true;
  }).length;
}

function filterRows(table: TableName, filters: Record<string, unknown>, ilike: Record<string, string>) {
  return state.rows[table].filter((row) => {
    for (const [key, expected] of Object.entries(filters)) {
      if (String(row[key] ?? "") !== String(expected ?? "")) {
        return false;
      }
    }
    for (const [key, pattern] of Object.entries(ilike)) {
      const needle = String(pattern).toLowerCase().replace(/%/g, "");
      const haystack = String(row[key] ?? "").toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    return true;
  });
}

vi.mock("@/lib/delivery-intelligence/accounts", () => ({
  getSyncableDeliveryAccounts: vi.fn(async () => []),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => "job-1"),
}));

vi.mock("@/lib/delivery-intelligence/algeria-wilayas", () => ({
  mergeWithAlgeriaSeed: vi.fn((rows: unknown[]) => rows),
  findMissingWilayas: vi.fn(() => []),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "background_jobs") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                }),
              }),
              in: () => ({
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === "merchant_delivery_accounts") {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              state.accountUpdates.push(row);
              return { error: null };
            },
          }),
        };
      }

      if (table === "delivery_providers") {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              state.providerUpdates.push(row);
              return { error: null };
            },
          }),
        };
      }

      if (table === "delivery_prices") {
        return {
          delete: () => ({
            eq: (k1: string, v1: unknown) => ({
              eq: async (k2: string, v2: unknown) => {
                state.rows.delivery_prices = state.rows.delivery_prices.filter((row) => {
                  return !(String(row[k1] ?? "") === String(v1 ?? "") && String(row[k2] ?? "") === String(v2 ?? ""));
                });
                return { error: null };
              },
            }),
          }),
          upsert: async (rows: Array<Record<string, unknown>>) => {
            state.rows.delivery_prices.push(...rows);
            return { error: null };
          },
          select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
            const filters: Record<string, unknown> = {};
            const ilike: Record<string, string> = {};
            const chain: Record<string, unknown> = {
              count: 0,
              error: null,
              eq: (key: string, value: unknown) => {
                filters[key] = value;
                chain.count = countRows("delivery_prices", filters);
                return chain;
              },
              ilike: (key: string, value: string) => {
                ilike[key] = value;
                return chain;
              },
              order: () => chain,
              limit: () => chain,
              maybeSingle: async () => {
                const rows = filterRows("delivery_prices", filters, ilike);
                return { data: rows[0] ?? null, error: null };
              },
            };
            if (options?.head) {
              chain.eq = (key: string, value: unknown) => {
                filters[key] = value;
                chain.count = countRows("delivery_prices", filters);
                return chain;
              };
            }
            return chain;
          },
        };
      }

      if (table === "delivery_wilayas" || table === "delivery_communes" || table === "delivery_stopdesks") {
        const t = table as TableName;
        return {
          upsert: async (rows: Array<Record<string, unknown>>) => {
            state.rows[t].push(...rows);
            return { error: null };
          },
          select: () => {
            const filters: Record<string, unknown> = {};
            const chain: Record<string, unknown> = {
              count: 0,
              error: null,
              eq: (key: string, value: unknown) => {
                filters[key] = value;
                chain.count = countRows(t, filters);
                return chain;
              },
            };
            return chain;
          },
        };
      }

      return {
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
        select: () => ({ eq: () => ({ count: 0, error: null }) }),
      };
    },
  }),
}));

import { syncDeliveryCacheForAccount } from "@/lib/delivery-intelligence/delivery-cache";

function mkAccount(provider: "yalidine" | "zr_express" = "yalidine") {
  return {
    id: `acc-${provider}`,
    merchant_id: "merchant-1",
    provider,
    provider_name: null,
    base_url: provider === "yalidine" ? "https://api.yalidine.app" : "https://api.zr.test",
    auth_type: "AUTH_TYPE_API_KEY",
    credentials: { apiKey: "token", tenantId: "tenant", from_wilaya_id: "16" },
    endpoints: {
      orders: "/v1/parcels/?page_size=200",
      optional: {
        wilayas: "/v1/wilayas/",
        communes: "/v1/communes/",
        centers: "/v1/centers/",
        fees: "/v1/fees/",
      },
    },
    field_mapping: {
      ordersPath: "data",
      orderId: "id",
      createdAt: "created_at",
      lastStateUpdateAt: "updated_at",
    },
    status_mapping: null,
    last_sync_at: null,
    last_created_at_synced: null,
    last_state_update_at_synced: null,
    last_error_message: null,
  };
}

function makeCommuneRows(total: number) {
  const rows: Array<Record<string, unknown>> = [];
  rows.push({
    id: "2635",
    name: "Meftah",
    wilaya_id: "9",
  });
  for (let i = 1; i < total; i += 1) {
    const isConstantine = i <= 12;
    rows.push({
      id: `${i}`,
      name: isConstantine ? `Constantine-${i}` : `Commune-${i}`,
      wilaya_id: isConstantine ? "25" : "16",
    });
  }
  return rows;
}

function jsonResponse(body: Record<string, unknown>, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

describe("delivery cache yalidine sync", () => {
  beforeEach(() => {
    resetState();
    vi.restoreAllMocks();
  });

  it("uses /v1/communes for communes and /v1/centers for stopdesks", async () => {
    const communes = makeCommuneRows(1105);
    const perCommune = Object.fromEntries(
      communes.map((row) => [String(row.id), { express_home: 450, express_desk: 300 }]),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/wilayas/")) {
        return jsonResponse({ data: [{ id: "16", name: "Alger" }, { id: "25", name: "Constantine" }] });
      }
      if (url.includes("/v1/communes/")) {
        return jsonResponse({ data: communes });
      }
      if (url.includes("/v1/centers/")) {
        return jsonResponse({
          data: [
            { id: "c-1", name: "Center 1", wilaya_id: "16", commune_id: "5001", commune_name: "Hydra" },
            { id: "c-2", name: "Center 2", wilaya_id: "25", commune_id: "5002", commune_name: "Constantine Center" },
          ],
        });
      }
      if (url.includes("/v1/fees/")) {
        return jsonResponse({ per_commune: perCommune });
      }
      return jsonResponse({}, 404);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncDeliveryCacheForAccount(mkAccount() as never, {
      force: true,
      triggerSource: "dashboard_manual",
    });

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.some((url) => url.includes("/v1/communes/"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/v1/centers/"))).toBe(true);
    expect(calledUrls.some((url) => url.includes("/v1/fees/"))).toBe(true);

    expect(result.synced).toBe(true);
    expect(state.rows.delivery_communes.length).toBe(1105);
    expect(state.rows.delivery_stopdesks.length).toBe(2);
    expect(state.rows.delivery_communes.filter((row) => String(row.wilaya_id) === "25").length).toBe(12);
  });

  it("paginates communes using has_more and page_size fallback", async () => {
    const communes = makeCommuneRows(1105);
    const perCommune = Object.fromEntries(
      communes.map((row) => [String(row.id), { express_home: 500, express_desk: 350 }]),
    );
    const page = (url: string) => Number(new URL(url).searchParams.get("page") ?? "1");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/wilayas/")) {
        return jsonResponse({ data: [{ id: "16", name: "Alger" }, { id: "25", name: "Constantine" }] });
      }
      if (url.includes("/v1/communes/")) {
        const p = page(url);
        const start = (p - 1) * 500;
        const chunk = communes.slice(start, start + 500);
        return jsonResponse({
          data: chunk,
          has_more: p < 3,
          page_size: 500,
        });
      }
      if (url.includes("/v1/centers/")) {
        return jsonResponse({ data: [{ id: "c-1", name: "Center 1", wilaya_id: "16", commune_id: "501", commune_name: "Hydra" }] });
      }
      if (url.includes("/v1/fees/")) {
        return jsonResponse({ per_commune: perCommune });
      }
      return jsonResponse({}, 404);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncDeliveryCacheForAccount(mkAccount() as never, { force: true });

    expect(result.synced).toBe(true);
    expect(state.rows.delivery_communes.length).toBe(1105);
    const communeCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/v1/communes/"));
    expect(communeCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns partial success when centers endpoint fails", async () => {
    const communes = makeCommuneRows(1105);
    const perCommune = Object.fromEntries(
      communes.map((row) => [String(row.id), { express_home: 550, express_desk: 375 }]),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/wilayas/")) {
        return jsonResponse({ data: [{ id: "16", name: "Alger" }, { id: "25", name: "Constantine" }] });
      }
      if (url.includes("/v1/communes/")) {
        return jsonResponse({ data: communes });
      }
      if (url.includes("/v1/centers/")) {
        return jsonResponse({ message: "centers unavailable" }, 500);
      }
      if (url.includes("/v1/fees/")) {
        return jsonResponse({ per_commune: perCommune });
      }
      return jsonResponse({}, 404);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncDeliveryCacheForAccount(mkAccount() as never, { force: true });

    expect(result.synced).toBe(true);
    expect(result.partial).toMatchObject({
      centersFetchSucceeded: false,
    });
    expect(state.rows.delivery_communes.length).toBe(1105);
    expect(state.rows.delivery_stopdesks.length).toBe(0);
  });

  it("surfaces quota-safe 429 with retry-after metadata", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/wilayas/")) {
        return jsonResponse(
          { message: "too many requests" },
          429,
          {
            "retry-after": "30",
            "x-second-quota-left": "0",
            "x-minute-quota-left": "0",
            "x-hour-quota-left": "10",
            "x-day-quota-left": "500",
          },
        );
      }
      return jsonResponse({}, 404);
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(syncDeliveryCacheForAccount(mkAccount() as never, { force: true })).rejects.toThrow(
      "provider_cache_sync_quota_yalidine_429:retry_after=30",
    );

    const lastAccountUpdate = state.accountUpdates[state.accountUpdates.length - 1] ?? {};
    expect(String(lastAccountUpdate.last_error_message ?? "")).toContain("yalidine_cache_failed_at:");
    expect(String(lastAccountUpdate.last_error_message ?? "")).toContain("provider_cache_sync_quota_yalidine_429");
  });

  it("keeps ZR non-forced recent sync skip behavior unchanged", async () => {
    const account = {
      ...mkAccount("zr_express"),
      last_sync_at: new Date().toISOString(),
    };

    const result = await syncDeliveryCacheForAccount(account as never, { force: false });

    expect(result).toMatchObject({
      synced: false,
      skipped: true,
      provider: "zr_express",
    });
  });
});
