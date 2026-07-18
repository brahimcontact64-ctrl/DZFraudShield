// Confidence score calculation for the Recommendation Engine.
// Confidence is derived from data quality, never hardcoded.
//
// Formula:
//   sampleScore  = min(60, sampleSize / FULL_SAMPLE × 60)  — rewards larger samples
//   signalScore  = signalStrength × 40                      — rewards clear signals
//   confidence   = clamp(5, 98, sampleScore + signalScore)

const FULL_SAMPLE = 200; // sample size that yields max sampleScore

/**
 * Calculate confidence score (0–100).
 *
 * @param sampleSize     Number of orders, shipments, or items used as evidence.
 * @param signalStrength 0–1 expressing how extreme the metric is.
 *                       0 = borderline, 1 = extremely clear.
 */
export function calculateConfidence(
  sampleSize: number,
  signalStrength: number,
): number {
  const sampleScore = Math.min(60, (sampleSize / FULL_SAMPLE) * 60);
  const signalScore = Math.max(0, Math.min(1, signalStrength)) * 40;
  return Math.round(Math.max(5, Math.min(98, sampleScore + signalScore)));
}

/**
 * Compute signal strength for a rate-based metric.
 *
 * Examples:
 *   rate=0.95 with threshold=0.72 → strong "high" signal (signal ≈ 1.0)
 *   rate=0.55 with threshold=0.72 → weak signal (signal ≈ 0.3)
 *   rate=0.10 with threshold=0.38 → strong "low" signal (signal ≈ 1.0)
 *
 * @param rate         Observed metric value (0–1).
 * @param goodThreshold Rate above which signal is "good".
 * @param badThreshold  Rate below which signal is "bad".
 */
export function rateSignalStrength(
  rate: number,
  goodThreshold: number,
  badThreshold: number,
): number {
  if (rate >= goodThreshold) {
    // How far above the good threshold? Normalise to 0–1.
    return Math.min(1, (rate - goodThreshold) / (1 - goodThreshold));
  }
  if (rate <= badThreshold) {
    // How far below the bad threshold? Normalise to 0–1.
    return Math.min(1, (badThreshold - rate) / badThreshold);
  }
  // In between: weak signal.
  const range = goodThreshold - badThreshold;
  const midpoint = (goodThreshold + badThreshold) / 2;
  return Math.max(0, Math.min(0.4, Math.abs(rate - midpoint) / (range / 2) * 0.4));
}

/**
 * Compute signal strength for a growth rate.
 * Returns how extreme the growth/decline is on a 0–1 scale.
 *
 * @param growthRate  Fractional growth (e.g. 0.25 = +25%, -0.4 = -40%)
 * @param threshold   Minimum absolute magnitude to start yielding signal (default 0.2 = 20%)
 */
export function growthSignalStrength(
  growthRate: number,
  threshold = 0.2,
): number {
  const abs = Math.abs(growthRate);
  if (abs < threshold) return 0.1;
  return Math.min(1, (abs - threshold) / (1 - threshold));
}
