// Seasonal pattern detection.
//
// Aggregates all merchants' 12-month orderTrend arrays into a platform-wide
// monthly series, then detects which calendar months are above/below average.
//
// Since the orderTrend index maps to real calendar months (index 11 = current month),
// we can identify seasonal patterns like summer, winter, Ramadan, back-to-school.
//
// Seasonal patterns are inferred from data — nothing is hardcoded.

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { SeasonalPattern, SeasonalPhase } from "./types";
import { mean, standardDeviation, indexToCalendar, MONTH_NAMES } from "./math";

let _id = 0;
function nextId(): string { return `sp-${++_id}`; }
export function resetSeasonalIds(): void { _id = 0; }

// ── Seasonal pattern detection ────────────────────────────────────────────────

export function buildSeasonalPatterns(
  summaries: MerchantIntelSummary[],
  now: Date,
): SeasonalPattern[] {
  if (summaries.length === 0) return [];

  // Sum all merchants' orderTrend into platform monthly totals
  const platform = new Array<number>(12).fill(0);
  for (const m of summaries) {
    for (let i = 0; i < 12; i++) {
      platform[i] += m.orderTrend[i] ?? 0;
    }
  }

  // Map each index to its calendar month (1-based)
  const calendarMonths = platform.map((_, i) => indexToCalendar(i, now));
  const currentMonth = now.getMonth() + 1; // 1-based

  const avgOrders = mean(platform);
  const stdOrders = standardDeviation(platform);

  if (avgOrders === 0) return [];

  // Confidence based on total data volume
  const totalOrders = platform.reduce((s, v) => s + v, 0);
  const baseConfidence = Math.min(75, Math.max(10, (totalOrders / 1000) * 40));

  // ── Classify each month ────────────────────────────────────────────────────

  type MonthData = {
    index: number;
    month: number; // 1-based
    year: number;
    label: string;
    orders: number;
    zScore: number;
    isPeak: boolean;
    isTrough: boolean;
  };

  const months: MonthData[] = platform.map((orders, i) => {
    const z = stdOrders > 0 ? (orders - avgOrders) / stdOrders : 0;
    return {
      index: i,
      month: calendarMonths[i].month,
      year: calendarMonths[i].year,
      label: MONTH_NAMES[calendarMonths[i].month - 1],
      orders,
      zScore: z,
      isPeak: z > 0.5,
      isTrough: z < -0.5,
    };
  });

  const patterns: SeasonalPattern[] = [];

  // ── Summer pattern (June, July, August) ───────────────────────────────────
  const summerMonthNums = [6, 7, 8];
  const summerData = months.filter((m) => summerMonthNums.includes(m.month));
  if (summerData.length >= 2) {
    const avgSummer = mean(summerData.map((d) => d.orders));
    const amplitude = avgOrders > 0 ? (avgSummer - avgOrders) / avgOrders : 0;
    if (Math.abs(amplitude) > 0.08) {
      const isPeakSummer = amplitude > 0;
      const currentSummer = summerData.find((d) => d.month === currentMonth);
      const phase: SeasonalPhase = currentSummer
        ? currentSummer.isPeak ? "peak" : currentSummer.isTrough ? "trough" : "neutral"
        : "neutral";

      patterns.push({
        id: nextId(),
        name: isPeakSummer ? "Summer Surge" : "Summer Slowdown",
        description: isPeakSummer
          ? `Order volume is ${(amplitude * 100).toFixed(1)}% above average during June–August. Summer is a strong selling season.`
          : `Order volume is ${(Math.abs(amplitude) * 100).toFixed(1)}% below average during June–August. Summer shows reduced demand.`,
        peakMonthLabels: isPeakSummer ? ["June", "July", "August"] : [],
        troughMonthLabels: isPeakSummer ? [] : ["June", "July", "August"],
        amplitude: Number(amplitude.toFixed(3)),
        confidence: Math.round(baseConfidence * Math.min(1, summerData.length / 3)),
        currentPhase: phase,
        currentMonthLabel: MONTH_NAMES[currentMonth - 1],
        platformOrdersAtPeak: Math.round(avgSummer),
        platformOrdersAtTrough: isPeakSummer ? Math.round(avgOrders) : Math.round(avgSummer),
      });
    }
  }

  // ── Back-to-school pattern (September) ────────────────────────────────────
  const septData = months.find((m) => m.month === 9);
  if (septData && Math.abs(septData.zScore) > 0.5) {
    const amplitude = avgOrders > 0 ? (septData.orders - avgOrders) / avgOrders : 0;
    patterns.push({
      id: nextId(),
      name: amplitude > 0 ? "Back-to-School Spike" : "September Dip",
      description: amplitude > 0
        ? `September shows ${(amplitude * 100).toFixed(1)}% above-average orders — back-to-school demand spike.`
        : `September shows ${(Math.abs(amplitude) * 100).toFixed(1)}% below-average orders — quiet period after summer.`,
      peakMonthLabels: amplitude > 0 ? ["September"] : [],
      troughMonthLabels: amplitude > 0 ? [] : ["September"],
      amplitude: Number(amplitude.toFixed(3)),
      confidence: Math.round(baseConfidence * 0.6),
      currentPhase: currentMonth === 9 ? (amplitude > 0 ? "peak" : "trough") : "neutral",
      currentMonthLabel: MONTH_NAMES[currentMonth - 1],
      platformOrdersAtPeak: amplitude > 0 ? Math.round(septData.orders) : Math.round(avgOrders),
      platformOrdersAtTrough: amplitude > 0 ? Math.round(avgOrders) : Math.round(septData.orders),
    });
  }

  // ── Winter pattern (November, December, January) ─────────────────────────
  const winterMonthNums = [11, 12, 1];
  const winterData = months.filter((m) => winterMonthNums.includes(m.month));
  if (winterData.length >= 2) {
    const avgWinter = mean(winterData.map((d) => d.orders));
    const amplitude = avgOrders > 0 ? (avgWinter - avgOrders) / avgOrders : 0;
    if (Math.abs(amplitude) > 0.08) {
      const isPeakWinter = amplitude > 0;
      const inWinter = winterMonthNums.includes(currentMonth);
      const phase: SeasonalPhase = inWinter
        ? isPeakWinter ? "peak" : "trough"
        : "neutral";

      patterns.push({
        id: nextId(),
        name: isPeakWinter ? "Winter Sales Peak" : "Winter Slowdown",
        description: isPeakWinter
          ? `November–January sees ${(amplitude * 100).toFixed(1)}% above-average orders — strong winter demand.`
          : `November–January shows ${(Math.abs(amplitude) * 100).toFixed(1)}% below-average demand — quieter winter season.`,
        peakMonthLabels: isPeakWinter ? ["November", "December", "January"] : [],
        troughMonthLabels: isPeakWinter ? [] : ["November", "December", "January"],
        amplitude: Number(amplitude.toFixed(3)),
        confidence: Math.round(baseConfidence * Math.min(1, winterData.length / 3)),
        currentPhase: phase,
        currentMonthLabel: MONTH_NAMES[currentMonth - 1],
        platformOrdersAtPeak: isPeakWinter ? Math.round(avgWinter) : Math.round(avgOrders),
        platformOrdersAtTrough: isPeakWinter ? Math.round(avgOrders) : Math.round(avgWinter),
      });
    }
  }

  // ── Ramadan pattern (detected from data, not hardcoded) ───────────────────
  // Ramadan produces a recognizable spike in Algerian COD e-commerce.
  // We detect any 2-consecutive-month cluster with z-score > 0.8 that isn't summer/winter.
  const nonSeasonalMonths = months.filter(
    (m) => !summerMonthNums.includes(m.month) && !winterMonthNums.includes(m.month) && m.month !== 9,
  );

  for (let i = 0; i < nonSeasonalMonths.length - 1; i++) {
    const a = nonSeasonalMonths[i];
    const b = nonSeasonalMonths[i + 1];
    if (a.zScore > 0.8 && b.zScore > 0.8) {
      const avgPeak = (a.orders + b.orders) / 2;
      const amplitude = avgOrders > 0 ? (avgPeak - avgOrders) / avgOrders : 0;
      const inPeriod = currentMonth === a.month || currentMonth === b.month;

      patterns.push({
        id: nextId(),
        name: `${a.label}–${b.label} Demand Spike`,
        description: `${a.label} and ${b.label} show ${(amplitude * 100).toFixed(1)}% above-average orders. This may correspond to Ramadan/Eid demand or promotional activity.`,
        peakMonthLabels: [a.label, b.label],
        troughMonthLabels: [],
        amplitude: Number(amplitude.toFixed(3)),
        confidence: Math.round(baseConfidence * 0.7),
        currentPhase: inPeriod ? "peak" : "neutral",
        currentMonthLabel: MONTH_NAMES[currentMonth - 1],
        platformOrdersAtPeak: Math.round(avgPeak),
        platformOrdersAtTrough: Math.round(avgOrders),
      });
      break; // Only detect the strongest non-seasonal spike
    }
  }

  // ── Current month performance ─────────────────────────────────────────────
  const currentData = months.find((m) => m.month === currentMonth);
  if (currentData && (currentData.isPeak || currentData.isTrough)) {
    const amplitude = avgOrders > 0 ? (currentData.orders - avgOrders) / avgOrders : 0;
    if (Math.abs(amplitude) > 0.1) {
      const isPeak = amplitude > 0;
      patterns.push({
        id: nextId(),
        name: isPeak ? "Current Month Above Average" : "Current Month Below Average",
        description: isPeak
          ? `${currentData.label} is running ${(amplitude * 100).toFixed(1)}% above the 12-month average (${Math.round(avgOrders).toLocaleString("fr-DZ")} orders/month).`
          : `${currentData.label} is running ${(Math.abs(amplitude) * 100).toFixed(1)}% below the 12-month average. Possible seasonal trough or external factor.`,
        peakMonthLabels: isPeak ? [currentData.label] : [],
        troughMonthLabels: isPeak ? [] : [currentData.label],
        amplitude: Number(amplitude.toFixed(3)),
        confidence: Math.round(baseConfidence * 0.8),
        currentPhase: isPeak ? "peak" : "trough",
        currentMonthLabel: MONTH_NAMES[currentMonth - 1],
        platformOrdersAtPeak: isPeak ? currentData.orders : Math.round(avgOrders),
        platformOrdersAtTrough: isPeak ? Math.round(avgOrders) : currentData.orders,
      });
    }
  }

  return patterns;
}
