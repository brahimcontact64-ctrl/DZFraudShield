// Data Quality Evaluator.
//
// Checks platform data for completeness and freshness issues.
// Does NOT create new DB tables — reads only from existing tables
// via the pre-loaded intelligence snapshots passed by the caller.
//
// Produces a structured quality report that can be shown on the
// Analytics AI page under a "Data Quality" tab.

import type { MerchantIntelSummary, CategoryIntel, WilayaIntel, ProviderIntel } from "@/lib/merchant-intelligence/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DataQualitySeverity = "ok" | "warning" | "critical";

export type DataQualityCheck = {
  id: string;
  category: "delivery" | "merchant" | "category" | "regional" | "sync";
  severity: DataQualitySeverity;
  title: string;
  description: string;
  affectedCount: number;
  totalCount: number;
  affectedRatio: number;
  recommendation: string;
};

export type DataQualityReport = {
  checks: DataQualityCheck[];
  overallScore: number;          // 0-100 (100 = perfect data quality)
  criticalCount: number;
  warningCount: number;
  okCount: number;
  generatedAt: string;
};

// ── Check builders ────────────────────────────────────────────────────────────

let _id = 0;
function nextId(): string { return `dq-${++_id}`; }

function ratio(affected: number, total: number): number {
  return total > 0 ? affected / total : 0;
}

function sev(r: number, warnThreshold = 0.1, critThreshold = 0.3): DataQualitySeverity {
  if (r >= critThreshold) return "critical";
  if (r >= warnThreshold) return "warning";
  return "ok";
}

// ── Main export ───────────────────────────────────────────────────────────────

export function evaluateDataQuality(
  summaries: MerchantIntelSummary[],
  categories: CategoryIntel[],
  wilayas: WilayaIntel[],
  providers: ProviderIntel[],
): DataQualityReport {
  _id = 0;
  const generatedAt = new Date().toISOString();
  const checks: DataQualityCheck[] = [];
  const totalMerchants = summaries.length;
  const totalShipmentsMerchants = summaries.reduce((s, m) => s + m.totalShipments, 0);

  // ── 1. Merchants with zero shipments ─────────────────────────────────────
  const noShipments = summaries.filter((m) => m.totalShipments === 0 && m.totalOrders > 0).length;
  if (totalMerchants > 0) {
    const r = ratio(noShipments, totalMerchants);
    checks.push({
      id: nextId(),
      category: "delivery",
      severity: sev(r, 0.05, 0.20),
      title: "Merchants with orders but no shipments",
      description: `${noShipments} of ${totalMerchants} merchants have recorded orders but no linked shipments. Delivery outcomes are unavailable for these merchants.`,
      affectedCount: noShipments,
      totalCount: totalMerchants,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "Check that the delivery provider sync has completed for these merchants. Trigger a full merchant sync if stale.",
    });
  }

  // ── 2. Merchants with no terminal delivery outcomes ───────────────────────
  const noTerminal = summaries.filter((m) =>
    m.totalShipments > 0 &&
    m.deliveredShipments === 0 &&
    m.returnedShipments === 0 &&
    m.refusedShipments === 0,
  ).length;
  if (totalMerchants > 0) {
    const r = ratio(noTerminal, totalMerchants);
    checks.push({
      id: nextId(),
      category: "delivery",
      severity: sev(r, 0.1, 0.3),
      title: "Merchants with shipments but no terminal outcomes",
      description: `${noTerminal} of ${totalMerchants} merchants have shipments with no delivered/returned/refused status. Delivery rate cannot be computed.`,
      affectedCount: noTerminal,
      totalCount: totalMerchants,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "Ensure delivery provider webhook events are being received and processed. Run delivery-intelligence backfill if sync is stale.",
    });
  }

  // ── 3. Missing wilaya data ────────────────────────────────────────────────
  const noWilayaData = wilayas.filter((w) => !w.wilaya || w.wilaya.trim() === "").length;
  const totalWilayas = wilayas.length;
  if (totalWilayas > 0) {
    const r = ratio(noWilayaData, totalWilayas);
    checks.push({
      id: nextId(),
      category: "regional",
      severity: sev(r, 0.05, 0.15),
      title: "Shipments missing wilaya assignment",
      description: `${noWilayaData} wilaya records have blank wilaya names. Regional analysis and wilaya-level targeting are incomplete.`,
      affectedCount: noWilayaData,
      totalCount: totalWilayas,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "Check delivery provider API response for commune/wilaya fields. Ensure address parsing is configured for all providers.",
    });
  }

  // ── 4. Categories with no product data ───────────────────────────────────
  const noCategoryData = categories.filter((c) => c.totalOrders === 0).length;
  const totalCategories = categories.length;
  if (totalCategories > 0) {
    const r = ratio(noCategoryData, totalCategories);
    checks.push({
      id: nextId(),
      category: "category",
      severity: sev(r, 0.2, 0.5),
      title: "Categories with no order data",
      description: `${noCategoryData} of ${totalCategories} categories have zero orders. Category intelligence is incomplete.`,
      affectedCount: noCategoryData,
      totalCount: totalCategories,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "Ensure marketing intelligence order line sync is enabled and has completed at least one full sync.",
    });
  }

  // ── 5. Providers with very few shipments (comparison noise) ─────────────
  const thinProviders = providers.filter((p) => p.totalShipments > 0 && p.totalShipments < 30).length;
  const totalProviders = providers.length;
  if (totalProviders > 0) {
    const r = ratio(thinProviders, totalProviders);
    checks.push({
      id: nextId(),
      category: "sync",
      severity: sev(r, 0.3, 0.6),
      title: "Providers with insufficient data for comparison",
      description: `${thinProviders} of ${totalProviders} providers have fewer than 30 shipments — below the minimum for reliable comparison.`,
      affectedCount: thinProviders,
      totalCount: totalProviders,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "These providers are excluded from comparative analytics. No action needed unless this is unexpected.",
    });
  }

  // ── 6. Merchant 12-month order history completeness ───────────────────────
  const sparseHistory = summaries.filter((m) => {
    const nonZero = m.orderTrend.filter((v) => v > 0).length;
    return nonZero < 4;
  }).length;
  if (totalMerchants > 0) {
    const r = ratio(sparseHistory, totalMerchants);
    checks.push({
      id: nextId(),
      category: "merchant",
      severity: sev(r, 0.2, 0.5),
      title: "Merchants with sparse 12-month order history",
      description: `${sparseHistory} of ${totalMerchants} merchants have fewer than 4 months of order data. Forecasts and trend analysis are unreliable for these merchants.`,
      affectedCount: sparseHistory,
      totalCount: totalMerchants,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "New merchants naturally have sparse history. This will resolve over time. Forecasts are disabled for these merchants.",
    });
  }

  // ── 7. Merchants with suspect block rate patterns ─────────────────────────
  // Very high block rate may indicate backfill/sync issue rather than real fraud
  const suspiciousBlock = summaries.filter((m) =>
    m.blockRate > 0.8 && m.totalOrders >= 10,
  ).length;
  if (totalMerchants > 0 && suspiciousBlock > 0) {
    const r = ratio(suspiciousBlock, totalMerchants);
    checks.push({
      id: nextId(),
      category: "merchant",
      severity: sev(r, 0.01, 0.05),
      title: "Merchants with suspicious block rate (>80%)",
      description: `${suspiciousBlock} merchants have block rates above 80%, which may indicate a data ingestion anomaly rather than genuine fraud.`,
      affectedCount: suspiciousBlock,
      totalCount: totalMerchants,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "Review these merchants manually. If recently onboarded, this may reflect backfill of pre-integration orders with no fraud check outcome.",
    });
  }

  // ── 8. Wilayas with zero shipments (coverage gaps) ───────────────────────
  const ALGERIA_WILAYA_COUNT = 58;
  const coveredWilayas = new Set(wilayas.map((w) => w.wilaya)).size;
  const uncoveredCount = Math.max(0, ALGERIA_WILAYA_COUNT - coveredWilayas);
  if (uncoveredCount > 0) {
    const r = uncoveredCount / ALGERIA_WILAYA_COUNT;
    checks.push({
      id: nextId(),
      category: "regional",
      severity: sev(r, 0.3, 0.6),
      title: `${uncoveredCount} of 58 wilayas have no shipment data`,
      description: `Platform coverage: ${coveredWilayas} of 58 Algerian wilayas. ${uncoveredCount} wilayas have no recorded shipments — regional analytics are incomplete for those areas.`,
      affectedCount: uncoveredCount,
      totalCount: ALGERIA_WILAYA_COUNT,
      affectedRatio: Number(r.toFixed(4)),
      recommendation: "This is expected for early-stage platforms. As merchant coverage grows, more wilayas will appear automatically.",
    });
  }

  // ── 9. Zero-total-shipment platform check ────────────────────────────────
  if (totalShipmentsMerchants === 0) {
    checks.push({
      id: nextId(),
      category: "sync",
      severity: "critical",
      title: "No shipment data available platform-wide",
      description: "Zero shipments found across all merchants. Delivery intelligence, forecasts, and anomaly detection are entirely unavailable.",
      affectedCount: totalMerchants,
      totalCount: totalMerchants,
      affectedRatio: 1,
      recommendation: "Trigger a full delivery intelligence sync from /admin/delivery-intelligence. Ensure provider credentials are configured.",
    });
  }

  // ── 10. No merchant history at all ───────────────────────────────────────
  if (totalMerchants === 0) {
    checks.push({
      id: nextId(),
      category: "merchant",
      severity: "critical",
      title: "No merchant data available",
      description: "No merchants found. All analytics modules require at least one merchant with order data.",
      affectedCount: 0,
      totalCount: 0,
      affectedRatio: 1,
      recommendation: "Ensure the platform has active merchants and the merchant intelligence sync has run.",
    });
  }

  // ── Score ──────────────────────────────────────────────────────────────────
  const criticalCount = checks.filter((c) => c.severity === "critical").length;
  const warningCount  = checks.filter((c) => c.severity === "warning").length;
  const okCount       = checks.filter((c) => c.severity === "ok").length;

  const penaltyPerCritical = 20;
  const penaltyPerWarning  = 5;
  const overallScore = Math.max(
    0,
    Math.min(100, 100 - criticalCount * penaltyPerCritical - warningCount * penaltyPerWarning),
  );

  return { checks, overallScore, criticalCount, warningCount, okCount, generatedAt };
}
