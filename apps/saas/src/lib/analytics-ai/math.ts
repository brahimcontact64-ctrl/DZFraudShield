// Statistical utilities for the Analytics AI module.
// Pure functions, no external dependencies.

export type Regression = {
  slope: number;
  intercept: number;
  r2: number;
  residualStd: number;
};

// ── Linear regression (ordinary least squares) ────────────────────────────────

export function linearRegression(values: number[]): Regression {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0, residualStd: 0 };

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;

  let ssXY = 0;
  let ssXX = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = values[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssTot += dy * dy;
  }

  const slope = ssXX !== 0 ? ssXY / ssXX : 0;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (values[i] - (slope * i + intercept)) ** 2;
  }

  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const residualStd = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;

  return { slope, intercept, r2, residualStd };
}

// ── Point prediction ──────────────────────────────────────────────────────────

export function predict(reg: Regression, x: number): number {
  return Math.max(0, reg.slope * x + reg.intercept);
}

// 80% CI bounds
export function confidenceBounds(
  reg: Regression,
  x: number,
  n: number,
): { lower: number; upper: number } {
  if (reg.residualStd === 0) {
    const p = predict(reg, x);
    return { lower: p, upper: p };
  }
  const leverage = 1 + Math.abs(x - (n - 1) / 2) / Math.max(1, n);
  const margin = reg.residualStd * 1.28 * leverage;
  const p = predict(reg, x);
  return { lower: Math.max(0, p - margin), upper: p + margin };
}

// ── Descriptive statistics ────────────────────────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

export function zScores(values: number[]): number[] {
  const m = mean(values);
  const std = standardDeviation(values);
  if (std === 0) return values.map(() => 0);
  return values.map((v) => (v - m) / std);
}

export function movingAverage(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    return mean(values.slice(start, i + 1));
  });
}

// ── Confidence from regression quality ───────────────────────────────────────

export function regressionConfidence(r2: number, n: number): number {
  const r2Score = r2 * 60;
  const nScore = Math.min(40, (n / 24) * 40);
  return Math.round(Math.max(5, Math.min(90, r2Score + nScore)));
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(month: number, year: number): string {
  return `${MONTH_NAMES[(month - 1) % 12]} ${year}`;
}

// Given that index 11 = current month, compute {month, year} for each index
export function indexToCalendar(
  index: number,
  now: Date,
): { month: number; year: number; label: string } {
  const monthsAgo = 11 - index;
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  return { month, year, label: monthLabel(month, year) };
}

// Forecast: index 12 = next month, 13 = month after, etc.
export function forecastIndexToCalendar(
  index: number,
  now: Date,
): { month: number; year: number; label: string } {
  const monthsAhead = index - 11;
  const d = new Date(now.getFullYear(), now.getMonth() + monthsAhead, 1);
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  return { month, year, label: monthLabel(month, year) };
}

export { MONTH_NAMES };
