/**
 * Strikes (market thresholds, µL/CU) from the index's own recent FINAL values. Each strike is one Panta market, and
 * every market costs a quoted USDC creation fee, so the default is one strike: the median of the last 10 final values,
 * close to an even bet. More strikes form a ladder 20 percentage points apart around the median (3: p30 / p50 / p70,
 * 5: p10 … p90), whose prices together give the crowd's forecast of the epoch's index (api_app `forecast`).
 */

/** The rounding step for a value: 1 below 100, 10 below 1,000, 50 below 10,000, 500 above. */
export function roundingStep(value: number): number {
  return value < 100 ? 1 : value < 1_000 ? 10 : value < 10_000 ? 50 : 500;
}

/** A round number near `value` (see `roundingStep`). */
export function roundThreshold(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const step = roundingStep(value);
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

/** The quantile levels of a `count`-strike ladder: 0.2 apart, centred on the median. */
export function strikeQuantiles(count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round((0.5 + 0.2 * (i - (count - 1) / 2)) * 100) / 100);
}

/**
 * Strikes for one epoch, ascending and distinct. `sample`: recent final values, NEWEST FIRST (the lookback is applied
 * by the caller). When two quantiles round to the same number (a calm stretch), the upper strike moves up one rounding
 * step, so the ladder always has `count` strikes. An empty sample gives none.
 */
export function strikeLadder(sample: readonly number[], count: number): number[] {
  const values = sample.filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0 || count < 1) return [];
  const strikes = strikeQuantiles(count).map((q) => roundThreshold(quantile(values, q)));
  for (let i = 1; i < strikes.length; i++) {
    if (strikes[i] <= strikes[i - 1]) strikes[i] = strikes[i - 1] + roundingStep(strikes[i - 1]);
  }
  return strikes;
}

/**
 * Creation order inside one epoch when the daily fee budget cannot pay for every strike: the middle strike first (the
 * most informative market on its own), then outwards.
 */
export function byCentrality<T extends { threshold: number }>(rows: readonly T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.threshold - b.threshold);
  const middle = (sorted.length - 1) / 2;
  return sorted
    .map((row, i) => ({ row, distance: Math.abs(i - middle), i }))
    .sort((a, b) => a.distance - b.distance || a.i - b.i)
    .map(({ row }) => row);
}
