// Automation Engine — converts HIGH/CRITICAL recommendations into executable automations.
//
// Every automation:
//   - Requires merchant approval before execution
//   - Has a risk level (low/medium/high)
//   - Has an estimated time to execute
//   - Carries financial impact from the source recommendation
//
// Only CRITICAL and HIGH priority recommendations become automations.
// MEDIUM/LOW remain as recommendations — they don't warrant automated workflow.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateRecommendations } from "@/lib/recommendation-engine/engine";
import type { Recommendation, RecommendationType } from "@/lib/recommendation-engine/types";
import type {
  Automation,
  AutomationEngineOutput,
  AutomationPriority,
  AutomationRisk,
  AutomationSummary,
  AutomationType,
} from "./types";

const NOW = new Date().toISOString();

// ── Recommendation → Automation mapping ──────────────────────────────────────

type AutomationMeta = {
  type: AutomationType;
  riskLevel: AutomationRisk;
  estimatedTimeMinutes: number;
};

const REC_TO_AUTOMATION: Partial<Record<RecommendationType, AutomationMeta>> = {
  advertising_pause:             { type: "pause_advertising",          riskLevel: "low",    estimatedTimeMinutes: 5 },
  advertising_increase:          { type: "increase_advertising",       riskLevel: "medium", estimatedTimeMinutes: 10 },
  advertising_reduce:            { type: "reduce_advertising",         riskLevel: "low",    estimatedTimeMinutes: 10 },
  advertising_region_focus:      { type: "increase_advertising",       riskLevel: "medium", estimatedTimeMinutes: 15 },
  delivery_provider_switch:      { type: "switch_provider",            riskLevel: "high",   estimatedTimeMinutes: 60 },
  delivery_use_stopdesk:         { type: "switch_provider",            riskLevel: "medium", estimatedTimeMinutes: 30 },
  delivery_confirmation_calls:   { type: "require_phone_confirmation", riskLevel: "low",    estimatedTimeMinutes: 15 },
  delivery_prepayment:           { type: "force_cod_verification",     riskLevel: "medium", estimatedTimeMinutes: 20 },
  delivery_free_shipping_region: { type: "increase_advertising",       riskLevel: "low",    estimatedTimeMinutes: 15 },
  product_best_seller:           { type: "promote_product",            riskLevel: "low",    estimatedTimeMinutes: 10 },
  product_growing:               { type: "increase_stock",             riskLevel: "low",    estimatedTimeMinutes: 10 },
  product_declining:             { type: "lower_price",                riskLevel: "medium", estimatedTimeMinutes: 10 },
  product_high_returns:          { type: "disable_product",            riskLevel: "high",   estimatedTimeMinutes: 5 },
  product_bundle_opportunity:    { type: "promote_product",            riskLevel: "low",    estimatedTimeMinutes: 20 },
  product_discontinue:           { type: "disable_product",            riskLevel: "high",   estimatedTimeMinutes: 5 },
  product_promote_region:        { type: "promote_product",            riskLevel: "low",    estimatedTimeMinutes: 15 },
  pricing_increase_cod:          { type: "raise_price",                riskLevel: "medium", estimatedTimeMinutes: 10 },
  pricing_reduce_discount:       { type: "raise_price",                riskLevel: "medium", estimatedTimeMinutes: 10 },
  pricing_free_shipping_threshold: { type: "lower_price",             riskLevel: "low",    estimatedTimeMinutes: 10 },
  pricing_margin_improvement:    { type: "raise_price",                riskLevel: "medium", estimatedTimeMinutes: 10 },
  merchant_growing:              { type: "increase_advertising",       riskLevel: "low",    estimatedTimeMinutes: 10 },
  merchant_needs_attention:      { type: "notify_merchant",            riskLevel: "low",    estimatedTimeMinutes: 5 },
  merchant_fraud_spike:          { type: "escalate_to_admin",          riskLevel: "low",    estimatedTimeMinutes: 2 },
  merchant_customer_decline:     { type: "notify_merchant",            riskLevel: "low",    estimatedTimeMinutes: 5 },
  merchant_delivery_decline:     { type: "require_phone_confirmation", riskLevel: "low",    estimatedTimeMinutes: 5 },
  merchant_cod_refusal:          { type: "force_cod_verification",     riskLevel: "medium", estimatedTimeMinutes: 15 },
  regional_opportunity:          { type: "increase_advertising",       riskLevel: "medium", estimatedTimeMinutes: 15 },
  regional_risk:                 { type: "reduce_advertising",         riskLevel: "low",    estimatedTimeMinutes: 10 },
  regional_emerging:             { type: "increase_advertising",       riskLevel: "medium", estimatedTimeMinutes: 15 },
  regional_high_value:           { type: "increase_advertising",       riskLevel: "low",    estimatedTimeMinutes: 10 },
  customer_repeat_buyers:        { type: "promote_product",            riskLevel: "low",    estimatedTimeMinutes: 10 },
  customer_new_declining:        { type: "notify_merchant",            riskLevel: "low",    estimatedTimeMinutes: 5 },
  customer_high_value_segment:   { type: "promote_product",            riskLevel: "low",    estimatedTimeMinutes: 10 },
};

// ── Automation description builder ────────────────────────────────────────────

function buildDescription(rec: Recommendation, meta: AutomationMeta): string {
  const merchant = rec.merchantName ? ` for ${rec.merchantName}` : "";
  switch (meta.type) {
    case "pause_advertising":          return `Pause all advertising${merchant} — ${rec.title}`;
    case "increase_advertising":       return `Increase ad budget${merchant} — ${rec.title}`;
    case "reduce_advertising":         return `Reduce ad spend by 30–50%${merchant} — ${rec.title}`;
    case "switch_provider":            return `Switch delivery provider${merchant}${rec.provider ? ` to ${rec.provider}` : ""} — ${rec.title}`;
    case "require_phone_confirmation": return `Enable mandatory confirmation calls${merchant} before dispatch`;
    case "force_cod_verification":     return `Require upfront COD verification${merchant} for high-risk orders`;
    case "reduce_stock":               return `Reduce stock levels${merchant}${rec.productName ? ` for ${rec.productName}` : ""}`;
    case "increase_stock":             return `Increase stock${merchant}${rec.productName ? ` for ${rec.productName}` : ""}`;
    case "raise_price":                return `Increase product price${merchant}${rec.productName ? ` for ${rec.productName}` : ""}`;
    case "lower_price":                return `Reduce price${merchant}${rec.productName ? ` for ${rec.productName}` : ""} to reduce return rate`;
    case "disable_product":            return `Disable product listing${merchant}${rec.productName ? ` for ${rec.productName}` : ""}`;
    case "promote_product":            return `Activate promotion${merchant}${rec.productName ? ` for ${rec.productName}` : ""}`;
    case "notify_merchant":            return `Send alert to merchant${merchant}: ${rec.title}`;
    case "escalate_to_admin":          return `Escalate to admin review${merchant}: ${rec.title}`;
    default:                           return rec.title;
  }
}

let _id = 0;

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateAutomations(
  supabase: SupabaseClient,
): Promise<AutomationEngineOutput> {
  _id = 0;

  const { recommendations } = await generateRecommendations(supabase);

  // Only convert CRITICAL and HIGH priority
  const eligible = recommendations.filter(
    (r) => r.priority === "CRITICAL" || r.priority === "HIGH",
  );

  const automations: Automation[] = [];

  for (const rec of eligible) {
    const meta = REC_TO_AUTOMATION[rec.type];
    if (!meta) continue;

    automations.push({
      id: `auto-${++_id}`,
      type: meta.type,
      priority: rec.priority as AutomationPriority,
      status: "pending_approval",
      confidence: rec.confidenceScore,
      estimatedGainDzd: rec.estimatedSavingsDzd + rec.estimatedRevenueIncreaseDzd,
      riskLevel: meta.riskLevel,
      reason: rec.reason,
      description: buildDescription(rec, meta),
      requiresApproval: true,
      estimatedTimeMinutes: meta.estimatedTimeMinutes,
      merchantId: rec.merchantId,
      merchantName: rec.merchantName,
      categoryName: rec.categoryName ?? null,
      wilaya: rec.wilaya ?? null,
      provider: rec.provider ?? null,
      productName: rec.productName ?? null,
      sourceRecommendationId: rec.id,
      generatedAt: NOW,
    });
  }

  // Sort: CRITICAL first, then HIGH, then by financial impact desc
  const PRIORITY_ORDER: Record<AutomationPriority, number> = {
    CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
  };
  automations.sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    return b.estimatedGainDzd - a.estimatedGainDzd;
  });

  // ── Build summary ────────────────────────────────────────────────────────

  const byType = {} as Record<AutomationType, number>;
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let totalGain = 0;

  for (const a of automations) {
    byType[a.type] = (byType[a.type] ?? 0) + 1;
    if (a.priority === "CRITICAL") criticalCount++;
    else if (a.priority === "HIGH") highCount++;
    else mediumCount++;
    totalGain += a.estimatedGainDzd;
  }

  const summary: AutomationSummary = {
    totalAutomations: automations.length,
    criticalCount,
    highCount,
    mediumCount,
    pendingApprovalCount: automations.length,
    totalEstimatedGainDzd: Math.round(totalGain),
    byType,
    generatedAt: NOW,
  };

  return { automations, summary };
}
