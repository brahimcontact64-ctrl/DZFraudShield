import { describe, expect, it } from "vitest";
import {
  linearRegression,
  predict,
  confidenceBounds,
  mean,
  standardDeviation,
  zScores,
  movingAverage,
  regressionConfidence,
} from "@/lib/analytics-ai/math";
import {
  checkSample,
  checkRegressionReadiness,
  checkRateValidity,
  buildImpactRange,
  nonZeroMonths,
  MIN_SAMPLES,
} from "@/lib/analytics-ai/sample-guards";
import { simulateDecision } from "@/lib/strategy-engine/decision-simulator";
import type { SimulationScenario, SimulatorMerchantData, SimulatorProviderData, SimulatorWilayaData } from "@/lib/strategy-engine/types";

// ── Math: linearRegression ────────────────────────────────────────────────────

describe("linearRegression", () => {
  it("returns zero slope for empty / single-element input", () => {
    const r0 = linearRegression([]);
    expect(r0.slope).toBe(0);
    expect(r0.intercept).toBe(0);

    const r1 = linearRegression([42]);
    expect(r1.slope).toBe(0);
    expect(r1.intercept).toBe(42);
  });

  it("fits a perfect ascending line", () => {
    // y = 2x: [0,2,4,6,8,10]
    const series = [0, 2, 4, 6, 8, 10];
    const r = linearRegression(series);
    expect(r.slope).toBeCloseTo(2, 5);
    expect(r.r2).toBeCloseTo(1, 5);
  });

  it("fits a perfect descending line", () => {
    const series = [10, 8, 6, 4, 2, 0];
    const r = linearRegression(series);
    expect(r.slope).toBeCloseTo(-2, 5);
    expect(r.r2).toBeCloseTo(1, 5);
  });

  it("returns r2=0 for a flat constant series", () => {
    const series = [5, 5, 5, 5, 5, 5];
    const r = linearRegression(series);
    expect(r.slope).toBeCloseTo(0, 5);
    expect(r.r2).toBe(0);
  });

  it("clamps r2 to [0, 1] — never negative", () => {
    // Highly volatile series that regresses poorly
    const series = [100, 1, 100, 1, 100, 1, 100, 1, 100, 1];
    const r = linearRegression(series);
    expect(r.r2).toBeGreaterThanOrEqual(0);
    expect(r.r2).toBeLessThanOrEqual(1);
  });

  it("produces no NaN or Infinity", () => {
    const series = [0, 0, 0, 0, 0, 0];
    const r = linearRegression(series);
    expect(isFinite(r.slope)).toBe(true);
    expect(isFinite(r.intercept)).toBe(true);
    expect(isFinite(r.r2)).toBe(true);
    expect(isFinite(r.residualStd)).toBe(true);
  });
});

// ── Math: predict ─────────────────────────────────────────────────────────────

describe("predict", () => {
  it("returns non-negative values for any x", () => {
    const reg = { slope: -100, intercept: 10, r2: 0.9, residualStd: 5 };
    expect(predict(reg, 100)).toBeGreaterThanOrEqual(0);
  });

  it("extrapolates correctly for growing series", () => {
    const series = [10, 20, 30, 40, 50, 60];
    const r = linearRegression(series);
    const next = predict(r, 6);
    expect(next).toBeCloseTo(70, 0);
  });
});

// ── Math: confidenceBounds ────────────────────────────────────────────────────

describe("confidenceBounds", () => {
  it("lower is always <= upper", () => {
    const reg = linearRegression([10, 20, 30, 40, 50]);
    const { lower, upper } = confidenceBounds(reg, 6, 5);
    expect(lower).toBeLessThanOrEqual(upper);
  });

  it("lower is >= 0", () => {
    const reg = linearRegression([5, 4, 3, 2, 1]);
    const { lower } = confidenceBounds(reg, 10, 5);
    expect(lower).toBeGreaterThanOrEqual(0);
  });

  it("bounds widen as x moves further from training range", () => {
    const reg = linearRegression([10, 12, 14, 16, 18, 20]);
    const { upper: u1 } = confidenceBounds(reg, 7, 6);
    const { upper: u2 } = confidenceBounds(reg, 20, 6);
    // Farther forecast = wider upper bound
    expect(u2).toBeGreaterThan(u1);
  });
});

// ── Math: descriptive statistics ──────────────────────────────────────────────

describe("mean", () => {
  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });

  it("computes correct mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe("standardDeviation", () => {
  it("returns 0 for single or empty", () => {
    expect(standardDeviation([])).toBe(0);
    expect(standardDeviation([42])).toBe(0);
  });

  it("computes population std correctly", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → std ≈ 2.0
    const std = standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(std).toBeCloseTo(2.0, 0);
  });

  it("returns 0 for constant series", () => {
    expect(standardDeviation([7, 7, 7, 7])).toBe(0);
  });
});

describe("zScores", () => {
  it("returns all zeros for constant series", () => {
    const zs = zScores([5, 5, 5, 5]);
    for (const z of zs) expect(z).toBe(0);
  });

  it("spike value produces high positive z-score", () => {
    const series = [10, 10, 10, 10, 10, 100];
    const zs = zScores(series);
    expect(zs[5]).toBeGreaterThan(2);
  });

  it("drop value produces high negative z-score", () => {
    const series = [100, 100, 100, 100, 100, 0];
    const zs = zScores(series);
    expect(zs[5]).toBeLessThan(-2);
  });

  it("produces no NaN", () => {
    const zs = zScores([0, 0, 0]);
    for (const z of zs) expect(isNaN(z)).toBe(false);
  });
});

describe("movingAverage", () => {
  it("first element equals itself", () => {
    const ma = movingAverage([10, 20, 30], 3);
    expect(ma[0]).toBe(10);
  });

  it("window of 1 returns original series", () => {
    const series = [1, 2, 3, 4, 5];
    const ma = movingAverage(series, 1);
    expect(ma).toEqual(series);
  });

  it("window of 3 smooths correctly", () => {
    const ma = movingAverage([1, 2, 3, 4, 5], 3);
    expect(ma[2]).toBeCloseTo(2, 5); // (1+2+3)/3
    expect(ma[4]).toBeCloseTo(4, 5); // (3+4+5)/3
  });
});

describe("regressionConfidence", () => {
  it("is always in [5, 90]", () => {
    for (const r2 of [0, 0.5, 1]) {
      for (const n of [1, 6, 12, 24, 100]) {
        const c = regressionConfidence(r2, n);
        expect(c).toBeGreaterThanOrEqual(5);
        expect(c).toBeLessThanOrEqual(90);
      }
    }
  });

  it("higher r2 produces higher confidence", () => {
    expect(regressionConfidence(0.9, 12)).toBeGreaterThan(regressionConfidence(0.2, 12));
  });

  it("more data points produce higher confidence", () => {
    expect(regressionConfidence(0.5, 24)).toBeGreaterThan(regressionConfidence(0.5, 6));
  });
});

// ── Sample guards ─────────────────────────────────────────────────────────────

describe("checkSample", () => {
  it("passes when sampleSize >= minimum", () => {
    const v = checkSample(20, 10);
    expect(v.dataSufficient).toBe(true);
    expect(v.insufficiencyReason).toBeNull();
  });

  it("fails when sampleSize < minimum", () => {
    const v = checkSample(3, 10);
    expect(v.dataSufficient).toBe(false);
    expect(v.insufficiencyReason).toContain("10");
  });

  it("confidence scales with ratio", () => {
    const half = checkSample(5, 10);
    const full = checkSample(10, 10);
    expect(full.confidence).toBeGreaterThanOrEqual(half.confidence);
  });
});

describe("checkRegressionReadiness", () => {
  it("passes series with 6 non-zero months", () => {
    const series = [0, 10, 20, 30, 40, 50, 0, 10, 20, 30, 40, 50];
    const v = checkRegressionReadiness(series, MIN_SAMPLES.MERCHANT_FORECAST);
    expect(v.dataSufficient).toBe(true);
  });

  it("fails series with only 2 non-zero months", () => {
    const series = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 20];
    const v = checkRegressionReadiness(series, MIN_SAMPLES.MERCHANT_FORECAST);
    expect(v.dataSufficient).toBe(false);
  });
});

describe("nonZeroMonths", () => {
  it("counts non-zero entries", () => {
    expect(nonZeroMonths([0, 1, 0, 2, 0, 3])).toBe(3);
    expect(nonZeroMonths([0, 0, 0])).toBe(0);
    expect(nonZeroMonths([])).toBe(0);
  });
});

describe("checkRateValidity", () => {
  it("fails with zero total", () => {
    const r = checkRateValidity(0, 0);
    expect(r.valid).toBe(false);
  });

  it("fails when too few terminal outcomes", () => {
    const r = checkRateValidity(3, 100, 10);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("terminal");
  });

  it("fails when >50% are still in transit", () => {
    const r = checkRateValidity(40, 100, 10);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("in transit");
  });

  it("passes when sufficient terminal outcomes and <50% in transit", () => {
    const r = checkRateValidity(70, 100, 10);
    expect(r.valid).toBe(true);
  });
});

describe("buildImpactRange", () => {
  it("low < expected < high", () => {
    const range = buildImpactRange(10000, 70, "test assumption");
    expect(range.estimatedLow).toBeLessThan(range.estimatedExpected);
    expect(range.estimatedExpected).toBeLessThan(range.estimatedHigh);
  });

  it("currency is always DZD", () => {
    const range = buildImpactRange(5000, 60, "assumption");
    expect(range.currency).toBe("DZD");
  });

  it("expected matches input (rounded)", () => {
    const range = buildImpactRange(12345, 50, "test");
    expect(range.estimatedExpected).toBe(12345);
  });
});

// ── Decision simulator input validation ───────────────────────────────────────

const baseMerchant: SimulatorMerchantData = {
  merchantId: "m1",
  merchantName: "Test Merchant",
  totalOrders: 100,
  totalShipments: 80,
  deliverySuccessRate: 0.65,
  codSuccessRate: 0.75,
  blockRate: 0.05,
  avgBasketDzd: 3000,
  grossRevenueDzd: 240000,
  topProvider: "Yalidine",
  topWilayas: [
    { wilaya: "Alger", orders: 40, successRate: 0.80, revenue: 96000 },
    { wilaya: "Oran", orders: 20, successRate: 0.50, revenue: 48000 },
    { wilaya: "Blida", orders: 15, successRate: 0.30, revenue: 36000 },
  ],
};

const baseProviders: SimulatorProviderData[] = [
  { provider: "Yalidine", deliverySuccessRate: 0.72, totalShipments: 500 },
  { provider: "Guepex",   deliverySuccessRate: 0.55, totalShipments: 200 },
  { provider: "ZR Express", deliverySuccessRate: 0.80, totalShipments: 300 },
];

const baseWilayas: SimulatorWilayaData[] = [
  { wilaya: "Alger", deliverySuccessRate: 0.80, totalShipments: 500, avgCodAmountDzd: 3500 },
];

describe("simulateDecision — switch_provider", () => {
  it("switching to better provider improves delivery rate", () => {
    const scenario: SimulationScenario = {
      type: "switch_provider",
      label: "Switch to ZR Express",
      params: { targetProvider: "ZR Express" },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(result.after.deliverySuccessRate).toBeGreaterThanOrEqual(result.before.deliverySuccessRate);
    expect(result.recommendation).toBe("proceed");
  });

  it("switching to worse provider is avoided", () => {
    const scenario: SimulationScenario = {
      type: "switch_provider",
      label: "Switch to Guepex",
      params: { targetProvider: "Guepex" },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(result.recommendation).toBe("avoid");
  });

  it("unknown provider returns avoid with confidence 0", () => {
    const scenario: SimulationScenario = {
      type: "switch_provider",
      label: "Switch to unknown",
      params: { targetProvider: "NonExistentProvider" },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(result.recommendation).toBe("avoid");
    expect(result.confidence).toBe(0);
  });
});

describe("simulateDecision — remove_worst_wilaya", () => {
  it("removes worst wilaya and returns result", () => {
    const scenario: SimulationScenario = {
      type: "remove_worst_wilaya",
      label: "Remove Blida",
      params: { worstWilayaName: "Blida" },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    // Removing a 30% success wilaya should improve overall delivery rate
    expect(result.after.deliverySuccessRate).toBeGreaterThan(result.before.deliverySuccessRate);
    expect(result.delta.deliverySuccessRate).toBeGreaterThan(0);
  });
});

describe("simulateDecision — focus_top_wilayas", () => {
  it("focusing on top wilayas improves delivery rate", () => {
    const scenario: SimulationScenario = {
      type: "focus_top_wilayas",
      label: "Focus on top 1",
      params: { topWilayaCount: 1 },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(result.after.deliverySuccessRate).toBeGreaterThanOrEqual(result.before.deliverySuccessRate);
  });
});

describe("simulateDecision — price changes", () => {
  it("increase_price raises monthly revenue per order but may reduce volume", () => {
    const scenario: SimulationScenario = {
      type: "increase_price",
      label: "Increase 8%",
      params: { priceChangePct: 0.08 },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(result.before).toBeDefined();
    expect(result.after).toBeDefined();
    expect(result.delta).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("delta metrics are computed as after minus before", () => {
    const scenario: SimulationScenario = {
      type: "decrease_price",
      label: "Decrease 8%",
      params: { priceChangePct: -0.08 },
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(result.delta.deliverySuccessRate).toBeCloseTo(
      result.after.deliverySuccessRate - result.before.deliverySuccessRate,
      5,
    );
  });
});

describe("simulateDecision — confirmation calls", () => {
  it("returns a valid result with recommendation", () => {
    const scenario: SimulationScenario = {
      type: "require_confirmation_calls",
      label: "Enable calls",
      params: {},
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    expect(["proceed", "caution", "avoid"]).toContain(result.recommendation);
    expect(result.after.codRefusalRate).toBeLessThan(result.before.codRefusalRate);
  });
});

describe("simulateDecision — pause advertising bad wilayas", () => {
  it("detects bad wilayas and reduces volume while improving quality", () => {
    const scenario: SimulationScenario = {
      type: "pause_advertising_bad_wilayas",
      label: "Pause bad wilayas",
      params: {},
    };
    const result = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    // Blida has 30% success rate < 40% threshold → should be removed
    expect(result.after.deliverySuccessRate).toBeGreaterThanOrEqual(result.before.deliverySuccessRate);
  });
});

describe("simulateDecision — rate clamping", () => {
  it("all rates stay in [0, 1]", () => {
    for (const type of [
      "switch_provider",
      "remove_worst_wilaya",
      "focus_top_wilayas",
      "increase_price",
      "decrease_price",
      "require_confirmation_calls",
      "pause_advertising_bad_wilayas",
    ] as const) {
      const scenario: SimulationScenario = { type, label: type, params: { targetProvider: "ZR Express", priceChangePct: 0.08 } };
      const r = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);

      for (const key of ["deliverySuccessRate", "returnRate", "codRefusalRate", "blockRate"] as const) {
        expect(r.before[key]).toBeGreaterThanOrEqual(0);
        expect(r.before[key]).toBeLessThanOrEqual(1);
        expect(r.after[key]).toBeGreaterThanOrEqual(0);
        expect(r.after[key]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("no NaN or Infinity in any output", () => {
    const scenario: SimulationScenario = {
      type: "switch_provider",
      label: "test",
      params: { targetProvider: "ZR Express" },
    };
    const r = simulateDecision(baseMerchant, baseProviders, baseWilayas, scenario);
    const numericFields = [
      r.before.deliverySuccessRate, r.before.returnRate, r.before.codRefusalRate,
      r.after.deliverySuccessRate, r.after.returnRate, r.after.codRefusalRate,
      r.after.estimatedMonthlyOrdersDzd, r.after.estimatedMonthlyCollectedDzd,
      r.confidence,
    ];
    for (const v of numericFields) {
      expect(isNaN(v)).toBe(false);
      expect(isFinite(v)).toBe(true);
    }
  });
});

describe("simulateDecision — empty merchant", () => {
  it("handles merchant with no wilayas without crashing", () => {
    const emptyMerchant: SimulatorMerchantData = {
      ...baseMerchant,
      totalOrders: 0,
      totalShipments: 0,
      topWilayas: [],
    };
    const scenario: SimulationScenario = {
      type: "remove_worst_wilaya",
      label: "no wilayas",
      params: {},
    };
    expect(() =>
      simulateDecision(emptyMerchant, baseProviders, baseWilayas, scenario)
    ).not.toThrow();
  });

  it("handles no providers without crashing", () => {
    const scenario: SimulationScenario = {
      type: "switch_provider",
      label: "no providers",
      params: { targetProvider: "ZR Express" },
    };
    expect(() =>
      simulateDecision(baseMerchant, [], baseWilayas, scenario)
    ).not.toThrow();
  });
});

// ── Anomaly detection: spike/drop fixtures ────────────────────────────────────

describe("zScores — anomaly fixtures", () => {
  it("stable series has no z > 1.5", () => {
    // Alternating ±10 around 100 — std=10, so max |z|=1.0, safely below 1.5 threshold
    const stable = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110, 90, 110];
    const zs = zScores(stable);
    const hasAnomaly = zs.some((z) => Math.abs(z) > 1.5);
    expect(hasAnomaly).toBe(false);
  });

  it("spike series has at least one z > 1.5", () => {
    const spike = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 500];
    const zs = zScores(spike);
    const hasAnomaly = zs.some((z) => Math.abs(z) > 1.5);
    expect(hasAnomaly).toBe(true);
  });

  it("drop series has at least one z < -1.5", () => {
    const drop = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 10];
    const zs = zScores(drop);
    const hasAnomaly = zs.some((z) => z < -1.5);
    expect(hasAnomaly).toBe(true);
  });

  it("high-volatility series with all zeros produces no NaN z-scores", () => {
    const allZero = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const zs = zScores(allZero);
    for (const z of zs) expect(isNaN(z)).toBe(false);
  });
});

// ── Forecast direction: growing / declining / stable ─────────────────────────

describe("linearRegression — directional fixtures", () => {
  it("growing series has positive slope", () => {
    const growing = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105];
    expect(linearRegression(growing).slope).toBeGreaterThan(0);
  });

  it("declining series has negative slope", () => {
    const declining = [105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50];
    expect(linearRegression(declining).slope).toBeLessThan(0);
  });

  it("stable series has slope near 0", () => {
    const stable = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100, 100];
    expect(Math.abs(linearRegression(stable).slope)).toBeLessThan(5);
  });
});
