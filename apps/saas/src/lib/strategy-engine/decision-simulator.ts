// Decision Simulator — "What if?" pure-math engine.
//
// Accepts a pre-loaded merchant snapshot and computes before/after metrics
// for a given scenario. No DB calls — all inputs come from the caller.
// Designed to run client-side (pure TypeScript, no I/O).

import type {
  DecisionSimulationResult,
  SimulationMetrics,
  SimulationScenario,
  SimulatorMerchantData,
  SimulatorProviderData,
  SimulatorWilayaData,
} from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function delta(before: SimulationMetrics, after: SimulationMetrics): SimulationMetrics {
  return {
    deliverySuccessRate: after.deliverySuccessRate - before.deliverySuccessRate,
    returnRate: after.returnRate - before.returnRate,
    codRefusalRate: after.codRefusalRate - before.codRefusalRate,
    estimatedMonthlyOrdersDzd: after.estimatedMonthlyOrdersDzd - before.estimatedMonthlyOrdersDzd,
    estimatedMonthlyCollectedDzd: after.estimatedMonthlyCollectedDzd - before.estimatedMonthlyCollectedDzd,
    blockRate: after.blockRate - before.blockRate,
  };
}

function monthlyRevenue(merchant: SimulatorMerchantData, deliveryRate: number): number {
  const monthlyOrders = merchant.totalOrders / 3;
  return Math.round(monthlyOrders * merchant.avgBasketDzd);
}

function monthlyCollected(merchant: SimulatorMerchantData, deliveryRate: number, codRate: number): number {
  const monthlyOrders = merchant.totalOrders / 3;
  return Math.round(monthlyOrders * deliveryRate * codRate * merchant.avgBasketDzd);
}

function buildBefore(merchant: SimulatorMerchantData): SimulationMetrics {
  const returnRate = clamp(1 - merchant.deliverySuccessRate - merchant.blockRate, 0, 1);
  const codRefusalRate = clamp(1 - merchant.codSuccessRate, 0, 1);
  return {
    deliverySuccessRate: merchant.deliverySuccessRate,
    returnRate,
    codRefusalRate,
    estimatedMonthlyOrdersDzd: monthlyRevenue(merchant, merchant.deliverySuccessRate),
    estimatedMonthlyCollectedDzd: monthlyCollected(
      merchant,
      merchant.deliverySuccessRate,
      merchant.codSuccessRate,
    ),
    blockRate: merchant.blockRate,
  };
}

// ── Scenario simulators ───────────────────────────────────────────────────────

function simulateSwitchProvider(
  before: SimulationMetrics,
  merchant: SimulatorMerchantData,
  providers: SimulatorProviderData[],
  scenario: SimulationScenario,
): Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning"> {
  const targetName = scenario.params.targetProvider;
  const target = providers.find((p) => p.provider === targetName);
  if (!target) {
    return {
      after: before,
      confidence: 0,
      recommendation: "avoid",
      reasoning: "Target provider not found in platform data — cannot simulate this switch.",
    };
  }

  const deliveryGain = clamp(target.deliverySuccessRate - merchant.deliverySuccessRate, -0.3, 0.4);
  const newDelivery = clamp(merchant.deliverySuccessRate + deliveryGain * 0.85, 0, 1);
  const newReturn = clamp(before.returnRate - deliveryGain * 0.6, 0, 1);
  const codImprovement = deliveryGain > 0 ? deliveryGain * 0.3 : 0;
  const newCodRefusal = clamp(before.codRefusalRate - codImprovement, 0, 1);
  const newCodSuccess = clamp(1 - newCodRefusal, 0, 1);

  const after: SimulationMetrics = {
    deliverySuccessRate: newDelivery,
    returnRate: newReturn,
    codRefusalRate: newCodRefusal,
    estimatedMonthlyOrdersDzd: monthlyRevenue(merchant, newDelivery),
    estimatedMonthlyCollectedDzd: monthlyCollected(merchant, newDelivery, newCodSuccess),
    blockRate: before.blockRate,
  };

  const conf = clamp(40 + Math.min(target.totalShipments, 200) / 5, 40, 80);
  const recommendation = deliveryGain > 0.08 ? "proceed" : deliveryGain > 0 ? "caution" : "avoid";
  const reasoning =
    deliveryGain > 0
      ? `${target.provider} achieves ${(target.deliverySuccessRate * 100).toFixed(1)}% platform-wide delivery vs your current ${(merchant.deliverySuccessRate * 100).toFixed(1)}%. Switching is estimated to improve your delivery rate by ~${(deliveryGain * 100 * 0.85).toFixed(1)}% (accounting for merchant-specific variance). Confidence: ${conf.toFixed(0)}% (based on ${target.totalShipments} platform shipments with this provider).`
      : `${target.provider} (${(target.deliverySuccessRate * 100).toFixed(1)}%) performs worse than your current setup. Switching is not recommended.`;

  return { after, confidence: Math.round(conf), recommendation, reasoning };
}

function simulateRemoveWorstWilaya(
  before: SimulationMetrics,
  merchant: SimulatorMerchantData,
  scenario: SimulationScenario,
): Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning"> {
  const worst = merchant.topWilayas.find((w) => w.wilaya === scenario.params.worstWilayaName)
    ?? [...merchant.topWilayas].sort((a, b) => a.successRate - b.successRate)[0];

  if (!worst) {
    return { after: before, confidence: 0, recommendation: "avoid", reasoning: "No wilaya data available." };
  }

  const totalOrders = merchant.totalOrders;
  const badOrders = worst.orders;
  const ratio = badOrders / Math.max(1, totalOrders);

  const goodOrders = totalOrders - badOrders;
  const goodSuccesses = before.deliverySuccessRate * totalOrders - worst.successRate * badOrders;
  const newDelivery = goodOrders > 0 ? clamp(goodSuccesses / goodOrders, 0, 1) : before.deliverySuccessRate;

  const newReturn = clamp(before.returnRate + (before.deliverySuccessRate - newDelivery) * 0.7, 0, 1);

  const after: SimulationMetrics = {
    deliverySuccessRate: newDelivery,
    returnRate: newReturn,
    codRefusalRate: before.codRefusalRate,
    estimatedMonthlyOrdersDzd: Math.round(monthlyRevenue(merchant, newDelivery) * (1 - ratio)),
    estimatedMonthlyCollectedDzd: Math.round(monthlyCollected(merchant, newDelivery, 1 - before.codRefusalRate) * (1 - ratio)),
    blockRate: before.blockRate,
  };

  const gain = newDelivery - before.deliverySuccessRate;
  const recommendation = gain > 0.05 ? "proceed" : gain > 0 ? "caution" : "avoid";
  const reasoning = `Removing ${worst.wilaya} (${(worst.successRate * 100).toFixed(1)}% success rate, ${worst.orders} orders) reduces total order volume by ${(ratio * 100).toFixed(1)}% but improves overall delivery rate from ${(before.deliverySuccessRate * 100).toFixed(1)}% to ${(newDelivery * 100).toFixed(1)}%. ${recommendation === "proceed" ? "The quality improvement outweighs the volume loss." : "Marginal improvement — weigh against volume cost before deciding."}`;

  return { after, confidence: 65, recommendation, reasoning };
}

function simulateFocusTopWilayas(
  before: SimulationMetrics,
  merchant: SimulatorMerchantData,
  scenario: SimulationScenario,
): Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning"> {
  const topN = scenario.params.topWilayaCount ?? 3;
  const sorted = [...merchant.topWilayas].sort((a, b) => b.successRate - a.successRate);
  const top = sorted.slice(0, topN);
  if (top.length === 0) return { after: before, confidence: 0, recommendation: "avoid", reasoning: "No wilaya data." };

  const topOrders = top.reduce((s, w) => s + w.orders, 0);
  const topSuccesses = top.reduce((s, w) => s + w.orders * w.successRate, 0);
  const newDelivery = topOrders > 0 ? clamp(topSuccesses / topOrders, 0, 1) : before.deliverySuccessRate;
  const ratio = topOrders / Math.max(1, merchant.totalOrders);
  const newReturn = clamp(1 - newDelivery - before.blockRate, 0, 1);

  const after: SimulationMetrics = {
    deliverySuccessRate: newDelivery,
    returnRate: newReturn,
    codRefusalRate: before.codRefusalRate,
    estimatedMonthlyOrdersDzd: Math.round(monthlyRevenue(merchant, newDelivery) * ratio),
    estimatedMonthlyCollectedDzd: Math.round(monthlyCollected(merchant, newDelivery, 1 - before.codRefusalRate) * ratio),
    blockRate: before.blockRate,
  };

  const gain = newDelivery - before.deliverySuccessRate;
  const recommendation = gain > 0.08 ? "proceed" : gain > 0.03 ? "caution" : "avoid";
  const reasoning = `Focusing on top ${topN} wilaya(s) — ${top.map((w) => w.wilaya).join(", ")} — improves delivery from ${(before.deliverySuccessRate * 100).toFixed(1)}% to ${(newDelivery * 100).toFixed(1)}% at the cost of ${((1 - ratio) * 100).toFixed(1)}% of volume. Net collected revenue ${after.estimatedMonthlyCollectedDzd > before.estimatedMonthlyCollectedDzd ? "increases" : "decreases"}.`;

  return { after, confidence: 60, recommendation, reasoning };
}

function simulatePriceChange(
  before: SimulationMetrics,
  merchant: SimulatorMerchantData,
  scenario: SimulationScenario,
): Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning"> {
  const pctChange = scenario.params.priceChangePct ?? (scenario.type === "increase_price" ? 0.08 : -0.08);
  const elasticity = -1.2;
  const volumeChange = elasticity * pctChange;
  const newMonthlyOrders = Math.max(0, (merchant.totalOrders / 3) * (1 + volumeChange));
  const newBasket = merchant.avgBasketDzd * (1 + pctChange);

  const refusalDelta = pctChange > 0 ? pctChange * 0.3 : pctChange * -0.15;
  const newCodRefusal = clamp(before.codRefusalRate + refusalDelta, 0, 0.8);
  const newCodSuccess = clamp(1 - newCodRefusal, 0, 1);

  const newDelivery = clamp(before.deliverySuccessRate + (pctChange < 0 ? Math.abs(pctChange) * 0.05 : 0), 0, 1);
  const newReturn = clamp(1 - newDelivery - before.blockRate, 0, 1);

  const after: SimulationMetrics = {
    deliverySuccessRate: newDelivery,
    returnRate: newReturn,
    codRefusalRate: newCodRefusal,
    estimatedMonthlyOrdersDzd: Math.round(newMonthlyOrders * newBasket),
    estimatedMonthlyCollectedDzd: Math.round(newMonthlyOrders * newDelivery * newCodSuccess * newBasket),
    blockRate: before.blockRate,
  };

  const netGain = after.estimatedMonthlyCollectedDzd - before.estimatedMonthlyCollectedDzd;
  const recommendation = netGain > 0 ? (netGain > 5000 ? "proceed" : "caution") : "avoid";
  const direction = pctChange > 0 ? "increase" : "decrease";
  const reasoning = `A ${Math.abs(pctChange * 100).toFixed(0)}% price ${direction} with estimated price elasticity of -1.2 changes monthly order volume by ${(volumeChange * 100).toFixed(1)}%. COD refusal rate ${refusalDelta > 0 ? "increases" : "decreases"} by ~${(Math.abs(refusalDelta) * 100).toFixed(1)}%. Net monthly collected revenue impact: ${netGain >= 0 ? "+" : ""}${Math.round(netGain).toLocaleString()} DZD.`;

  return { after, confidence: 45, recommendation, reasoning };
}

function simulateConfirmationCalls(
  before: SimulationMetrics,
  merchant: SimulatorMerchantData,
): Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning"> {
  const codImprovement = 0.12;
  const volumeLoss = -0.08;
  const newCodRefusal = clamp(before.codRefusalRate - codImprovement, 0, 1);
  const newCodSuccess = clamp(1 - newCodRefusal, 0, 1);
  const newMonthlyOrders = (merchant.totalOrders / 3) * (1 + volumeLoss);
  const newDelivery = clamp(before.deliverySuccessRate + 0.03, 0, 1);
  const newReturn = clamp(1 - newDelivery - before.blockRate, 0, 1);

  const after: SimulationMetrics = {
    deliverySuccessRate: newDelivery,
    returnRate: newReturn,
    codRefusalRate: newCodRefusal,
    estimatedMonthlyOrdersDzd: Math.round(newMonthlyOrders * merchant.avgBasketDzd),
    estimatedMonthlyCollectedDzd: Math.round(newMonthlyOrders * newDelivery * newCodSuccess * merchant.avgBasketDzd),
    blockRate: before.blockRate,
  };

  const netGain = after.estimatedMonthlyCollectedDzd - before.estimatedMonthlyCollectedDzd;
  const recommendation = netGain > 0 ? "proceed" : "caution";
  const reasoning = `Confirmation calls typically reduce COD refusals by ~12% and volume by ~8% (customers who won't confirm drop off). Net effect: collected revenue ${netGain >= 0 ? "increases by" : "decreases by"} ~${Math.abs(netGain).toLocaleString()} DZD/month. ${netGain > 0 ? "Recommended — the quality gain outweighs the volume loss." : "The volume loss is too steep given your current COD rate — only consider if refusal rate exceeds 30%."}`;

  return { after, confidence: 62, recommendation, reasoning };
}

function simulatePauseAdvertisingBadWilayas(
  before: SimulationMetrics,
  merchant: SimulatorMerchantData,
): Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning"> {
  const badWilayas = merchant.topWilayas.filter((w) => w.successRate < 0.40);
  if (badWilayas.length === 0) {
    return {
      after: before,
      confidence: 50,
      recommendation: "caution",
      reasoning: "No bad-performing wilayas detected (threshold <40%). No change expected from pausing.",
    };
  }

  const badOrders = badWilayas.reduce((s, w) => s + w.orders, 0);
  const ratio = badOrders / Math.max(1, merchant.totalOrders);
  const goodOrders = merchant.totalOrders - badOrders;
  const goodSuccesses = before.deliverySuccessRate * merchant.totalOrders
    - badWilayas.reduce((s, w) => s + w.orders * w.successRate, 0);
  const newDelivery = goodOrders > 0 ? clamp(goodSuccesses / goodOrders, 0, 1) : before.deliverySuccessRate;
  const newReturn = clamp(1 - newDelivery - before.blockRate, 0, 1);

  const after: SimulationMetrics = {
    deliverySuccessRate: newDelivery,
    returnRate: newReturn,
    codRefusalRate: before.codRefusalRate,
    estimatedMonthlyOrdersDzd: Math.round(monthlyRevenue(merchant, newDelivery) * (1 - ratio)),
    estimatedMonthlyCollectedDzd: Math.round(monthlyCollected(merchant, newDelivery, 1 - before.codRefusalRate) * (1 - ratio)),
    blockRate: before.blockRate,
  };

  const gain = newDelivery - before.deliverySuccessRate;
  const recommendation = gain > 0.05 ? "proceed" : "caution";
  const reasoning = `Pausing ads in ${badWilayas.map((w) => w.wilaya).join(", ")} (${(ratio * 100).toFixed(1)}% of orders, <40% success rate) improves overall delivery from ${(before.deliverySuccessRate * 100).toFixed(1)}% to ${(newDelivery * 100).toFixed(1)}%. Volume drops by ${(ratio * 100).toFixed(1)}% but collected revenue net impact is ${after.estimatedMonthlyCollectedDzd > before.estimatedMonthlyCollectedDzd ? "positive" : "negative"}.`;

  return { after, confidence: 65, recommendation, reasoning };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function simulateDecision(
  merchant: SimulatorMerchantData,
  providers: SimulatorProviderData[],
  _wilayas: SimulatorWilayaData[],
  scenario: SimulationScenario,
): DecisionSimulationResult {
  const before = buildBefore(merchant);

  let result: Pick<DecisionSimulationResult, "after" | "confidence" | "recommendation" | "reasoning">;

  switch (scenario.type) {
    case "switch_provider":
      result = simulateSwitchProvider(before, merchant, providers, scenario);
      break;
    case "remove_worst_wilaya":
      result = simulateRemoveWorstWilaya(before, merchant, scenario);
      break;
    case "focus_top_wilayas":
      result = simulateFocusTopWilayas(before, merchant, scenario);
      break;
    case "increase_price":
    case "decrease_price":
      result = simulatePriceChange(before, merchant, scenario);
      break;
    case "require_confirmation_calls":
      result = simulateConfirmationCalls(before, merchant);
      break;
    case "pause_advertising_bad_wilayas":
      result = simulatePauseAdvertisingBadWilayas(before, merchant);
      break;
    default: {
      const _exhaustive: never = scenario.type;
      result = { after: before, confidence: 0, recommendation: "avoid", reasoning: "Unknown scenario type." };
      void _exhaustive;
    }
  }

  return {
    scenario,
    before,
    after: result.after,
    delta: delta(before, result.after),
    confidence: result.confidence,
    recommendation: result.recommendation,
    reasoning: result.reasoning,
  };
}
