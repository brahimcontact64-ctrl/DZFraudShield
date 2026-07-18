import { beforeEach, describe, expect, it, vi } from "vitest";

let rpcMode: "success" | "fail" = "success";
let snapshotReputationScore = 50;
let snapshotIdentityId: string | null = "identity-1";
let mockedNetworkScore = 50;

const fallbackRiskContext = {
  merchantDelivered: 3,
  merchantFailed: 2,
  merchantCancelled: 0,
  merchantReturned: 1,
  globalBadReports: 2,
  globalGoodReports: 6,
  recentIpOrders: 1,
  recentDeviceOrders: 1,
  repeatedOrdersByPhoneInWindow: 1,
  networkTotalOrders: 12,
  networkDeliveredOrders: 8,
  networkReturnedOrders: 2,
  networkRefusedOrders: 2,
  networkMerchantCount: 3,
  networkReputationScore: 50,
};

const fallbackGlobalReputation = {
  totalOrders: 12,
  deliveredOrders: 8,
  returnedOrders: 2,
  refusedOrders: 2,
  cancelledOrders: 0,
  merchantCount: 3,
  providerCount: 1,
  firstSeen: null,
  lastSeen: null,
  reputationScore: 50,
  riskLevel: "MEDIUM" as const,
};

const buildSnapshotPayload = () => ({
  identity: {
    identity_id: snapshotIdentityId,
    phone_hash: "phone-hash-1",
    email_hash: null,
    address_hash: "addr-hash-1",
  },
  customer_reputation: {
    total_orders: 12,
    delivered_orders: 8,
    refused_orders: 2,
    returned_orders: 2,
    no_answer_orders: 0,
    cancelled_orders: 0,
    merchant_count: 3,
    provider_count: 1,
    last_seen_at: null,
    risk_level: "MEDIUM",
    trust_level: "NORMAL",
    reputation_score: snapshotReputationScore,
  },
  merchant_history: {
    total_orders_with_merchant: 5,
    delivered_with_merchant: 3,
    refused_with_merchant: 2,
    returned_with_merchant: 1,
    last_order_at: null,
  },
  network_history: {
    seen_by_merchants: 3,
    total_network_orders: 12,
    delivered_network_orders: 8,
    refused_network_orders: 2,
    returned_network_orders: 2,
    return_rate: 16.67,
    refusal_rate: 16.67,
  },
  recent_risk_events: {
    count_7d: 1,
    count_30d: 2,
    last_event_at: null,
    latest_reasons: ["history"],
  },
  meta: {
    generated_at: new Date().toISOString(),
    source: "risk_context_snapshot_rpc",
    recent_ip_orders: 1,
    recent_device_orders: 1,
    repeated_orders_by_phone_in_window: 1,
  },
});

const fromMock = vi.fn((table: string) => {
  if (table === "customer_identity") {
    return {
      select: () => {
        const chain: any = {
          eq: () => chain,
          limit: async () => ({ data: [], error: null }),
        };
        return chain;
      },
    };
  }

  if (table === "customer_reputation") {
    return {
      select: () => ({
        in: async () => ({ data: [], error: null }),
      }),
    };
  }

  return {
    select: () => ({
      eq: () => ({ limit: async () => ({ data: [], error: null }) }),
    }),
  };
});

const rpcMock = vi.fn(async () => {
  if (rpcMode === "fail") {
    return { data: null, error: { message: "rpc failed" } };
  }
  return { data: buildSnapshotPayload(), error: null };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    rpc: rpcMock,
    from: fromMock,
  })),
}));

vi.mock("@/lib/api/context", () => ({
  getRiskContext: vi.fn(async () => fallbackRiskContext),
}));

vi.mock("@/lib/delivery-intelligence/reputation", () => ({
  getGlobalReputationSnapshot: vi.fn(async () => fallbackGlobalReputation),
  upsertCustomerIdentityFromDeliveryOrder: vi.fn(async () => ({
    identityId: "identity-1",
    phoneHash: "phone-hash-1",
    fingerprintHash: "fp-hash",
    fingerprintId: "fp-id",
    identityCreated: false,
    fingerprintCreated: false,
    linkCreated: false,
    mergeReason: "none",
    confidenceLevel: "HIGH",
    confidenceScore: 95,
  })),
}));

vi.mock("@/lib/network-intelligence/identity", () => ({
  buildIdentityInsights: vi.fn(() => ({
    confidence: "HIGH",
    confidenceScore: 95,
    reasons: [],
    suspiciousIdentityChanges: false,
    phoneIdentityCount: 1,
  })),
  buildClusterInsights: vi.fn(() => ({
    score: 0,
    summary: "LOW_CLUSTER_RISK",
    reasons: [],
    addressLinkedRefusedCustomers: 0,
    phoneIdentityCount: 1,
    multiMerchantIncidents: 0,
  })),
}));

vi.mock("@/lib/network-intelligence/customer-profile", () => ({
  buildCustomerNetworkProfile: vi.fn(async () => ({
    totalOrders: 12,
    deliveredOrders: 8,
    refusedOrders: 2,
    returnedOrders: 2,
    cancelledOrders: 0,
    noAnswerOrders: 0,
    fakeOrderCount: 0,
    merchantCount: 3,
    providerCount: 1,
    estimatedDamageDzd: 0,
    merchantImpactScore: 0,
    deliverySuccessRate: 66.67,
    riskTrend: "STABLE",
    networkTrustLevel: "NORMAL",
    networkInsights: [],
    linkedNames: [],
    linkedAddresses: [],
    linkedWilayas: [],
    recentBadEvents: 0,
  })),
  trustLevelToRecommendedAction: vi.fn(() => "accept"),
}));

vi.mock("@/lib/network-intelligence/scoring", () => ({
  buildNetworkRecommendation: vi.fn(({ returnedOrders, refusedOrders, merchantCount }) => ({
    score: mockedNetworkScore,
    level: refusedOrders + returnedOrders >= 4 ? "CRITICAL" : "MEDIUM",
    recommendation: refusedOrders + returnedOrders >= 4 ? "BLOCK" : "REVIEW",
    reasons: merchantCount >= 2 ? ["multi-merchant"] : ["single-merchant"],
  })),
}));

vi.mock("@/lib/risk/engine", () => ({
  calculateRisk: vi.fn((_input, ctx) => {
    const score = Math.max(0, Math.min(100, 100 - Math.round(Number(ctx.networkReputationScore ?? 50))));
    const action = score >= 75 ? "block" : score >= 50 ? "manual_review" : score >= 25 ? "verify" : "accept";
    const level = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
    return {
      score,
      level,
      reasons: ["mocked-score"],
      action,
      breakdown: {
        localRiskScore: score,
        networkRiskScore: score,
        finalRiskScore: score,
        identityConfidence: "HIGH",
        clusterRiskScore: 0,
        explanations: [],
      },
    };
  }),
}));

import { getRiskContext } from "@/lib/api/context";
import { getGlobalReputationSnapshot, upsertCustomerIdentityFromDeliveryOrder } from "@/lib/delivery-intelligence/reputation";
import { evaluateUnifiedRisk } from "@/lib/risk/unified-evaluator";

describe("risk RPC snapshot equivalence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMode = "success";
    snapshotReputationScore = 50;
    snapshotIdentityId = "identity-1";
    mockedNetworkScore = 50;
    process.env.PHONE_HASH_SECRET = "test-phone-secret";
  });

  const baseInput = {
    merchantId: "merchant-1",
    orderId: "order-1",
    customerPhone: "0555123456",
    customerName: "Ahmed",
    customerAddress: "Rue 1, Alger",
    wilaya: "Alger",
    city: "Alger",
    ip: "1.1.1.1",
    userAgent: "vitest",
    totalAmount: 2500,
    cartTotal: 2500,
    productCount: 1,
    paymentMethod: "cod",
    isCod: true,
    productNames: ["A"],
    productItems: [{ productName: "A", quantity: 1, itemTotal: 2500 }],
  };

  it("RPC path and fallback path produce same score and recommendation", async () => {
    snapshotReputationScore = 50;
    const rpcResult = await evaluateUnifiedRisk(baseInput);

    rpcMode = "fail";
    const fallbackResult = await evaluateUnifiedRisk(baseInput);

    expect(rpcResult.risk.score).toBe(fallbackResult.risk.score);
    expect(rpcResult.risk.action).toBe(fallbackResult.risk.action);
    expect(rpcResult.diagnostics.fallbackUsed).toBe(false);
    expect(fallbackResult.diagnostics.fallbackUsed).toBe(true);
  });

  it("unknown customer still works", async () => {
    snapshotIdentityId = null;
    snapshotReputationScore = 50;
    const result = await evaluateUnifiedRisk(baseInput);

    expect(typeof result.risk.score).toBe("number");
    expect(result.identityId).toBeNull();
  });

  it("known risky customer still works", async () => {
    snapshotReputationScore = 10;
    mockedNetworkScore = 5;
    const result = await evaluateUnifiedRisk(baseInput);

    expect(result.risk.action).toBe("block");
    expect(result.risk.score).toBeGreaterThanOrEqual(75);
  });

  it("known trusted customer still works", async () => {
    snapshotReputationScore = 95;
    mockedNetworkScore = 95;
    const result = await evaluateUnifiedRisk(baseInput);

    expect(result.risk.action).toBe("accept");
    expect(result.risk.score).toBeLessThan(25);
  });

  it("RPC failure falls back safely", async () => {
    rpcMode = "fail";
    const result = await evaluateUnifiedRisk(baseInput);

    expect(result.diagnostics.fallbackUsed).toBe(true);
    expect(vi.mocked(getRiskContext)).toHaveBeenCalled();
    expect(vi.mocked(getGlobalReputationSnapshot)).toHaveBeenCalled();
    expect(vi.mocked(upsertCustomerIdentityFromDeliveryOrder)).toHaveBeenCalled();
  });
});
