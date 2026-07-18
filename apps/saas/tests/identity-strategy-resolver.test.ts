import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMerchantFacingDTO } from "@/lib/risk/merchant-facing-dto";
import { recomputeIdentityReputation, resolveIdentityCandidate } from "@/lib/delivery-intelligence/reputation";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

const mockCreateClient = vi.mocked(createClient);

type IdentityRow = {
  id: string;
  phone_hash: string;
  customer_name: string | null;
  normalized_address: string | null;
  wilaya: string | null;
  commune: string | null;
  updated_at: string | null;
};

type ResolverState = {
  identities: IdentityRow[];
  fingerprintPrimaryIdentityId: string | null;
  historyRows: Array<{ identity_id: string | null }>;
};

function makeResolverSupabase(state: ResolverState) {
  return {
    from: (table: string) => {
      if (table === "customer_identity") {
        const rows = [...state.identities];
        const query = {
          select: (_cols: string) => {
            let current = [...rows];
            const chain = {
              eq: (column: string, value: string) => {
                current = current.filter((row) => String((row as Record<string, unknown>)[column] ?? "") === String(value));
                return chain;
              },
              order: (column: string, cfg: { ascending: boolean }) => {
                current = [...current].sort((a, b) => {
                  const av = String((a as Record<string, unknown>)[column] ?? "");
                  const bv = String((b as Record<string, unknown>)[column] ?? "");
                  return cfg.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
                });
                return chain;
              },
              limit: (n: number) => ({ data: current.slice(0, n), error: null }),
              maybeSingle: () => ({ data: current[0] ?? null, error: null }),
            };
            return chain;
          },
        };
        return query;
      }

      if (table === "identity_fingerprint") {
        return {
          select: (_cols: string) => ({
            eq: (_column: string, _value: string) => ({
              maybeSingle: () => ({
                data: state.fingerprintPrimaryIdentityId
                  ? { primary_identity_id: state.fingerprintPrimaryIdentityId }
                  : null,
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "delivery_orders") {
        return {
          select: (_cols: string) => ({
            in: (_column: string, identityIds: string[]) => {
              const filtered = state.historyRows.filter((row) => row.identity_id && identityIds.includes(row.identity_id));
              return {
                not: (_col: string, _op: string, _value: null) => ({
                  neq: (_col2: string, _value2: string) => ({
                    limit: (_n: number) => ({ data: filtered, error: null }),
                  }),
                }),
              };
            },
          }),
        };
      }

      throw new Error(`Unhandled table in resolver mock: ${table}`);
    },
  };
}

function makeRecomputeClient(identityId: string) {
  let captured: Record<string, unknown> | null = null;

  const client = {
    from: (table: string) => {
      if (table === "delivery_orders") {
        return {
          select: (_cols: string) => ({
            eq: (_column: string, value: string) => {
              if (value !== identityId) {
                return { data: [], error: null };
              }
              return {
                data: [
                  {
                    merchant_id: "merchant-a",
                    provider: "yalidine",
                    status: "DELIVERED",
                    source_payload: {},
                    normalized_outcome_reason: "DELIVERED",
                  },
                  {
                    merchant_id: "merchant-b",
                    provider: "zr_express",
                    status: "RETURNED",
                    source_payload: {},
                    normalized_outcome_reason: "RETURNED",
                  },
                ],
                error: null,
              };
            },
          }),
        };
      }

      if (table === "customer_reputation") {
        return {
          upsert: (row: Record<string, unknown>) => {
            captured = { ...row };
            return { error: null };
          },
        };
      }

      throw new Error(`Unhandled table in recompute mock: ${table}`);
    },
    getCaptured: () => captured,
  };

  return client;
}

function buildMerchantApiPayload() {
  const dto = buildMerchantFacingDTO({
    riskScore: 62,
    trustLevel: "WATCHLIST",
    totalOrders: 2,
    deliveredOrders: 1,
    refusedOrders: 0,
    returnedOrders: 1,
    cancelledOrders: 0,
    noAnswerOrders: 0,
    fakeOrderCount: 0,
    networkMerchantCount: 2,
    estimatedDamageDzd: 1500,
    deliverySuccessRate: 50,
    riskTrend: "STABLE",
    recentBadEvents: 1,
    recommendedAction: "verify",
  });

  return {
    riskScore: dto.riskScore,
    trustLevel: dto.trustLevel,
    why: dto.reasons,
    estimatedDamage: dto.estimatedDamageDzd,
    recommendedAction: dto.recommendedAction,
  };
}

describe("identity strategy resolver paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases = [
    {
      id: "A",
      expectedReason: "PHONE_MATCH",
      expectedLevel: "HIGH",
      expectedMinScore: 100,
      state: {
        identities: [
          {
            id: "identity-phone",
            phone_hash: "phone-target",
            customer_name: "Nadir Alpha",
            normalized_address: "alpha avenue 11",
            wilaya: "alger",
            commune: "alger centre",
            updated_at: "2026-06-09T10:00:00.000Z",
          },
        ],
        fingerprintPrimaryIdentityId: null,
        historyRows: [],
      },
      input: {
        phoneHash: "phone-target",
        fingerprintHash: "fp-a",
        normalizedName: "nadir alpha",
        normalizedAddress: "alpha avenue 11",
        normalizedWilaya: "alger",
        normalizedCommune: "alger centre",
      },
      expectedIdentityId: "identity-phone",
    },
    {
      id: "B",
      expectedReason: "NAME_ADDRESS_MATCH",
      expectedLevel: "MEDIUM",
      expectedMinScore: 78,
      state: {
        identities: [
          {
            id: "identity-name-address",
            phone_hash: "other-phone",
            customer_name: "Karim Messaoudi",
            normalized_address: "rue horizon 22",
            wilaya: "alger",
            commune: "alger centre",
            updated_at: "2026-06-09T10:00:00.000Z",
          },
        ],
        fingerprintPrimaryIdentityId: null,
        historyRows: [],
      },
      input: {
        phoneHash: "phone-target-b",
        fingerprintHash: "fp-b",
        normalizedName: "karim messaoudi",
        normalizedAddress: "rue horizon 22",
        normalizedWilaya: "alger",
        normalizedCommune: "alger centre",
      },
      expectedIdentityId: "identity-name-address",
    },
    {
      id: "C",
      expectedReason: "FINGERPRINT_MATCH",
      expectedLevel: "MEDIUM",
      expectedMinScore: 86,
      state: {
        identities: [
          {
            id: "identity-fingerprint",
            phone_hash: "old-phone-c",
            customer_name: "Mohamed Ali",
            normalized_address: "bloc standard 33",
            wilaya: "alger",
            commune: "oran",
            updated_at: "2026-06-09T10:00:00.000Z",
          },
        ],
        fingerprintPrimaryIdentityId: "identity-fingerprint",
        historyRows: [],
      },
      input: {
        phoneHash: "new-phone-c",
        fingerprintHash: "fp-c",
        normalizedName: "mohamed ali",
        normalizedAddress: "bloc standard 33",
        normalizedWilaya: "alger",
        normalizedCommune: "constantine",
      },
      expectedIdentityId: "identity-fingerprint",
    },
    {
      id: "D",
      expectedReason: "PHONE_CHANGE_CONTINUITY",
      expectedLevel: "HIGH",
      expectedMinScore: 94,
      state: {
        identities: [
          {
            id: "identity-continuity",
            phone_hash: "old-phone-d",
            customer_name: "Mohamed Ali",
            normalized_address: "bloc continuity 44",
            wilaya: "alger",
            commune: "alger centre",
            updated_at: "2026-06-09T10:00:00.000Z",
          },
        ],
        fingerprintPrimaryIdentityId: "identity-continuity",
        historyRows: [{ identity_id: "identity-continuity" }],
      },
      input: {
        phoneHash: "new-phone-d",
        fingerprintHash: "fp-d",
        normalizedName: "mohamed ali",
        normalizedAddress: "bloc continuity 44",
        normalizedWilaya: "alger",
        normalizedCommune: "alger centre",
      },
      expectedIdentityId: "identity-continuity",
    },
  ] as const;

  for (const testCase of cases) {
    it(`scenario ${testCase.id} resolves ${testCase.expectedReason} and keeps merchant response clean`, async () => {
      const resolverSupabase = makeResolverSupabase(testCase.state as unknown as ResolverState);

      const resolved = await resolveIdentityCandidate({
        supabase: resolverSupabase as unknown as ReturnType<typeof createClient>,
        phoneHash: testCase.input.phoneHash,
        fingerprintHash: testCase.input.fingerprintHash,
        normalizedName: testCase.input.normalizedName,
        normalizedAddress: testCase.input.normalizedAddress,
        normalizedWilaya: testCase.input.normalizedWilaya,
        normalizedCommune: testCase.input.normalizedCommune,
      });

      expect(resolved.identityId).toBeTruthy();
      expect(resolved.identityId).toBe(testCase.expectedIdentityId);
      expect(resolved.mergeReason).toBe(testCase.expectedReason);
      expect(resolved.confidenceLevel).toBe(testCase.expectedLevel);
      expect(resolved.confidenceScore).toBeGreaterThanOrEqual(testCase.expectedMinScore);

      const recomputeClient = makeRecomputeClient(testCase.expectedIdentityId);
      mockCreateClient.mockReturnValue(recomputeClient as unknown as ReturnType<typeof createClient>);

      const agg = await recomputeIdentityReputation(testCase.expectedIdentityId);
      expect(agg.merchantCount).toBe(2);
      expect(agg.providerCount).toBe(2);

      const upsert = recomputeClient.getCaptured() as Record<string, unknown>;
      expect(Number(upsert.merchant_count ?? 0)).toBe(2);
      expect(Number(upsert.provider_count ?? 0)).toBe(2);

      const merchantPayload = buildMerchantApiPayload();
      const keys = Object.keys(merchantPayload).sort();
      expect(keys).toEqual(["estimatedDamage", "recommendedAction", "riskScore", "trustLevel", "why"]);

      const payloadBlob = JSON.stringify(merchantPayload).toLowerCase();
      expect(payloadBlob).not.toContain("merchant_id");
      expect(payloadBlob).not.toContain("merchantname");
      expect(payloadBlob).not.toContain("provider_id");
      expect(payloadBlob).not.toContain("providername");
      expect(payloadBlob).not.toContain("fingerprint_hash");
      expect(payloadBlob).not.toContain("identity_links");
      expect(payloadBlob).not.toContain("merge_reason");
    });
  }
});
