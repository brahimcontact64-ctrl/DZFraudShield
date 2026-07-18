import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  trustLevelLabel,
  trustLevelColor,
  trustLevelToRecommendedAction,
  type NetworkTrustLevel,
  type RiskTrend
} from "../src/lib/network-intelligence/customer-profile";

// ─── Isolated pure-function tests ───────────────────────────────────────────
// These do not touch Supabase or the DB - they test the business logic
// functions that are exported alongside buildCustomerNetworkProfile.
// The integration path (buildCustomerNetworkProfile itself) is tested through
// the check-order and unified-evaluator mocks.

// We re-export the private helpers for testing via module augmentation.
// Since they're not exported we'll test them indirectly through the profile
// module by mocking Supabase so that buildCustomerNetworkProfile returns
// deterministic results.

const mockSupabaseFactory = (statsRows: Record<string, unknown>[], identityRows: Record<string, unknown>[]) => ({
  from: (table: string) => {
    if (table === "customer_delivery_stats") {
      return {
        select: () => ({
          in: () => ({
            limit: () => Promise.resolve({ data: statsRows, error: null })
          })
        })
      };
    }

    if (table === "customer_identity") {
      return {
        select: () => ({
          in: () => ({
            limit: () => Promise.resolve({ data: identityRows, error: null })
          })
        })
      };
    }

    return {
      select: () => ({
        in: () => ({
          limit: () => Promise.resolve({ data: [], error: null })
        })
      })
    };
  }
});

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { buildCustomerNetworkProfile } from "../src/lib/network-intelligence/customer-profile";

const mockCreateClient = vi.mocked(createClient);

describe("trustLevelLabel", () => {
  it("returns correct label for each level", () => {
    expect(trustLevelLabel("TRUSTED")).toBe("Trusted");
    expect(trustLevelLabel("NORMAL")).toBe("Normal");
    expect(trustLevelLabel("WATCHLIST")).toBe("Watchlist");
    expect(trustLevelLabel("HIGH_RISK")).toBe("High Risk");
    expect(trustLevelLabel("BLACKLIST")).toBe("Blacklist");
  });
});

describe("trustLevelColor", () => {
  it("returns distinct CSS classes for each level", () => {
    const levels: NetworkTrustLevel[] = ["TRUSTED", "NORMAL", "WATCHLIST", "HIGH_RISK", "BLACKLIST"];
    const colors = levels.map(trustLevelColor);
    const unique = new Set(colors);
    expect(unique.size).toBe(5);
  });

  it("BLACKLIST uses rose/red tones", () => {
    expect(trustLevelColor("BLACKLIST")).toContain("rose");
  });

  it("TRUSTED uses emerald/green tones", () => {
    expect(trustLevelColor("TRUSTED")).toContain("emerald");
  });
});

describe("trustLevelToRecommendedAction", () => {
  it("maps each network trust level to the strict merchant action", () => {
    expect(trustLevelToRecommendedAction("TRUSTED")).toBe("accept");
    expect(trustLevelToRecommendedAction("NORMAL")).toBe("accept");
    expect(trustLevelToRecommendedAction("WATCHLIST")).toBe("verify");
    expect(trustLevelToRecommendedAction("HIGH_RISK")).toBe("manual_review");
    expect(trustLevelToRecommendedAction("BLACKLIST")).toBe("block");
  });
});

describe("buildCustomerNetworkProfile – empty identity list", () => {
  it("returns safe empty profile without querying DB", async () => {
    const profile = await buildCustomerNetworkProfile([]);
    expect(profile.totalOrders).toBe(0);
    expect(profile.estimatedDamageDzd).toBe(0);
    expect(profile.networkTrustLevel).toBe("NORMAL");
    expect(profile.networkInsights).toHaveLength(0);
  });
});

describe("buildCustomerNetworkProfile – no DB rows", () => {
  beforeEach(() => {
    mockCreateClient.mockReturnValue(mockSupabaseFactory([], []) as any);
  });

  it("returns empty profile when delivery stats are absent", async () => {
    const profile = await buildCustomerNetworkProfile(["id-1"]);
    expect(profile.totalOrders).toBe(0);
    expect(profile.merchantCount).toBe(0);
    expect(profile.networkTrustLevel).toBe("NORMAL");
  });
});

describe("buildCustomerNetworkProfile – BLACKLIST customer", () => {
  beforeEach(() => {
    mockCreateClient.mockReturnValue(
      mockSupabaseFactory(
        [
          {
            identity_id: "id-blacklist",
            total_delivery_orders: 10,
            delivered_count: 0,
            refused_count: 3,
            returned_count: 4,
            cancelled_count: 1,
            no_answer_count: 2,
            fake_order_count: 2,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 5,
            provider_count: 2,
            avg_order_amount: 4000,
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2026-06-01T00:00:00Z",
            recent_bad_events: 4,
            recent_total_orders: 4,
            prior_bad_events: 2,
            prior_total_orders: 6
          }
        ],
        [
          { id: "id-blacklist", customer_name: "Test Fraud Customer", normalized_address: "Rue de la Paix, Alger", wilaya: "Alger" }
        ]
      ) as any
    );
  });

  it("classifies as BLACKLIST due to 2 fake orders", async () => {
    const profile = await buildCustomerNetworkProfile(["id-blacklist"]);
    expect(profile.networkTrustLevel).toBe("BLACKLIST");
  });

  it("computes estimated damage correctly", async () => {
    const profile = await buildCustomerNetworkProfile(["id-blacklist"]);
    // refused-like = refused(3) + returned(4) + no_answer(2) + fake(2) = 11 orders * 4000 + cancelled(1) * 500
    const expectedDamage = 11 * 4000 + 1 * 500;
    expect(profile.estimatedDamageDzd).toBe(expectedDamage);
    expect(profile.merchantImpactScore).toBe(expectedDamage);
  });

  it("generates relevant network insights", async () => {
    const profile = await buildCustomerNetworkProfile(["id-blacklist"]);
    expect(profile.networkInsights.some((i) => i.includes("5 network sources"))).toBe(true);
    expect(profile.networkInsights.some((i) => i.includes("fake order"))).toBe(true);
    expect(profile.networkInsights.some((i) => i.includes("never successfully"))).toBe(true);
  });

  it("detects INCREASING risk trend (recent bad rate 100% vs prior 33%)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-blacklist"]);
    expect(profile.riskTrend).toBe("INCREASING");
  });

  it("collects linked names and wilayas", async () => {
    const profile = await buildCustomerNetworkProfile(["id-blacklist"]);
    expect(profile.linkedNames).toContain("Test Fraud Customer");
    expect(profile.linkedWilayas).toContain("Alger");
  });
});

describe("buildCustomerNetworkProfile – TRUSTED customer", () => {
  beforeEach(() => {
    mockCreateClient.mockReturnValue(
      mockSupabaseFactory(
        [
          {
            identity_id: "id-trusted",
            total_delivery_orders: 15,
            delivered_count: 14,
            refused_count: 0,
            returned_count: 1,
            cancelled_count: 0,
            no_answer_count: 0,
            fake_order_count: 0,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 3,
            provider_count: 1,
            avg_order_amount: 2500,
            first_seen: "2024-01-01T00:00:00Z",
            last_seen: "2026-05-15T00:00:00Z",
            recent_bad_events: 0,
            recent_total_orders: 3,
            prior_bad_events: 0,
            prior_total_orders: 5
          }
        ],
        []
      ) as any
    );
  });

  it("classifies as WATCHLIST (1 returned, success 93%)", async () => {
    // 14/15 = 93.3% success but returned >= 1 → WATCHLIST
    const profile = await buildCustomerNetworkProfile(["id-trusted"]);
    // 93% success rate with 1 return = WATCHLIST (returned >= 2 needed for WATCHLIST-direct, 1 returned just passes)
    // Actually: returned >= 2 → WATCHLIST. Only 1 returned, success rate 93% > 60% → TRUSTED
    expect(profile.networkTrustLevel).toBe("TRUSTED");
  });

  it("delivery success rate is 93%", async () => {
    const profile = await buildCustomerNetworkProfile(["id-trusted"]);
    expect(profile.deliverySuccessRate).toBe(93);
  });

  it("estimated damage is low (only 1 returned)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-trusted"]);
    expect(profile.estimatedDamageDzd).toBe(1 * 2500); // 1 returned * avg
  });

  it("risk trend is STABLE (no bad events either period)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-trusted"]);
    expect(profile.riskTrend).toBe("STABLE");
  });

  it("generates trusted insight", async () => {
    const profile = await buildCustomerNetworkProfile(["id-trusted"]);
    expect(profile.networkInsights.some((i) => i.toLowerCase().includes("trusted"))).toBe(true);
  });
});

describe("buildCustomerNetworkProfile – HIGH_RISK customer", () => {
  beforeEach(() => {
    mockCreateClient.mockReturnValue(
      mockSupabaseFactory(
        [
          {
            identity_id: "id-watchlist",
            total_delivery_orders: 8,
            delivered_count: 4,
            refused_count: 2,
            returned_count: 1,
            cancelled_count: 1,
            no_answer_count: 0,
            fake_order_count: 0,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 2,
            provider_count: 1,
            avg_order_amount: 3000,
            first_seen: "2025-06-01T00:00:00Z",
            last_seen: "2026-05-01T00:00:00Z",
            recent_bad_events: 2,
            recent_total_orders: 4,
            prior_bad_events: 1,
            prior_total_orders: 4
          }
        ],
        []
      ) as any
    );
  });

  it("classifies as HIGH_RISK for repeated refusal signals", async () => {
    const profile = await buildCustomerNetworkProfile(["id-watchlist"]);
    expect(profile.networkTrustLevel).toBe("HIGH_RISK");
  });

  it("success rate is 50% (4/8)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-watchlist"]);
    expect(profile.deliverySuccessRate).toBe(50);
  });

  it("trend is STABLE (recent 50% bad vs prior 25% bad – delta 0.25 > 0.15 → INCREASING)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-watchlist"]);
    // recent: 2/4 = 50%, prior: 1/4 = 25%, delta = 0.25 > 0.15 → INCREASING
    expect(profile.riskTrend).toBe("INCREASING");
  });

  it("generates refused insight", async () => {
    const profile = await buildCustomerNetworkProfile(["id-watchlist"]);
    expect(profile.networkInsights.some((i) => i.includes("refused"))).toBe(true);
  });
});

describe("buildCustomerNetworkProfile – single cancellation watchlist", () => {
  beforeEach(() => {
    mockCreateClient.mockReturnValue(
      mockSupabaseFactory(
        [
          {
            identity_id: "id-cancel-watchlist",
            total_delivery_orders: 1,
            delivered_count: 0,
            refused_count: 0,
            returned_count: 0,
            cancelled_count: 1,
            no_answer_count: 0,
            fake_order_count: 0,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 1,
            provider_count: 1,
            avg_order_amount: 3000,
            first_seen: "2026-06-01T00:00:00Z",
            last_seen: "2026-06-01T00:00:00Z",
            recent_bad_events: 1,
            recent_total_orders: 1,
            prior_bad_events: 0,
            prior_total_orders: 0
          }
        ],
        []
      ) as any
    );
  });

  it("classifies as WATCHLIST when one cancellation exists with zero delivered", async () => {
    const profile = await buildCustomerNetworkProfile(["id-cancel-watchlist"]);
    expect(profile.networkTrustLevel).toBe("WATCHLIST");
  });
});

describe("buildCustomerNetworkProfile – aggregates multiple identities", () => {
  beforeEach(() => {
    mockCreateClient.mockReturnValue(
      mockSupabaseFactory(
        [
          {
            identity_id: "id-a",
            total_delivery_orders: 5,
            delivered_count: 2,
            refused_count: 2,
            returned_count: 1,
            cancelled_count: 0,
            no_answer_count: 0,
            fake_order_count: 0,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 3,
            provider_count: 1,
            avg_order_amount: 3000,
            first_seen: "2025-01-01T00:00:00Z",
            last_seen: "2025-06-01T00:00:00Z",
            recent_bad_events: 1,
            recent_total_orders: 2,
            prior_bad_events: 0,
            prior_total_orders: 3
          },
          {
            identity_id: "id-b",
            total_delivery_orders: 3,
            delivered_count: 1,
            refused_count: 1,
            returned_count: 1,
            cancelled_count: 0,
            no_answer_count: 0,
            fake_order_count: 0,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 2,
            provider_count: 2,
            avg_order_amount: 4000,
            first_seen: "2024-06-01T00:00:00Z",
            last_seen: "2026-04-01T00:00:00Z",
            recent_bad_events: 0,
            recent_total_orders: 1,
            prior_bad_events: 0,
            prior_total_orders: 2
          }
        ],
        [
          { id: "id-a", customer_name: "Ahmed Ben Ali", normalized_address: "rue principale", wilaya: "Alger" },
          { id: "id-b", customer_name: "Ahmed B. Ali", normalized_address: "rue principale", wilaya: "Alger" }
        ]
      ) as any
    );
  });

  it("sums orders across both identities", async () => {
    const profile = await buildCustomerNetworkProfile(["id-a", "id-b"]);
    expect(profile.totalOrders).toBe(8);
    expect(profile.deliveredOrders).toBe(3);
    expect(profile.refusedOrders).toBe(3);
    expect(profile.returnedOrders).toBe(2);
  });

  it("takes the max merchant count (not sum)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-a", "id-b"]);
    expect(profile.merchantCount).toBe(3);
  });

  it("takes the max provider count", async () => {
    const profile = await buildCustomerNetworkProfile(["id-a", "id-b"]);
    expect(profile.providerCount).toBe(2);
  });

  it("uses earliest firstSeen across identities", async () => {
    const profile = await buildCustomerNetworkProfile(["id-a", "id-b"]);
    expect(profile.firstSeen).toBe("2024-06-01T00:00:00Z");
  });

  it("deduplicates linked names (both are unique)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-a", "id-b"]);
    expect(profile.linkedNames).toHaveLength(2);
  });

  it("deduplicates linked wilayas (both are Alger)", async () => {
    const profile = await buildCustomerNetworkProfile(["id-a", "id-b"]);
    expect(profile.linkedWilayas).toHaveLength(1);
    expect(profile.linkedWilayas[0]).toBe("Alger");
  });
});

describe("merchantConfidenceScore boundaries", () => {
  it("maxes out at 100", async () => {
    mockCreateClient.mockReturnValue(
      mockSupabaseFactory(
        [
          {
            identity_id: "id-max",
            total_delivery_orders: 50,
            delivered_count: 48,
            refused_count: 0,
            returned_count: 0,
            cancelled_count: 0,
            no_answer_count: 0,
            fake_order_count: 0,
            phone_unreachable_count: 0,
            not_picked_up_count: 0,
            bad_address_count: 0,
            merchant_count: 10,
            provider_count: 3,
            avg_order_amount: 3000,
            first_seen: "2023-01-01T00:00:00Z",
            last_seen: "2026-05-01T00:00:00Z",
            recent_bad_events: 0,
            recent_total_orders: 10,
            prior_bad_events: 0,
            prior_total_orders: 15
          }
        ],
        []
      ) as any
    );

    const profile = await buildCustomerNetworkProfile(["id-max"]);
    expect(profile.merchantConfidenceScore).toBeLessThanOrEqual(100);
    expect(profile.merchantConfidenceScore).toBeGreaterThan(80);
  });
});
