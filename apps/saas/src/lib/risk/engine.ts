import type { OrderCheckInput, RiskLevel, RiskResult } from "@/types/risk";

const SUSPICIOUS_NAMES = ["test", "fake", "aaaa", "xxxx", "no name", "client", "unknown"];

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function levelFromScore(score: number): RiskLevel {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

export interface ReputationContext {
  merchantDelivered: number;
  merchantFailed: number;
  merchantCancelled: number;
  merchantReturned: number;
  globalBadReports: number;
  globalGoodReports: number;
  recentIpOrders: number;
  recentDeviceOrders: number;
  repeatedOrdersByPhoneInWindow: number;
  networkTotalOrders?: number;
  networkDeliveredOrders?: number;
  networkReturnedOrders?: number;
  networkRefusedOrders?: number;
  networkCancelledOrders?: number;
  networkMerchantCount?: number;
  networkReputationScore?: number;
  networkReasons?: string[];
  identityConfidence?: "HIGH" | "MEDIUM" | "LOW";
  clusterRiskScore?: number;
  clusterReasons?: string[];
  suspiciousIdentityChanges?: boolean;
}

type ExplainContribution = {
  source: "LOCAL" | "NETWORK" | "IDENTITY" | "CLUSTER";
  label: string;
  impact: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeLocalRisk(input: OrderCheckInput, ctx: ReputationContext): { score: number; reasons: ExplainContribution[] } {
  const reasons: ExplainContribution[] = [];
  let score = 0;

  if (!input.phoneHash) {
    score += 25;
    reasons.push({ source: "LOCAL", label: "Missing trusted phone hash", impact: 25 });
  }

  if (!input.address || input.address.length < 6) {
    score += 15;
    reasons.push({ source: "LOCAL", label: "Address quality is low", impact: 15 });
  }

  const lowerName = (input.customerName || "").toLowerCase();
  if (SUSPICIOUS_NAMES.some((name) => lowerName.includes(name))) {
    score += 15;
    reasons.push({ source: "LOCAL", label: "Suspicious customer name pattern", impact: 15 });
  }

  if (input.isCod) {
    score += 8;
    reasons.push({ source: "LOCAL", label: "Cash on delivery requires stricter controls", impact: 8 });
  }

  if (ctx.recentIpOrders >= 3) {
    score += 15;
    reasons.push({ source: "LOCAL", label: "Burst orders from same IP", impact: 15 });
  }

  if (ctx.recentDeviceOrders >= 3) {
    score += 12;
    reasons.push({ source: "LOCAL", label: "Burst orders from same device", impact: 12 });
  }

  if (ctx.repeatedOrdersByPhoneInWindow >= 2) {
    score += 10;
    reasons.push({ source: "LOCAL", label: "Repeated orders from same phone", impact: 10 });
  }

  const localNegativeHistory = Math.min(35, ctx.merchantFailed * 6 + ctx.merchantCancelled * 3 + ctx.merchantReturned * 5);
  if (localNegativeHistory > 0) {
    score += localNegativeHistory;
    reasons.push({ source: "LOCAL", label: "Negative merchant history", impact: localNegativeHistory });
  }

  if (!input.customerName) {
    score += 8;
    reasons.push({ source: "LOCAL", label: "Customer name missing", impact: 8 });
  }

  if (input.cartTotal <= 0) {
    score += 20;
    reasons.push({ source: "LOCAL", label: "Invalid order amount", impact: 20 });
  }

  if (input.productCount <= 0) {
    score += 14;
    reasons.push({ source: "LOCAL", label: "Invalid product count", impact: 14 });
  }

  const trustBoost = Math.min(20, ctx.merchantDelivered * 3 + ctx.globalGoodReports * 2);
  if (trustBoost > 0) {
    score -= trustBoost;
    reasons.push({ source: "LOCAL", label: "Positive merchant and phone trust history", impact: -trustBoost });
  }

  if (ctx.globalBadReports > 0) {
    const impact = Math.min(20, ctx.globalBadReports * 5);
    score += impact;
    reasons.push({ source: "LOCAL", label: "Global phone bad reports", impact });
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons
  };
}

export function calculateRisk(input: OrderCheckInput, ctx: ReputationContext): RiskResult {
  const local = computeLocalRisk(input, ctx);
  const networkRiskScore = clamp(Math.round(ctx.networkReputationScore ?? 50), 0, 100);

  const networkReasons: ExplainContribution[] = (ctx.networkReasons ?? []).map((reason) => ({
    source: "NETWORK",
    label: reason,
    impact: 0
  }));

  const identityContributions: ExplainContribution[] = [];
  let identityAdjustment = 0;
  if (ctx.identityConfidence === "LOW") {
    identityAdjustment += 20;
    identityContributions.push({ source: "IDENTITY", label: "Low identity confidence", impact: 20 });
  } else if (ctx.identityConfidence === "MEDIUM") {
    identityAdjustment += 8;
    identityContributions.push({ source: "IDENTITY", label: "Medium identity confidence", impact: 8 });
  } else if (ctx.identityConfidence === "HIGH") {
    identityAdjustment -= 5;
    identityContributions.push({ source: "IDENTITY", label: "High identity confidence", impact: -5 });
  }

  if (ctx.suspiciousIdentityChanges) {
    identityAdjustment += 12;
    identityContributions.push({ source: "IDENTITY", label: "Suspicious identity changes detected", impact: 12 });
  }

  const clusterRiskScore = clamp(Math.round(ctx.clusterRiskScore ?? 0), 0, 100);
  const clusterAdjustment = Math.round(clusterRiskScore * 0.25);
  const clusterContributions: ExplainContribution[] = (ctx.clusterReasons ?? []).map((reason, index) => ({
    source: "CLUSTER",
    label: reason,
    impact: index === 0 ? clusterAdjustment : 0
  }));

  const networkWeight = (ctx.networkTotalOrders ?? 0) > 0 ? 0.7 : 0.45;
  const localWeight = 1 - networkWeight;
  const weightedScore = local.score * localWeight + networkRiskScore * networkWeight;

  const finalScore = clampScore(weightedScore + identityAdjustment + clusterAdjustment);
  const level = levelFromScore(finalScore);

  const allContributions = [
    ...networkReasons,
    ...identityContributions,
    ...clusterContributions,
    ...local.reasons
  ];

  const reasons = allContributions
    .filter((item) => item.label)
    .sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact))
    .slice(0, 10)
    .map((item) => {
      if (item.impact === 0) {
        return item.label;
      }
      return `${item.impact >= 0 ? "+" : ""}${item.impact} ${item.label}`;
    });

  return {
    score: finalScore,
    level,
    reasons,
    action:
      level === "LOW"
        ? "accept"
        : level === "MEDIUM"
          ? "verify"
          : level === "HIGH"
            ? "manual_review"
            : "block"
    ,
    breakdown: {
      localRiskScore: local.score,
      networkRiskScore,
      finalRiskScore: finalScore,
      identityConfidence: ctx.identityConfidence,
      clusterRiskScore,
      explanations: allContributions
    }
  };
}
