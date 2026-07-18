// Automation Engine types.
//
// Automations are executable actions derived from HIGH/CRITICAL recommendations.
// Every automation requires merchant approval before execution.
// Nothing executes automatically.

export type AutomationType =
  | "pause_advertising"
  | "increase_advertising"
  | "reduce_advertising"
  | "switch_provider"
  | "require_phone_confirmation"
  | "force_cod_verification"
  | "reduce_stock"
  | "increase_stock"
  | "raise_price"
  | "lower_price"
  | "disable_product"
  | "promote_product"
  | "notify_merchant"
  | "escalate_to_admin";

export type AutomationStatus = "pending_approval";

export type AutomationRisk = "low" | "medium" | "high";

export type AutomationPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Automation = {
  id: string;
  type: AutomationType;
  priority: AutomationPriority;
  status: AutomationStatus;
  confidence: number;              // 0-100
  estimatedGainDzd: number;       // savings + revenue increase
  riskLevel: AutomationRisk;
  reason: string;
  description: string;
  requiresApproval: true;          // always true
  estimatedTimeMinutes: number;
  merchantId: string | null;
  merchantName: string | null;
  categoryName: string | null;
  wilaya: string | null;
  provider: string | null;
  productName: string | null;
  sourceRecommendationId: string;
  generatedAt: string;
};

export type AutomationSummary = {
  totalAutomations: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  pendingApprovalCount: number;
  totalEstimatedGainDzd: number;
  byType: Record<AutomationType, number>;
  generatedAt: string;
};

export type AutomationEngineOutput = {
  automations: Automation[];
  summary: AutomationSummary;
};
