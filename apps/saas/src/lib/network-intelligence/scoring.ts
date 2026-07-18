export type NetworkRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type NetworkRecommendation = "APPROVE" | "REVIEW" | "BLOCK";

export type NetworkSnapshot = {
  totalOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  refusedOrders: number;
  cancelledOrders: number;
  merchantCount: number;
  suspiciousIdentityChanges?: boolean;
  addressLinkedRefusedCustomers?: number;
  phoneIdentityCount?: number;
};

type ScoreContribution = {
  label: string;
  impact: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentage(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (part / total) * 100;
}

export function buildNetworkRecommendation(snapshot: NetworkSnapshot): {
  score: number;
  level: NetworkRiskLevel;
  recommendation: NetworkRecommendation;
  reasons: string[];
  contributions: ScoreContribution[];
  metrics: {
    deliveryRate: number;
    cancellationRate: number;
    refusedRate: number;
    returnedRate: number;
  };
} {
  const contributions: ScoreContribution[] = [];

  const total = Math.max(snapshot.totalOrders, 0);
  const delivered = Math.max(snapshot.deliveredOrders, 0);
  const returned = Math.max(snapshot.returnedOrders, 0);
  const refused = Math.max(snapshot.refusedOrders, 0);
  const cancelled = Math.max(snapshot.cancelledOrders, 0);
  const merchantCount = Math.max(snapshot.merchantCount, 0);
  const addressLinkedRefusedCustomers = Math.max(snapshot.addressLinkedRefusedCustomers ?? 0, 0);
  const phoneIdentityCount = Math.max(snapshot.phoneIdentityCount ?? 1, 1);

  const refusedRate = percentage(refused, total);
  const returnedRate = percentage(returned, total);
  const cancellationRate = percentage(cancelled, total);
  const deliveryRate = percentage(delivered, total);

  let riskScore = 0;

  if (delivered > 0) {
    const impact = -Math.min(20, delivered * 5);
    riskScore += impact;
    contributions.push({ label: `${delivered} delivered order${delivered > 1 ? "s" : ""}`, impact });
  }

  if (deliveryRate > 90) {
    riskScore -= 15;
    contributions.push({ label: "Delivery rate above 90%", impact: -15 });
  } else if (deliveryRate > 80) {
    riskScore -= 10;
    contributions.push({ label: "Delivery rate above 80%", impact: -10 });
  }

  if (refused >= 1) {
    riskScore += 40;
    contributions.push({ label: "First refused order", impact: 40 });
  }
  if (refused > 1) {
    const impact = (refused - 1) * 25;
    riskScore += impact;
    contributions.push({ label: `${refused - 1} additional refused order${refused - 1 > 1 ? "s" : ""}`, impact });
  }

  if (returned >= 1) {
    riskScore += 30;
    contributions.push({ label: "First returned order", impact: 30 });
  }
  if (returned > 1) {
    const impact = (returned - 1) * 20;
    riskScore += impact;
    contributions.push({ label: `${returned - 1} additional returned order${returned - 1 > 1 ? "s" : ""}`, impact });
  }

  if (cancelled > 0) {
    riskScore += 10;
    contributions.push({ label: "Cancellation before shipping pattern", impact: 10 });
  }

  if (merchantCount >= 3 && (refused + returned + cancelled) >= 2) {
    riskScore += 15;
    contributions.push({ label: `Multiple merchants reporting delivery problems (${merchantCount})`, impact: 15 });
  }

  if (snapshot.suspiciousIdentityChanges) {
    riskScore += 20;
    contributions.push({ label: "Suspicious identity changes", impact: 20 });
  }

  if (addressLinkedRefusedCustomers >= 2) {
    riskScore += 20;
    contributions.push({ label: "Address linked to multiple refused customers", impact: 20 });
  }

  if (phoneIdentityCount >= 3) {
    riskScore += 15;
    contributions.push({ label: "Same phone used by multiple identities", impact: 15 });
  }

  const score = clamp(Math.round(riskScore), 0, 100);

  let level: NetworkRiskLevel;
  if (score <= 24) {
    level = "LOW";
  } else if (score <= 49) {
    level = "MEDIUM";
  } else if (score <= 74) {
    level = "HIGH";
  } else {
    level = "CRITICAL";
  }

  const recommendation: NetworkRecommendation =
    level === "LOW" ? "APPROVE" : level === "MEDIUM" ? "REVIEW" : level === "HIGH" ? "REVIEW" : "BLOCK";

  const reasons = contributions
    .filter((item) => item.impact !== 0)
    .sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact))
    .map((item) => `${item.impact >= 0 ? "+" : ""}${item.impact} ${item.label}`);

  return {
    score,
    level,
    recommendation,
    reasons,
    contributions,
    metrics: {
      deliveryRate: Math.round(deliveryRate),
      cancellationRate: Math.round(cancellationRate),
      refusedRate: Math.round(refusedRate),
      returnedRate: Math.round(returnedRate)
    }
  };
}
