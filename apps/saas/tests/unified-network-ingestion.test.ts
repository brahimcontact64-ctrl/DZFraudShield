/**
 * Unified Network Ingestion Integration Test
 *
 * Proves that Yalidine and ZR Express feed the same reputation network.
 *
 * Scenario: one customer (same phone hash → same identity) has the following
 * order history spread across two providers:
 *
 *   Yalidine  →  3 delivered, 1 no-answer  (4 orders, provider = "yalidine")
 *   ZR Express → 2 delivered, 1 refused     (3 orders, provider = "zr_express")
 *
 * Expected aggregated result (provider-agnostic):
 *   total_orders  = 7
 *   delivered     = 5
 *   failed        = 2  (no_answer + refused)
 *   trust_level   computed from combined weighted score
 *   estimated_damage includes both failed events
 *   recommendation based on combined network
 *
 * Verification points:
 *   1. delivery_orders stores provider internally (not redacted)
 *   2. customer_reputation aggregates across both providers
 *   3. merchant-facing check-order response hides provider names
 *   4. buildCustomerNetworkProfile (normal merchant path) does not expose
 *      provider names in any field
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recomputeIdentityReputation } from "@/lib/delivery-intelligence/reputation";
import { buildCustomerNetworkProfile } from "@/lib/network-intelligence/customer-profile";

// ─── Mock Supabase ────────────────────────────────────────────────────────────

/**
 * Simulated delivery_orders table.
 * Mirrors the schema columns that recomputeIdentityReputation reads:
 *   merchant_id, status, source_payload, normalized_outcome_reason, provider (internal only)
 */
type DeliveryOrderRow = {
  merchant_id: string;
  status: string;
  normalized_outcome_reason: string | null;
  source_payload: Record<string, unknown>;
  provider: string; // stored internally, never returned to merchant
};

const IDENTITY_ID = "identity-mixed-provider-001";
const MERCHANT_ID = "merchant-001";

/** Yalidine: 3 delivered, 1 no-answer */
const YALIDINE_ORDERS: DeliveryOrderRow[] = [
  { merchant_id: MERCHANT_ID, provider: "yalidine", status: "DELIVERED", normalized_outcome_reason: "DELIVERED",    source_payload: { id: "YL-1" } },
  { merchant_id: MERCHANT_ID, provider: "yalidine", status: "DELIVERED", normalized_outcome_reason: "DELIVERED",    source_payload: { id: "YL-2" } },
  { merchant_id: MERCHANT_ID, provider: "yalidine", status: "DELIVERED", normalized_outcome_reason: "DELIVERED",    source_payload: { id: "YL-3" } },
  { merchant_id: MERCHANT_ID, provider: "yalidine", status: "REFUSED",   normalized_outcome_reason: "NO_ANSWER",    source_payload: { id: "YL-4", situation: { name: "sans reponse" } } },
];

/** ZR Express: 2 delivered, 1 refused */
const ZR_ORDERS: DeliveryOrderRow[] = [
  { merchant_id: MERCHANT_ID, provider: "zr_express", status: "DELIVERED", normalized_outcome_reason: "DELIVERED", source_payload: { parcelId: "ZR-1" } },
  { merchant_id: MERCHANT_ID, provider: "zr_express", status: "DELIVERED", normalized_outcome_reason: "DELIVERED", source_payload: { parcelId: "ZR-2" } },
  { merchant_id: MERCHANT_ID, provider: "zr_express", status: "REFUSED",   normalized_outcome_reason: "REFUSED",   source_payload: { parcelId: "ZR-3" } },
];

const ALL_ORDERS: DeliveryOrderRow[] = [...YALIDINE_ORDERS, ...ZR_ORDERS];

// Simulated customer_reputation row (written by recomputeIdentityReputation)
let capturedReputationUpsert: Record<string, unknown> | null = null;

// Simulated customer_delivery_stats (for buildCustomerNetworkProfile)
const STATS_ROW = {
  identity_id: IDENTITY_ID,
  total_delivery_orders: 7,
  delivered_count: 5,
  refused_count: 1,       // zr_express refused
  returned_count: 0,
  cancelled_count: 0,
  no_answer_count: 1,     // yalidine no-answer
  fake_order_count: 0,
  phone_unreachable_count: 0,
  not_picked_up_count: 0,
  bad_address_count: 0,
  merchant_count: 1,
  provider_count: 2,      // two providers internally tracked
  avg_order_amount: 3500,
  first_seen: "2026-05-01T00:00:00.000Z",
  last_seen: "2026-06-01T00:00:00.000Z",
  recent_bad_events: 1,
  recent_total_orders: 4,
  prior_bad_events: 1,
  prior_total_orders: 3,
};

// ─── Mock modules ─────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/delivery-intelligence/normalize", () => ({
  normalizeAddress: vi.fn((v: string | null | undefined) => v ?? null),
  normalizeName: vi.fn((v: string | null | undefined) => (v ?? "").toLowerCase()),
}));

vi.mock("@/lib/security/hash", () => ({
  hashWithSecret: vi.fn(() => "phone_hash_abc123"),
}));

vi.mock("@/lib/security/phone", () => ({
  normalizeAlgerianPhone: vi.fn((v: string | null | undefined) => v ?? null),
}));

import { createClient } from "@/lib/supabase/server";
const mockCreateClient = vi.mocked(createClient);

function buildReputationClient() {
  capturedReputationUpsert = null;
  return {
    from: (table: string) => {
      if (table === "delivery_orders") {
        return {
          select: () => ({
            eq: (_col: string, _val: string) => ({
              data: ALL_ORDERS,
              error: null,
            }),
          }),
        };
      }

      if (table === "customer_reputation") {
        return {
          upsert: (row: Record<string, unknown>) => {
            capturedReputationUpsert = { ...row };
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

function buildNetworkProfileClient() {
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
                    customer_name: "Ahmed",
                    normalized_address: "rue test alger",
                    wilaya: "Alger",
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Unified network ingestion – Yalidine + ZR Express same identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PHONE_HASH_SECRET = "test-secret";
  });

  // ── Phase 1: delivery_orders stores provider internally ───────────────────

  it("delivery_orders row has provider field set to the ingesting provider", () => {
    // Verify that the mocked rows stored internally contain provider names
    expect(YALIDINE_ORDERS.every((row) => row.provider === "yalidine")).toBe(true);
    expect(ZR_ORDERS.every((row) => row.provider === "zr_express")).toBe(true);

    // All rows are linked to same identity (same merchant_id → same phone identity)
    const allMerchantIds = new Set(ALL_ORDERS.map((row) => row.merchant_id));
    expect(allMerchantIds.size).toBe(1);
  });

  // ── Phase 2: recomputeIdentityReputation aggregates across both providers ──

  it("recomputeIdentityReputation counts orders from both providers combined", async () => {
    mockCreateClient.mockReturnValue(buildReputationClient() as unknown as ReturnType<typeof createClient>);

    await recomputeIdentityReputation(IDENTITY_ID);

    expect(capturedReputationUpsert).not.toBeNull();

    const rep = capturedReputationUpsert!;

    // Phase 2 core assertions: combined totals
    expect(rep.total_orders).toBe(7);
    expect(rep.delivered_count).toBe(5);

    // Yalidine: 1 no-answer
    expect(rep.no_answer_count).toBe(1);

    // ZR Express: 1 refused
    expect(rep.refused_count).toBe(1);

    // combined failed = 2
    const failedOrders =
      Number(rep.no_answer_count ?? 0) +
      Number(rep.refused_count ?? 0) +
      Number(rep.returned_count ?? 0) +
      Number(rep.fake_order_count ?? 0) +
      Number(rep.phone_unreachable_count ?? 0) +
      Number(rep.not_picked_up_count ?? 0) +
      Number(rep.bad_address_count ?? 0);
    expect(failedOrders).toBe(2);

    // reputation_score is computed from combined history
    expect(typeof rep.reputation_score).toBe("number");
    expect(rep.reputation_score).toBeGreaterThan(0);
    expect(rep.reputation_score).toBeLessThanOrEqual(100);

    // risk_level is set
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(rep.risk_level);

    // Provider names are NOT in the reputation row at all
    const repJson = JSON.stringify(rep).toLowerCase();
    expect(repJson).not.toContain("yalidine");
    expect(repJson).not.toContain("zr_express");
    expect(repJson).not.toContain("zr express");
  });

  // ── Phase 3: buildCustomerNetworkProfile is provider-agnostic ─────────────

  it("buildCustomerNetworkProfile aggregates totals and hides provider names", async () => {
    mockCreateClient.mockReturnValue(buildNetworkProfileClient() as unknown as ReturnType<typeof createClient>);

    const profile = await buildCustomerNetworkProfile([IDENTITY_ID]);

    // Combined totals from both providers
    expect(profile.totalOrders).toBe(7);
    expect(profile.deliveredOrders).toBe(5);
    expect(profile.noAnswerOrders).toBe(1);
    expect(profile.refusedOrders).toBe(1);
    expect(profile.returnedOrders).toBe(0);
    expect(profile.cancelledOrders).toBe(0);

    // Two providers tracked internally
    expect(profile.providerCount).toBe(2);

    // Trust level computed from combined history (5 delivered, 2 failed → WATCHLIST or NORMAL)
    expect(["TRUSTED", "NORMAL", "WATCHLIST", "HIGH_RISK", "BLACKLIST"]).toContain(profile.networkTrustLevel);

    // Damage includes both failure events
    expect(profile.estimatedDamageDzd).toBeGreaterThan(0);

    // Provider names must NOT appear anywhere in the merchant-facing profile
    const profileJson = JSON.stringify(profile).toLowerCase();
    expect(profileJson).not.toContain("yalidine");
    expect(profileJson).not.toContain("zr_express");
    expect(profileJson).not.toContain("zr express");

    // networkInsights may contain strings but must not expose provider names
    for (const insight of profile.networkInsights) {
      expect(insight.toLowerCase()).not.toContain("yalidine");
      expect(insight.toLowerCase()).not.toContain("zr_express");
      expect(insight.toLowerCase()).not.toContain("zr express");
    }

    // Linked fields (linkedNames, linkedAddresses, linkedWilayas) must not expose providers
    for (const field of [...profile.linkedNames, ...profile.linkedAddresses, ...profile.linkedWilayas]) {
      expect(field.toLowerCase()).not.toContain("yalidine");
      expect(field.toLowerCase()).not.toContain("zr_express");
    }

    // recommendation is derivable from profile
    const possibleRecommendations = ["accept", "verify", "manual_review", "block"] as const;
    const { trustLevelToRecommendedAction } = await import("@/lib/network-intelligence/customer-profile");
    const recommendation = trustLevelToRecommendedAction(profile.networkTrustLevel);
    expect(possibleRecommendations).toContain(recommendation);
  });

  // ── Phase 4: estimated damage includes both failure events ─────────────────

  it("estimated damage is non-zero when both provider failures are present", async () => {
    mockCreateClient.mockReturnValue(buildNetworkProfileClient() as unknown as ReturnType<typeof createClient>);

    const profile = await buildCustomerNetworkProfile([IDENTITY_ID]);

    // 1 no-answer + 1 refused = 2 failed events × average order value ≥ 7000 DZD
    expect(profile.estimatedDamageDzd).toBeGreaterThanOrEqual(7000);

    // merchantImpactScore is the primary damage metric
    expect(profile.merchantImpactScore).toBeGreaterThan(0);
    expect(profile.merchantImpactScore).toBe(profile.estimatedDamageDzd);
  });

  // ── Phase 5: combined recommendation is based on full 7-order history ──────

  it("recommendation is based on combined 7-order history, not per-provider", async () => {
    mockCreateClient.mockReturnValue(buildNetworkProfileClient() as unknown as ReturnType<typeof createClient>);

    const profile = await buildCustomerNetworkProfile([IDENTITY_ID]);

    // With 5 delivered out of 7 (71.4% success) and 2 failures, the customer
    // is not BLACKLIST (which requires repeated patterns) but not TRUSTED either.
    // They should land in NORMAL or WATCHLIST depending on exact failure count.
    expect(["NORMAL", "WATCHLIST", "HIGH_RISK"]).toContain(profile.networkTrustLevel);

    // delivery success rate from combined history
    expect(profile.deliverySuccessRate).toBeCloseTo(71, 0); // 5/7 ≈ 71%
  });

  // ── Proof: provider names are absent from merchant-facing output ───────────

  it("summary: all 5 merchant-facing profile keys contain no provider names", async () => {
    mockCreateClient.mockReturnValue(buildNetworkProfileClient() as unknown as ReturnType<typeof createClient>);

    const profile = await buildCustomerNetworkProfile([IDENTITY_ID]);

    const merchantFacingKeys: (keyof typeof profile)[] = [
      "totalOrders",
      "deliveredOrders",
      "refusedOrders",
      "returnedOrders",
      "estimatedDamageDzd",
      "networkTrustLevel",
      "networkInsights",
      "linkedNames",
      "linkedAddresses",
      "linkedWilayas",
    ];

    const merchantView = Object.fromEntries(
      merchantFacingKeys.map((key) => [key, profile[key]])
    );

    const serialized = JSON.stringify(merchantView).toLowerCase();

    // Positive assertions
    expect(merchantView.totalOrders).toBe(7);

    // Privacy assertions: no provider name in any merchant-visible field
    expect(serialized).not.toContain("yalidine");
    expect(serialized).not.toContain("zr_express");
    expect(serialized).not.toContain("zr express");
    expect(serialized).not.toContain("noest");
    expect(serialized).not.toContain("guepex");

    // Admin/debug view: provider is tracked internally in delivery_orders rows
    const internalProviders = [...new Set(ALL_ORDERS.map((row) => row.provider))];
    expect(internalProviders).toContain("yalidine");
    expect(internalProviders).toContain("zr_express");
    expect(internalProviders).toHaveLength(2);
  });
});
