// Trend analysis module.
//
// Identifies growing/declining/exploding entities across:
//   - Merchants (from orderGrowthRate, revenueGrowthRate)
//   - Categories (delivery success rate vs platform average)
//   - Wilayas (delivery success rate vs platform average)
//   - Providers (delivery success rate comparison)

import type { MerchantIntelSummary, CategoryIntel, WilayaIntel, ProviderIntel } from "@/lib/merchant-intelligence/types";
import type { ForecastDirection, TrendSignal } from "./types";
import { mean } from "./math";

let _id = 0;
function nextId(): string { return `tr-${++_id}`; }
export function resetTrendIds(): void { _id = 0; }

function direction(rate: number): ForecastDirection {
  if (rate > 0.4) return "exploding";
  if (rate > 0.1) return "growing";
  if (rate < -0.4) return "collapsing";
  if (rate < -0.1) return "declining";
  return "stable";
}

function confidence(sampleSize: number, magnitude: number): number {
  const sampleScore = Math.min(50, (sampleSize / 200) * 50);
  const signalScore = Math.min(40, Math.abs(magnitude) * 100);
  return Math.round(Math.max(5, Math.min(88, sampleScore + signalScore)));
}

// ── Category trends ───────────────────────────────────────────────────────────

export function buildCategoryTrends(categories: CategoryIntel[]): TrendSignal[] {
  if (categories.length === 0) return [];

  const platformAvgRate = mean(categories.map((c) => c.deliverySuccessRate));
  const signals: TrendSignal[] = [];

  for (const cat of categories) {
    if (cat.totalOrders < 10) continue;

    const deviation = cat.deliverySuccessRate - platformAvgRate;
    const dir = direction(deviation);
    if (dir === "stable") continue;

    const pct = (deviation * 100).toFixed(1);
    const sign = deviation >= 0 ? "+" : "";

    signals.push({
      id: nextId(),
      entity: cat.categoryName,
      entityType: "category",
      direction: dir,
      magnitude: Number(deviation.toFixed(4)),
      confidence: confidence(cat.totalOrders, deviation),
      description: `${cat.categoryName}: ${sign}${pct}% vs platform avg delivery rate (${(cat.deliverySuccessRate * 100).toFixed(1)}% vs ${(platformAvgRate * 100).toFixed(1)}% platform avg). ${cat.totalOrders.toLocaleString()} orders, ${cat.grossRevenueDzd.toLocaleString("fr-DZ")} DZD gross.`,
      estimatedRevenueImpactDzd: Math.round(Math.abs(deviation) * cat.grossRevenueDzd),
      merchantId: null,
    });
  }

  return signals.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
}

// ── Wilaya trends ─────────────────────────────────────────────────────────────

export function buildWilayaTrends(wilayas: WilayaIntel[]): TrendSignal[] {
  if (wilayas.length === 0) return [];

  const platformAvgRate = mean(wilayas.map((w) => w.deliverySuccessRate));
  const signals: TrendSignal[] = [];

  for (const w of wilayas) {
    if (w.totalShipments < 20) continue;

    const deviation = w.deliverySuccessRate - platformAvgRate;
    const dir = direction(deviation);
    if (dir === "stable") continue;

    const pct = (deviation * 100).toFixed(1);
    const sign = deviation >= 0 ? "+" : "";

    signals.push({
      id: nextId(),
      entity: w.wilaya,
      entityType: "wilaya",
      direction: dir,
      magnitude: Number(deviation.toFixed(4)),
      confidence: confidence(w.totalShipments, deviation),
      description: `${w.wilaya}: ${sign}${pct}% vs platform avg (${(w.deliverySuccessRate * 100).toFixed(1)}% success). ${w.totalShipments.toLocaleString()} shipments. Best provider: ${w.bestProvider ?? "N/A"}.`,
      estimatedRevenueImpactDzd: Math.round(Math.abs(deviation) * w.grossRevenueDzd * 0.3),
      merchantId: null,
    });
  }

  return signals.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
}

// ── Provider trends ───────────────────────────────────────────────────────────

export function buildProviderTrends(providers: ProviderIntel[]): TrendSignal[] {
  if (providers.length < 2) return [];

  const platformAvgRate = mean(providers.map((p) => p.deliverySuccessRate));
  const signals: TrendSignal[] = [];

  for (const p of providers) {
    if (p.totalShipments < 30) continue;

    const deviation = p.deliverySuccessRate - platformAvgRate;
    const dir = direction(deviation);
    if (dir === "stable") continue;

    const pct = (deviation * 100).toFixed(1);
    const sign = deviation >= 0 ? "+" : "";

    const avgCod = p.totalShipments > 0
      ? (p.totalShipments * 2500 * Math.abs(deviation)) // rough estimate
      : 0;

    signals.push({
      id: nextId(),
      entity: p.provider,
      entityType: "provider",
      direction: dir,
      magnitude: Number(deviation.toFixed(4)),
      confidence: confidence(p.totalShipments, deviation),
      description: `${p.provider}: ${sign}${pct}% vs platform avg (${(p.deliverySuccessRate * 100).toFixed(1)}% success, ${p.merchantCount} merchants, ${p.totalShipments.toLocaleString()} shipments). Return rate: ${(p.returnRate * 100).toFixed(1)}%.`,
      estimatedRevenueImpactDzd: Math.round(avgCod),
      merchantId: null,
    });
  }

  return signals.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
}

// ── Merchant trends (top N significant movers) ────────────────────────────────

export function buildTopMerchantTrends(
  summaries: MerchantIntelSummary[],
  topN = 15,
): TrendSignal[] {
  const significant = summaries
    .filter((m) => m.totalOrders >= 10 && Math.abs(m.orderGrowthRate) > 0.05)
    .sort((a, b) => Math.abs(b.revenueGrowthRate) - Math.abs(a.revenueGrowthRate))
    .slice(0, topN);

  const signals: TrendSignal[] = [];

  for (const m of significant) {
    const rate = m.orderGrowthRate * 0.5 + m.revenueGrowthRate * 0.5;
    const dir = direction(rate);
    const pct = (rate * 100).toFixed(1);
    const sign = rate >= 0 ? "+" : "";

    signals.push({
      id: nextId(),
      entity: m.name,
      entityType: "merchant",
      direction: dir,
      magnitude: Number(rate.toFixed(4)),
      confidence: confidence(m.totalOrders, rate),
      description: `${m.name}: ${sign}${pct}% combined order+revenue MoM. Orders: ${m.totalOrders.toLocaleString()}, Delivery: ${(m.deliverySuccessRate * 100).toFixed(1)}%, Block rate: ${(m.blockRate * 100).toFixed(1)}%.`,
      estimatedRevenueImpactDzd: Math.round(Math.abs(rate) * m.grossRevenueDzd),
      merchantId: m.merchantId,
    });
  }

  return signals;
}
