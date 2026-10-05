/**
 * The crowd's forecast of one epoch's Solana Fee Index from the YES prices of Epoch's Panta markets on it (one market
 * per strike: "will the index close above K?"). Pure maths, informational only:
 *
 * 1. Implied probability per strike: P(index > K) = YES / (YES + NO) (the plain YES price when NO is missing).
 * 2. A monotonic fit across strikes: P(index > K) cannot rise with K, so prices that disagree are pooled
 *    (weighted pool-adjacent-violators; weights grow with each market's volume).
 * 3. A lognormal through the fitted points: with two or more strikes, a weighted least-squares line of
 *    Φ⁻¹(1 − p) on ln K gives μ and σ; with one strike (or a flat fit), σ comes from the index's own recent log changes
 *    and μ from the price. Then median = e^μ, expected value = e^(μ + σ²/2), and an 80% band e^(μ ± 1.2816σ).
 */

export interface StrikeQuote {
  /** µL/CU. */
  strike: number;
  /** 0–1, null when Panta has no live price. */
  yesPrice: number | null;
  noPrice: number | null;
  /** USDC traded, for the weights; 0 when unknown. */
  volumeUsdc: number;
}

export type ForecastMethod = 'lognormal-fit' | 'lognormal-history-sigma';

export interface StrikePoint {
  strike: number;
  /** From the prices; null without a price. */
  implied: number | null;
  /** The monotonic fit (non-increasing in the strike); null without a price. */
  fitted: number | null;
  /** The lognormal at this strike; null without a forecast. */
  curve: number | null;
}

export interface CrowdForecast {
  points: StrikePoint[];
  fit: { method: ForecastMethod; mu: number; sigma: number; strikesUsed: number } | null;
  /** µL/CU, rounded. */
  median: number | null;
  mean: number | null;
  band: { low: number; high: number; coverage: 0.8 } | null;
  /** Why there is no forecast, when there is none. */
  reason: string | null;
}

/** Probabilities are clamped here before Φ⁻¹: a price of 0 or 1 says "certain", which no strike line can fit. */
const P_MIN = 0.02;
const P_MAX = 0.98;
/** Φ⁻¹(0.9): the 80% band. */
const Z_80 = 1.2815515655446004;
/** σ of ln(index) per epoch when the history is too short to measure it. */
const DEFAULT_SIGMA = 0.35;
const SIGMA_MIN = 0.02;
const SIGMA_MAX = 3;

/** P(index > K) from a market's prices: YES / (YES + NO), which removes the overround; YES alone when NO is missing. */
export function impliedProbability(yes: number | null, no: number | null): number | null {
  const valid = (price: number | null): price is number => price !== null && Number.isFinite(price) && price >= 0;
  if (!valid(yes) || yes > 1) return null;
  if (valid(no) && no <= 1 && yes + no > 0) return yes / (yes + no);
  return yes;
}

/** Weighted pool-adjacent-violators: the closest non-increasing sequence to `values` (in the given order). */
export function nonIncreasingFit(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: { mean: number; weight: number; size: number }[] = [];
  values.forEach((value, i) => {
    blocks.push({ mean: value, weight: weights[i], size: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].mean < blocks[blocks.length - 1].mean) {
      const last = blocks.pop() as { mean: number; weight: number; size: number };
      const prev = blocks[blocks.length - 1];
      const weight = prev.weight + last.weight;
      prev.mean = (prev.mean * prev.weight + last.mean * last.weight) / weight;
      prev.weight = weight;
      prev.size += last.size;
    }
  });
  return blocks.flatMap((block) => Array.from({ length: block.size }, () => block.mean));
}

/** Φ⁻¹(p), the standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - low) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Φ(z), the standard normal CDF (Zelen & Severo / Abramowitz–Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const density = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  const tail =
    density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/**
 * σ of ln(index) over `horizon` epochs from the history (values NEWEST FIRST): the standard deviation of the log
 * changes between consecutive epochs, times √horizon. Too short a history: a wide default.
 */
export function historySigma(values: readonly number[], horizon = 1): number {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  const changes: number[] = [];
  for (let i = 0; i + 1 < positive.length; i++) changes.push(Math.log(positive[i] / positive[i + 1]));
  let sigma = DEFAULT_SIGMA;
  if (changes.length >= 3) {
    const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
    const variance = changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (changes.length - 1);
    sigma = Math.sqrt(variance);
  }
  const scaled = sigma * Math.sqrt(Math.min(4, Math.max(1, horizon)));
  return clamp(scaled, 0.05, 1.5);
}

/**
 * The forecast from the strikes' quotes (any order) and the index history (values newest first; used for σ when the
 * strikes cannot give it). `horizon`: epochs between the newest known value and the forecast epoch.
 */
export function crowdForecast(quotes: readonly StrikeQuote[], history: readonly number[], horizon = 1): CrowdForecast {
  const sorted = [...quotes].filter((quote) => Number.isFinite(quote.strike) && quote.strike > 0);
  sorted.sort((a, b) => a.strike - b.strike);
  const implied = sorted.map((quote) => impliedProbability(quote.yesPrice, quote.noPrice));
  const priced = sorted.map((quote, i) => ({ quote, implied: implied[i] })).filter((row) => row.implied !== null);
  const weights = priced.map((row) => 1 + Math.log1p(Math.max(0, row.quote.volumeUsdc)));
  const fitted = nonIncreasingFit(
    priced.map((row) => row.implied as number),
    weights,
  );
  const fittedByStrike = new Map(priced.map((row, i) => [row.quote.strike, fitted[i]]));

  const empty = (reason: string): CrowdForecast => ({
    points: sorted.map((quote, i) => ({
      strike: quote.strike,
      implied: roundP(implied[i]),
      fitted: roundP(fittedByStrike.get(quote.strike) ?? null),
      curve: null,
    })),
    fit: null,
    median: null,
    mean: null,
    band: null,
    reason,
  });
  if (sorted.length === 0) return empty('no markets on this epoch yet');
  if (priced.length === 0) return empty('no live prices yet');

  const xs = priced.map((row) => Math.log(row.quote.strike));
  const zs = fitted.map((p) => normInv(1 - clamp(p, P_MIN, P_MAX)));
  let fit: { method: ForecastMethod; mu: number; sigma: number } | null = null;
  if (new Set(xs).size >= 2) {
    const w = weights;
    const sw = w.reduce((sum, value) => sum + value, 0);
    const mx = xs.reduce((sum, x, i) => sum + w[i] * x, 0) / sw;
    const mz = zs.reduce((sum, z, i) => sum + w[i] * z, 0) / sw;
    const sxx = xs.reduce((sum, x, i) => sum + w[i] * (x - mx) ** 2, 0);
    const sxz = xs.reduce((sum, x, i) => sum + w[i] * (x - mx) * (zs[i] - mz), 0);
    const slope = sxz / sxx;
    if (Number.isFinite(slope) && slope > 1e-9) {
      const sigma = clamp(1 / slope, SIGMA_MIN, SIGMA_MAX);
      fit = { method: 'lognormal-fit', mu: mx - sigma * mz, sigma };
    }
  }
  if (!fit) {
    const sigma = historySigma(history, horizon);
    const sw = weights.reduce((sum, value) => sum + value, 0);
    const mu = xs.reduce((sum, x, i) => sum + weights[i] * (x - sigma * zs[i]), 0) / sw;
    fit = { method: 'lognormal-history-sigma', mu, sigma };
  }

  const { mu, sigma } = fit;
  return {
    points: sorted.map((quote, i) => ({
      strike: quote.strike,
      implied: roundP(implied[i]),
      fitted: roundP(fittedByStrike.get(quote.strike) ?? null),
      curve: roundP(1 - normCdf((Math.log(quote.strike) - mu) / sigma)),
    })),
    fit: { ...fit, mu: round(mu, 6), sigma: round(sigma, 6), strikesUsed: priced.length },
    median: Math.round(Math.exp(mu)),
    mean: Math.round(Math.exp(mu + (sigma * sigma) / 2)),
    band: {
      low: Math.round(Math.exp(mu - Z_80 * sigma)),
      high: Math.round(Math.exp(mu + Z_80 * sigma)),
      coverage: 0.8,
    },
    reason: null,
  };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const roundP = (value: number | null): number | null => (value === null ? null : round(value, 4));
