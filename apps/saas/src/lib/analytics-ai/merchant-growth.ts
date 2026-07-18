// Merchant growth trend classification.
//
// Classifies each merchant by growth direction using orderGrowthRate and
// revenueGrowthRate (both computed as 30-day vs prior-30-day fractions).

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { ForecastDirection, TrendSignal } from "./types";

let _id = 0;
function nextId(): string { return `mg-${++_id}`; }
export function resetMerchantGrowthIds(): void { _id = 0; }

function classifyDirection(rate: number): ForecastDirection {
  if (rate > 0.5) return "exploding";
  if (rate > 0.15) return "growing";
  if (rate < -0.5) return "collapsing";
  if (rate < -0.15) return "declining";
  return "stable";
}

function growthDescription(m: MerchantIntelSummary, direction: ForecastDirection): string {
  const orderPct = (m.orderGrowthRate * 100).toFixed(1);
  const revPct = (m.revenueGrowthRate * 100).toFixed(1);
  const sign = m.orderGrowthRate >= 0 ? "+" : "";

  switch (direction) {
    case "exploding":
      return `${m.name} is exploding — orders ${sign}${orderPct}% MoM, revenue ${sign}${revPct}% MoM. Exceptional growth signal.`;
    case "growing":
      return `${m.name} is growing steadily — orders ${sign}${orderPct}% MoM. Delivery rate ${(m.deliverySuccessRate * 100).toFixed(1)}%.`;
    case "declining":
      return `${m.name} orders down ${orderPct}% MoM. Revenue growth ${revPct}%. May need attention if trend persists.`;
    case "collapsing":
      return `${m.name} is collapsing — orders ${orderPct}% MoM, revenue ${revPct}% MoM. Immediate investigation required.`;
    default:
      return `${m.name} is stable — orders ${sign}${orderPct}% MoM.`;
  }
}

function estimateImpact(m: MerchantIntelSummary): number {
  if (m.grossRevenueDzd === 0) return 0;
  return Math.round(Math.abs(m.revenueGrowthRate) * m.grossRevenueDzd);
}

function confidence(m: MerchantIntelSummary): number {
  const sampleScore = Math.min(50, (m.totalOrders / 100) * 50);
  const signalScore = Math.min(40, Math.abs(m.orderGrowthRate) * 100);
  return Math.round(Math.max(5, Math.min(90, sampleScore + signalScore)));
}

// ── Main export ───────────────────────────────────────────────────────────────

export function buildMerchantGrowthTrends(
  summaries: MerchantIntelSummary[],
): TrendSignal[] {
  const signals: TrendSignal[] = [];

  for (const m of summaries) {
    if (m.totalOrders < 5) continue;

    // Use combined order and revenue growth; weight order growth more
    const combinedRate = m.orderGrowthRate * 0.6 + m.revenueGrowthRate * 0.4;
    const dir = classifyDirection(combinedRate);

    signals.push({
      id: nextId(),
      entity: m.name,
      entityType: "merchant",
      direction: dir,
      magnitude: Number(combinedRate.toFixed(4)),
      confidence: confidence(m),
      description: growthDescription(m, dir),
      estimatedRevenueImpactDzd: estimateImpact(m),
      merchantId: m.merchantId,
    });
  }

  // Sort: collapsing first, then exploding, then growing, stable, declining
  const order: Record<ForecastDirection, number> = {
    collapsing: 0,
    exploding: 1,
    growing: 2,
    declining: 3,
    stable: 4,
  };

  return signals.sort((a, b) => order[a.direction] - order[b.direction]);
}
