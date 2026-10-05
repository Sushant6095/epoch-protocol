/**
 * OHLC candles for the Launch chart from trades (and, between trades, price samples). Pure: the API reads the points
 * from Postgres and calls `buildCandles`.
 */

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

/** Most candles one call returns. */
export const MAX_CANDLES = 1_000;

/** A price observation: a trade (with its SOL volume) or a sample (volume 0). */
export interface PricePoint {
  /** Unix seconds. */
  t: number;
  priceSol: number;
  /** SOL traded; 0 or omitted for a price sample. */
  volumeSol?: number;
  /** Counted as a trade (samples are not). Default: volumeSol > 0. */
  trade?: boolean;
}

export interface Candle {
  /** Bucket start, unix seconds (UTC-aligned). */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  trades: number;
}

export interface BuildCandlesOptions {
  /** First bucket to return (unix seconds, rounded down to the interval). Default: the first point's bucket. */
  from?: number;
  /** Last bucket to return (unix seconds). Default: the last point's bucket. */
  to?: number;
  /**
   * Emit a flat candle (open = high = low = close = the previous close, no volume) for every empty bucket after the
   * first point, so the chart's time axis has no gaps. Default true.
   */
  fill?: boolean;
  /** Price before `from` (the last close earlier than the range), to fill the leading buckets. */
  previousClose?: number | null;
  maxCandles?: number;
}

/**
 * Fills the gaps between sparse candles (e.g. aggregated in SQL) with flat ones at the previous close, from `from` to
 * `to` (bucket starts, unix seconds). Candles must be on the interval's grid; at most `maxCandles`, the newest.
 */
export function fillCandles(
  candles: readonly Candle[],
  interval: CandleInterval,
  options: { from: number; to: number; previousClose?: number | null; maxCandles?: number },
): Candle[] {
  const step = CANDLE_INTERVAL_SECONDS[interval];
  const max = Math.min(options.maxCandles ?? MAX_CANDLES, MAX_CANDLES);
  const from = Math.floor(options.from / step) * step;
  const to = Math.floor(options.to / step) * step;
  if (to < from) return [];
  const byBucket = new Map(candles.map((candle) => [candle.t, candle]));
  const firstBucket = Math.max(from, to - (max - 1) * step);
  let lastClose = options.previousClose ?? null;
  for (const candle of [...candles].sort((a, b) => a.t - b.t)) {
    if (candle.t < firstBucket) lastClose = candle.close;
  }
  const out: Candle[] = [];
  for (let t = firstBucket; t <= to; t += step) {
    const candle = byBucket.get(t);
    if (candle) {
      out.push(candle);
      lastClose = candle.close;
    } else if (lastClose !== null) {
      out.push({ t, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volumeSol: 0, trades: 0 });
    }
  }
  return out;
}

/**
 * Buckets points into candles of `interval`. Points need not be sorted. Within a bucket the open is the earliest point,
 * the close the latest (ties keep input order). Returns at most `maxCandles` candles, the newest ones.
 */
export function buildCandles(
  points: readonly PricePoint[],
  interval: CandleInterval,
  options: BuildCandlesOptions = {},
): Candle[] {
  const step = CANDLE_INTERVAL_SECONDS[interval];
  if (!step) throw new RangeError(`unknown candle interval ${interval}`);
  const max = Math.min(options.maxCandles ?? MAX_CANDLES, MAX_CANDLES);
  const bucketOf = (t: number) => Math.floor(t / step) * step;
  const valid = points
    .map((point, order) => ({ ...point, order }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.priceSol) && point.priceSol > 0)
    .sort((a, b) => a.t - b.t || a.order - b.order);
  const from = options.from !== undefined ? bucketOf(options.from) : valid.length ? bucketOf(valid[0].t) : null;
  const to =
    options.to !== undefined ? bucketOf(options.to) : valid.length ? bucketOf(valid[valid.length - 1].t) : null;
  if (from === null || to === null || to < from) return [];

  const buckets = new Map<number, Candle>();
  for (const point of valid) {
    const t = bucketOf(point.t);
    if (t < from || t > to) continue;
    const volume = point.volumeSol ?? 0;
    const isTrade = point.trade ?? volume > 0;
    const candle = buckets.get(t);
    if (!candle) {
      buckets.set(t, {
        t,
        open: point.priceSol,
        high: point.priceSol,
        low: point.priceSol,
        close: point.priceSol,
        volumeSol: volume,
        trades: isTrade ? 1 : 0,
      });
    } else {
      candle.high = Math.max(candle.high, point.priceSol);
      candle.low = Math.min(candle.low, point.priceSol);
      candle.close = point.priceSol;
      candle.volumeSol += volume;
      if (isTrade) candle.trades += 1;
    }
  }

  const fill = options.fill ?? true;
  const candles: Candle[] = [];
  let lastClose = options.previousClose ?? null;
  // Walk only the newest `max` buckets (the range can be long); the close before them comes from earlier points.
  const firstBucket = Math.max(from, to - (max - 1) * step);
  if (fill) {
    for (const point of valid) {
      if (bucketOf(point.t) < firstBucket) lastClose = point.priceSol;
      else break;
    }
  }
  for (let t = firstBucket; t <= to; t += step) {
    const candle = buckets.get(t);
    if (candle) {
      candles.push(candle);
      lastClose = candle.close;
    } else if (fill && lastClose !== null) {
      candles.push({ t, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volumeSol: 0, trades: 0 });
    }
  }
  return candles;
}
