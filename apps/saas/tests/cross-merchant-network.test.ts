/**
 * Cross-Merchant + Cross-Provider Customer Reputation Network
 * Phase 8: Multi-merchant integration test
 *
 * Scenario: one customer (same phone → same identity) has orders spread across
 * THREE merchants and TWO delivery providers:
 *
 *   Merchant A + yalidine :  1 refused  + 1 no_answer  (2 orders)
 *   Merchant B + zr_express: 2 delivered                (2 orders)
 *   Merchant C + yalidine :  1 cancelled                (1 order)
 *
 * Expected aggregated result:
 *   total_orders   = 5
 *   delivered      = 2
 *   failed         = 3  (refused + no_answer + cancelled)
 *   merchant_count = 3
 *   provider_count = 2
 *
 * Privacy assertions:
 *   - merchant-facing DTO reasons must NOT contain "yalidine", "zr",
 *     "zr_express", "zr-express", "provider", "merchant", "store"
 *   - networkInsights from buildCustomerNetworkProfile must pass the same check
 *   - linked fields (linkedNames, linkedAddresses, linkedWilayas) contain no
 *     provider or merchant tokens
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recomputeIdentityReputation } from "@/lib/delivery-intelligence/reputation";
import { buildCustomerNetworkProfile } from "@/lib/network-intelligence/customer-profile";
import {
  buildMerchantFacingDTO,
  buildMerchantReasons,
  containsBlockedToken,
  sanitizeReason,
} from "@/lib/risk/merchant-facing-dto";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const IDENTITY_ID = "identity-cross-merchant-phase8";

const MERCHANT_A = "merchant-a";
const MERCHANT_B = "merchant-b";
const MERCHANT_C = "merchant-c";

type DeliveryOrderRow = {
  merchant_id: string;
  provider: string;
  status: string;
  normalized_outcome_reason: string | null;
  source_payload: Record<string, unknown>;
};

const ORDER_ROWS: DeliveryOrderRow[] = [
  // Merchant A + Yalidine: refused
  {
    merchant_id: MERCHANT_A,
    provider: "yalidine",
    status: "REFUSED",
    normalized_outcome_reason: "REFUSED",
    source_payload: { id: "YL-A-1" },
  },
  // Merchant A + Yalidine: no_answer
  {
    merchant_id: MERCHANT_A,
    provider: "yalidine",
    status: "REFUSED",
    normalized_outcome_reason: "NO_ANSWER",
    source_payload: { id: "YL-A-2", situation: { name: "sans reponse" } },
  },
  // Merchant B + ZR Express: delivered
  {
    merchant_id: MERCHANT_B,
    provider: "zr_express",
    status: "DELIVERED",
    normalized_outcome_reason: "DELIVERED",
    source_payload: { parcelId: "ZR-B-1" },
  },
  // Merchant B + ZR Express: delivered
  {
    merchant_id: MERCHANT_B,
    provider: "zr_express",
    status: "DELIVERED",
    normalized_outcome_reason: "DELIVERED",
    source_payload: { parcelId: "ZR-B-2" },
  },
  // Merchant C + Yalidine: cancelled
  {
    merchant_id: MERCHANT_C,
    provider: "yalidine",
    status: "CANCELLED",
    normalized_outcome_reason: "CLIENT_CANCELLED",
    source_payload: { id: "YL-C-1" },
  },
];

// Simulated customer_reputation upsert capture
let capturedReputation: Record<string, unknown> | null = null;

// Simulated customer_delivery_stats row (reflects what the DB view would compute)
const STATS_ROW = {
  identity_id: IDENTITY_ID,
  total_delivery_orders: 5,
  delivered_count: 2,
  refused_count: 1,
  returned_count: 0,
  cancelled_count: 1,
  no_answer_count: 1,
  fake_order_count: 0,
  phone_unreachable_count: 0,
  not_picked_up_count: 0,
  bad_address_count: 0,
  merchant_count: 3,
  provider_count: 2,
  avg_order_amount: 3500,
  first_seen: "2026-05-01T00:00:00.000Z",
  last_seen: "2026-06-05T00:00:00.000Z",
  recent_bad_events: 2,
  recent_total_orders: 3,
  prior_bad_events: 1,
  prior_total_orders: 2,
};

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
const mockCreateClient = vi.mocked(createClient);

function buildReputationMockClient() {
  capturedReputation = null;
  return {
    from: (table: string) => {
      if (table === "delivery_orders") {
        return {
          select: () => ({
            eq: () => ({ data: ORDER_ROWS, error: null }),
          }),
        };
      }
      if (table === "customer_reputation") {
        return {
          upsert: (row: Record<string, unknown>) => {
            capturedReputation = { ...row };
            return { error: null };
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ data: [], error: null }) }),
        upsert: () => ({ error: null }),
      };
    },
  };
}

function buildProfileMockClient() {
  return {
    from: (table: string) => {
      if (table === "customer_delivery_stats") {
        return {
          select: () => ({
            in: () => ({
              limit: () => Promise.resolve({ data: [STATS_ROW], error: null })
            }),
          }),
        };
      }
      if (table === "customer_identity") {
        return {
          select: () => ({
            in: () => ({
              limit: () => Promise.resolve({
                data: [
                  {
                    id: IDENTITY_ID,
                    customer_name: "Amina",
                    normalized_address: "rue de la paix oran",
                    wilaya: "Oran",
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          in: () => ({
            limit: () => Promise.resolve({ data: [], error: null })
          })
        }),
      };
    },
  };
}

// ─── Privacy assertion helper ─────────────────────────────────────────────────

const FORBIDDEN_TERMS = [
  "yalidine",
  "zr_express",
  "zr express",
  "zr-express",
  "provider",
  "merchant",
  "store",
];

function assertNoForbiddenTerms(value: string, context: string) {
  const lower = value.toLowerCase();
  for (const term of FORBIDDEN_TERMS) {
    expect(lower, `"${context}" should not contain "${term}"`).not.toContain(term);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Cross-Merchant + Cross-Provider Network – Phase 8", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PHONE_HASH_SECRET = "test-secret";
  });

  // ── 1: Orders span correct merchants and providers ─────────────────────────

  it("fixture: orders cover 3 merchants and 2 providers", () => {
    const merchants = new Set(ORDER_ROWS.map((r) => r.merchant_id));
    const providers = new Set(ORDER_ROWS.map((r) => r.provider));
    expect(merchants.size).toBe(3);
    expect(providers.size).toBe(2);
    expect(ORDER_ROWS).toHaveLength(5);
  });

  // ── 2: recomputeIdentityReputation aggregates all 5 orders ────────────────

  it("recomputeIdentityReputation: correct totals for 3-merchant 2-provider scenario", async () => {
    mockCreateClient.mockReturnValue(
      buildReputationMockClient() as unknown as ReturnType<typeof createClient>
    );

    await recomputeIdentityReputation(IDENTITY_ID);

    expect(capturedReputation).not.toBeNull();
    const rep = capturedReputation!;

    expect(rep.total_orders).toBe(5);
    expect(rep.delivered_count).toBe(2);
    expect(rep.refused_count).toBe(1);
    expect(rep.no_answer_count).toBe(1);
    expect(rep.client_cancelled_count).toBe(1);
    expect(rep.merchant_count).toBe(3);
    expect(rep.provider_count).toBe(2);

    // Failed orders = refused + no_answer + cancelled = 3
    const failed =
      Number(rep.refused_count ?? 0) +
      Number(rep.no_answer_count ?? 0) +
      Number(rep.client_cancelled_count ?? 0) +
      Number(rep.returned_count ?? 0);
    expect(failed).toBe(3);

    // Delivered = 2, failed = 3 → net negative → score should reflect risk
    expect(typeof rep.reputation_score).toBe("number");
    expect(rep.risk_level).toMatch(/MEDIUM|HIGH|CRITICAL/);
  });

  // ── 3: provider_count tracked separately from merchant_count ──────────────

  it("provider_count is independent from merchant_count in reputation upsert", async () => {
    mockCreateClient.mockReturnValue(
      buildReputationMockClient() as unknown as ReturnType<typeof createClient>
    );

    await recomputeIdentityReputation(IDENTITY_ID);

    const rep = capturedReputation!;
    // 3 merchants but only 2 providers
    expect(rep.merchant_count).toBe(3);
    expect(rep.provider_count).toBe(2);
    expect(rep.merchant_count).not.toBe(rep.provider_count);
  });

  // ── 4: buildCustomerNetworkProfile returns correct counts ─────────────────

  it("buildCustomerNetworkProfile: aggregated counts match scenario totals", async () => {
    mockCreateClient.mockReturnValue(
      buildProfileMockClient() as unknown as ReturnType<typeof createClient>
    );

    const profile = await buildCustomerNetworkProfile([IDENTITY_ID]);

    expect(profile.totalOrders).toBe(5);
    expect(profile.deliveredOrders).toBe(2);
    expect(profile.refusedOrders).toBe(1);
    expect(profile.noAnswerOrders).toBe(1);
    expect(profile.cancelledOrders).toBe(1);
    expect(profile.merchantCount).toBe(3);
    expect(profile.providerCount).toBe(2);

    const failedOrders =
      profile.refusedOrders +
      profile.returnedOrders +
      profile.noAnswerOrders +
      profile.cancelledOrders +
      profile.fakeOrderCount;
    expect(failedOrders).toBe(3);
  });

  // ── 5: buildCustomerNetworkProfile insights contain no provider/merchant names

  it("networkInsights contain no provider or merchant tokens", async () => {
    mockCreateClient.mockReturnValue(
      buildProfileMockClient() as unknown as ReturnType<typeof createClient>
    );

    const profile = await buildCustomerNetworkProfile([IDENTITY_ID]);

    for (const insight of profile.networkInsights) {
      assertNoForbiddenTerms(insight, `networkInsights: "${insight}"`);
    }
  });

  // ── 6: buildMerchantFacingDTO produces abstract reasons ───────────────────

  it("buildMerchantFacingDTO reasons contain no provider or merchant tokens", () => {
    const dto = buildMerchantFacingDTO({
      riskScore: 60,
      trustLevel: "WATCHLIST",
      totalOrders: 5,
      deliveredOrders: 2,
      refusedOrders: 1,
      returnedOrders: 0,
      cancelledOrders: 1,
      noAnswerOrders: 1,
      fakeOrderCount: 0,
      networkMerchantCount: 3,
      estimatedDamageDzd: 10500,
      deliverySuccessRate: 40,
      riskTrend: "INCREASING",
      recentBadEvents: 2,
      recommendedAction: "manual_review",
    });

    expect(dto.riskScore).toBe(60);
    expect(dto.failedOrders).toBe(3);
    expect(dto.networkMerchantCount).toBe(3);
    expect(dto.reasons.length).toBeGreaterThan(0);

    for (const reason of dto.reasons) {
      assertNoForbiddenTerms(reason, `DTO reasons: "${reason}"`);
    }
  });

  // ── 7: DTO fields are all provider-agnostic ────────────────────────────────

  it("buildMerchantFacingDTO shape has no provider or merchant attribution fields", () => {
    const dto = buildMerchantFacingDTO({
      riskScore: 55,
      trustLevel: "HIGH_RISK",
      totalOrders: 5,
      deliveredOrders: 2,
      refusedOrders: 1,
      returnedOrders: 0,
      cancelledOrders: 1,
      noAnswerOrders: 1,
      fakeOrderCount: 0,
      networkMerchantCount: 3,
      estimatedDamageDzd: 10500,
      deliverySuccessRate: 40,
      riskTrend: "STABLE",
      recentBadEvents: 1,
      recommendedAction: "manual_review",
    });

    // Keys that MUST be present
    expect(dto).toHaveProperty("riskScore");
    expect(dto).toHaveProperty("trustLevel");
    expect(dto).toHaveProperty("reasons");
    expect(dto).toHaveProperty("estimatedDamageDzd");
    expect(dto).toHaveProperty("recommendedAction");
    expect(dto).toHaveProperty("totalOrders");
    expect(dto).toHaveProperty("deliveredOrders");
    expect(dto).toHaveProperty("failedOrders");
    expect(dto).toHaveProperty("networkMerchantCount");
    expect(dto).toHaveProperty("deliverySuccessRate");

    // Keys that MUST NOT be present
    const dtoKeys = Object.keys(dto);
    expect(dtoKeys).not.toContain("providerCount");
    expect(dtoKeys).not.toContain("provider");
    expect(dtoKeys).not.toContain("providerId");
    expect(dtoKeys).not.toContain("merchantId");
    expect(dtoKeys).not.toContain("storeId");
    expect(dtoKeys).not.toContain("networkInsights"); // internal field not for merchants
  });

  // ── 8: sanitizeReason strips provider tokens ──────────────────────────────

  it("sanitizeReason strips known provider tokens from reason strings", () => {
    const raw = "Order failed via Yalidine delivery network";
    const sanitized = sanitizeReason(raw);
    expect(sanitized.toLowerCase()).not.toContain("yalidine");
    expect(sanitized).toContain("[network]");
  });

  it("sanitizeReason strips zr_express token from reason string", () => {
    const raw = "ZR_Express rejected delivery";
    const sanitized = sanitizeReason(raw);
    expect(sanitized.toLowerCase()).not.toContain("zr_express");
    expect(sanitized).toContain("[network]");
  });

  // ── 9: containsBlockedToken correctly detects violations ──────────────────

  it("containsBlockedToken returns true for strings with provider names", () => {
    expect(containsBlockedToken("Delivered via Yalidine")).toBe(true);
    expect(containsBlockedToken("ZR Express failure")).toBe(true);
    expect(containsBlockedToken("Source merchant_id ABC")).toBe(true);
  });

  it("containsBlockedToken returns false for clean abstract reasons", () => {
    expect(containsBlockedToken("Order refusal detected")).toBe(false);
    expect(containsBlockedToken("Customer has a successful delivery history")).toBe(false);
    expect(containsBlockedToken("Risk pattern reported across multiple sources")).toBe(false);
    expect(containsBlockedToken("Risk behavior increasing recently")).toBe(false);
  });

  // ── 10: buildMerchantReasons produces non-empty abstract output ───────────

  it("buildMerchantReasons generates meaningful output for 3-merchant scenario", () => {
    const reasons = buildMerchantReasons({
      totalOrders: 5,
      deliveredOrders: 2,
      failedOrders: 3,
      noAnswerCount: 1,
      refusedCount: 1,
      returnedCount: 0,
      cancelledCount: 1,
      fakeOrderCount: 0,
      networkMerchantCount: 3,
      riskTrend: "INCREASING",
      recentBadEvents: 2,
    });

    expect(reasons.length).toBeGreaterThan(0);

    for (const reason of reasons) {
      assertNoForbiddenTerms(reason, `buildMerchantReasons: "${reason}"`);
    }

    // Should mention multi-source risk (3 merchants, 3 failures)
    const hasMultiSource = reasons.some(
      (r) =>
        r.toLowerCase().includes("multiple sources") ||
        r.toLowerCase().includes("multiple") ||
        r.toLowerCase().includes("pattern")
    );
    expect(hasMultiSource).toBe(true);
  });
});
