import { evaluateUnifiedRisk } from "@/lib/risk/unified-evaluator";

export type OrderDecisionInput = {
  merchantId: string;
  phone: string;
  customerName?: string;
  address?: string;
  wilaya?: string;
  commune?: string;
};

export type OrderDecisionLevel = "SAFE_TO_SHIP" | "SHIP_WITH_CAUTION" | "HIGH_RISK";

export type OrderDecisionResponse = {
  decision: OrderDecisionLevel;
  trustScore: number;
  customerType: string;
  successRate: number;
  merchantCount: number;
  riskFactors: string[];
  recommendation: "PROCEED_WITH_STANDARD_SHIPPING" | "VERIFY_BY_PHONE_BEFORE_SHIPPING" | "DO_NOT_SHIP_HIGH_VALUE_PRODUCTS";
  extensions: {
    estimatedLoss: null;
    fraudProbability: null;
    networkReputationScore: number | null;
    aiRecommendation: null;
  };
  score: number;
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK";
  reasons: string[];
  recommendedAction: "accept" | "verify" | "manual_review" | "block";
  globalReputation: {
    score: number;
    totalOrders: number;
    deliveredOrders: number;
    returnedOrders: number;
    refusedOrders: number;
    merchantCount: number;
    recommendation: "APPROVE" | "REVIEW" | "BLOCK";
    level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    reasons: string[];
  } | null;
  identityFingerprint: {
    confidence: "HIGH" | "MEDIUM" | "LOW";
    confidenceScore: number;
    linkedIdentityCount: number;
    phoneIdentityCount: number;
    reasons: string[];
  };
  fraudCluster: {
    score: number;
    summary: string;
    reasons: string[];
    addressLinkedRefusedCustomers: number;
    phoneIdentityCount: number;
  };
};

function mapDecision(level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK"): OrderDecisionLevel {
  if (level === "LOW") return "SAFE_TO_SHIP";
  if (level === "MEDIUM") return "SHIP_WITH_CAUTION";
  return "HIGH_RISK";
}

function recommendationFromAction(action: "accept" | "verify" | "manual_review" | "block"): OrderDecisionResponse["recommendation"] {
  if (action === "block") return "DO_NOT_SHIP_HIGH_VALUE_PRODUCTS";
  if (action === "accept") return "PROCEED_WITH_STANDARD_SHIPPING";
  return "VERIFY_BY_PHONE_BEFORE_SHIPPING";
}

function customerTypeFromLevel(level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK"): string {
  if (level === "LOW") return "Reliable Customer";
  if (level === "MEDIUM") return "Needs Verification";
  if (level === "HIGH") return "High Risk";
  return "Critical Risk";
}

export async function evaluateOrderDecision(input: OrderDecisionInput): Promise<OrderDecisionResponse> {
  const unified = await evaluateUnifiedRisk({
    merchantId: input.merchantId,
    phone: input.phone,
    customerName: input.customerName,
    address: input.address,
    wilaya: input.wilaya,
    commune: input.commune,
    cartTotal: 1,
    totalAmount: 1,
    productCount: 1,
    isCod: false
  });

  const globalReputation = unified.globalReputation;
  const successRate = globalReputation && globalReputation.totalOrders > 0
    ? Math.round((globalReputation.deliveredOrders / globalReputation.totalOrders) * 100)
    : 0;

  const level = unified.risk.level;
  const decision = mapDecision(level);
  const recommendation = recommendationFromAction(unified.risk.action);
  const trustScore = Math.max(0, 100 - unified.risk.score);
  const merchantCount = globalReputation?.merchantCount ?? 0;
  const riskFactors = unified.risk.reasons;

  return {
    decision,
    trustScore,
    customerType: customerTypeFromLevel(level),
    successRate,
    merchantCount,
    riskFactors,
    recommendation,
    extensions: {
      estimatedLoss: null,
      fraudProbability: null,
      networkReputationScore: unified.networkIntelligence.score,
      aiRecommendation: null
    },
    score: unified.risk.score,
    level,
    reasons: unified.risk.reasons,
    recommendedAction: unified.risk.action,
    globalReputation: globalReputation
      ? {
          score: globalReputation.reputationScore,
          totalOrders: globalReputation.totalOrders,
          deliveredOrders: globalReputation.deliveredOrders,
          returnedOrders: globalReputation.returnedOrders,
          refusedOrders: globalReputation.refusedOrders,
          merchantCount: globalReputation.merchantCount,
          recommendation: unified.networkIntelligence.recommendation,
          level: unified.networkIntelligence.level,
          reasons: unified.networkIntelligence.reasons
        }
      : null,
    identityFingerprint: {
      confidence: unified.identityInsights.confidence,
      confidenceScore: unified.identityInsights.confidenceScore,
      linkedIdentityCount: unified.identityInsights.linkedIdentityCount,
      phoneIdentityCount: unified.identityInsights.phoneIdentityCount,
      reasons: unified.identityInsights.reasons
    },
    fraudCluster: {
      score: unified.clusterInsights.score,
      summary: unified.clusterInsights.summary,
      reasons: unified.clusterInsights.reasons,
      addressLinkedRefusedCustomers: unified.clusterInsights.addressLinkedRefusedCustomers,
      phoneIdentityCount: unified.clusterInsights.phoneIdentityCount
    }
  };
}
