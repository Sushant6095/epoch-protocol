/**
 * Market thresholds from the index's own history (µL/CU). One market per epoch (the default, since every creation
 * costs a quoted USDC fee): the last finished epoch's value, rounded, so the market asks "will fees be higher than
 * last time?", close to an even bet. More markets per epoch form a ladder at evenly spaced quantiles of recent epochs.
 */

/** A round number near `value`: steps of 1 below 100, 10 below 1,000, 50 below 10,000, 500 above. */
export function roundThreshold(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const step = value < 100 ? 1 : value < 1_000 ? 10 : value < 10_000 ? 50 : 500;
  return Math.round(value / step) * step;
}

/** Linear-interpolated quantile of a sample (q in [0, 1]). */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Thresholds for one epoch, ascending, without duplicates. `history`: finished epochs' values, NEWEST FIRST (the
 * lookback is applied by the caller). Empty history: no markets.
 */
export function ladderThresholds(history: readonly number[], count: number): number[] {
  const sample = history.filter((value) => Number.isFinite(value) && value >= 0);
  if (sample.length === 0 || count < 1) return [];
  if (count === 1) return [roundThreshold(sample[0])];
  const levels = Array.from({ length: count }, (_, i) => roundThreshold(quantile(sample, (i + 1) / (count + 1))));
  return [...new Set(levels)].sort((a, b) => a - b);
}
