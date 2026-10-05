import { ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';

import { KeyedSnapshotCache } from '../../Lib/KeyedSnapshotCache';
import { SnapshotCache } from '../../Lib/SnapshotCache';
import {
  type BinanceKlinesSource,
  type CoinGeckoSource,
  type FrankfurterSource,
  type InrPoint,
  SourceRateLimitedError,
} from '../../Sources/IndiaPriceSources';

const logger = Logger.create('InrPrice');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A live price is re-read after a minute. */
export const LIVE_TTL_MS = MINUTE;
/** CoinGecko updates SOL every minute or so: a quote older than this is the source standing still, not live. */
const SOURCE_STALE_MS = 15 * MINUTE;
/** The fallback's SOL/USD comes from MarketData's one-minute Jupiter cache; older than this is not live. */
const FALLBACK_STALE_MS = 5 * MINUTE;
/** After every source failed, wait this long before trying again (the last price is served, marked stale). */
const FAILURE_BACKOFF_MS = 15 * SECOND;
/** A daily price further than this from the moment asked for is not used. */
const MAX_POINT_DISTANCE_MS = 36 * HOUR;

export const SOURCE_COINGECKO = 'CoinGecko';
export const SOURCE_FALLBACK_LIVE = 'Jupiter SOL/USD × open.er-api USD/INR';
export const SOURCE_FALLBACK_HISTORY = 'Binance SOL/USDT × ECB USD/INR';

export interface LivePrice {
  /** Rupees per SOL. */
  inr: number;
  usd: number | null;
  /** Rupees per dollar behind the quote (CoinGecko's INR ÷ USD, or the FX rate of the fallback). */
  usdInr: number | null;
  change24hPct: number | null;
  source: string;
  /** When the source set this price (CoinGecko's `last_updated_at`, or when Jupiter was read). */
  observedAtMs: number;
  /** When Epoch read it. */
  fetchedAtMs: number;
  /** True when this is not a live price: the sources are down or standing still. Never shown as live. */
  stale: boolean;
  staleReason: string | null;
}

/** A daily SOL/INR price and where it came from. */
export interface PricedPoint extends InrPoint {
  source: string;
}

export interface FallbackQuote {
  value: number;
  /** When the value was read (epoch ms). */
  loadedAtMs: number;
}

export interface InrPriceDeps {
  coingecko: Pick<CoinGeckoSource, 'solInr' | 'solInrDaily'>;
  /** Live fallback: SOL/USD (Jupiter) and USD/INR, from MarketData's caches. */
  solUsd: () => Promise<FallbackQuote>;
  usdInr: () => Promise<FallbackQuote>;
  /** History fallback for days CoinGecko cannot serve. */
  usdHistory: Pick<BinanceKlinesSource, 'solUsdDaily'>;
  fxHistory: Pick<FrankfurterSource, 'usdInrDaily'>;
  now?: () => number;
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Daily SOL/INR prices sorted by time; `at` answers the nearest one within 36 hours. */
export class PriceBook {
  readonly points: PricedPoint[];

  constructor(points: readonly PricedPoint[]) {
    this.points = [...points].sort((a, b) => a.ms - b.ms);
  }

  /** The price nearest to `ms` (ties: the earlier one); null when none is within 36 hours. */
  at(ms: number): PricedPoint | null {
    const list = this.points;
    // The first point at or after `ms`; the one before it is the other candidate.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid].ms < ms) low = mid + 1;
      else high = mid;
    }
    let best: PricedPoint | null = null;
    for (const candidate of [list[low - 1], list[low]]) {
      if (candidate && (!best || Math.abs(candidate.ms - ms) < Math.abs(best.ms - ms))) best = candidate;
    }
    return best && Math.abs(best.ms - ms) <= MAX_POINT_DISTANCE_MS ? best : null;
  }

  get sources(): string[] {
    return [...new Set(this.points.map((p) => p.source))];
  }
}

/**
 * SOL in rupees. Live: CoinGecko `simple/price` (INR), else Jupiter SOL/USD × USD/INR, re-read once a minute; when
 * every source fails the last price is served with `stale: true`. History: CoinGecko's daily SOL/INR for the last 365
 * days (re-read hourly), and for older days, or while CoinGecko is down, Binance's daily SOL/USDT open × the ECB's
 * USD/INR rate of that day (or the business day before). A CoinGecko HTTP 429 pauses CoinGecko until its reset.
 */
export class InrPriceService {
  private last?: LivePrice;
  private inflight?: Promise<LivePrice>;
  private failedAtMs = 0;
  private lastErrors: string[] = [];
  private coingeckoPausedUntil = 0;
  private readonly daily: SnapshotCache<InrPoint[]>;
  private readonly fallbackDaily: KeyedSnapshotCache<PricedPoint[]>;
  private readonly now: () => number;

  constructor(private readonly deps: InrPriceDeps) {
    this.now = deps.now ?? Date.now;
    this.daily = new SnapshotCache(
      'solInrDaily',
      HOUR,
      () => this.coingecko(() => deps.coingecko.solInrDaily(365)),
      2 * DAY,
      this.now,
    );
    this.fallbackDaily = new KeyedSnapshotCache(
      'solInrFallbackDaily',
      24,
      6 * HOUR,
      (key) => this.loadFallback(key),
      2 * DAY,
      this.now,
    );
  }

  // ── Live ─────────────────────────────────────────────────────────────────────────────────────

  /** The live price; 503 PRICE_UNAVAILABLE only when no source has ever answered. */
  async live(): Promise<LivePrice> {
    const now = this.now();
    if (this.last && now - this.last.fetchedAtMs < LIVE_TTL_MS) return this.last;
    if (this.last && now - this.failedAtMs < FAILURE_BACKOFF_MS) return this.staleCopy(this.last);
    this.inflight ??= this.readLive().finally(() => {
      this.inflight = undefined;
    });
    try {
      this.last = await this.inflight;
      return this.last;
    } catch {
      this.failedAtMs = this.now();
      if (this.last) return this.staleCopy(this.last);
      throw new ServiceUnavailableException('The SOL/INR price is unavailable right now', 'PRICE_UNAVAILABLE', {
        errors: this.lastErrors,
        retryAfterSeconds: Math.ceil(FAILURE_BACKOFF_MS / SECOND),
      });
    }
  }

  private staleCopy(last: LivePrice): LivePrice {
    return {
      ...last,
      stale: true,
      staleReason: last.staleReason ?? `price sources unavailable since ${new Date(this.failedAtMs).toISOString()}`,
    };
  }

  /** CoinGecko first; the fallback when CoinGecko fails or stands still; the newer of the two if both are stale. */
  private async readLive(): Promise<LivePrice> {
    const errors: string[] = [];
    let primary: LivePrice | undefined;
    try {
      primary = await this.fromCoinGecko();
      if (!primary.stale) return primary;
    } catch (error) {
      errors.push(`CoinGecko: ${String(error)}`);
    }
    let fallback: LivePrice | undefined;
    try {
      fallback = await this.fromFallback();
      if (!fallback.stale) return fallback;
    } catch (error) {
      errors.push(`fallback: ${String(error)}`);
    }
    const newest = [primary, fallback]
      .filter((p): p is LivePrice => p !== undefined)
      .sort((a, b) => b.observedAtMs - a.observedAtMs)[0];
    if (newest) return newest;
    this.lastErrors = errors;
    logger.warn('every SOL/INR source failed', { errors });
    throw new Error(errors.join('; '));
  }

  private async fromCoinGecko(): Promise<LivePrice> {
    const quote = await this.coingecko(() => this.deps.coingecko.solInr());
    const fetchedAtMs = this.now();
    const observedAtMs = quote.updatedAtMs ?? fetchedAtMs;
    const age = fetchedAtMs - observedAtMs;
    return {
      inr: quote.inr,
      usd: quote.usd,
      usdInr: quote.usd ? quote.inr / quote.usd : null,
      change24hPct: quote.inrChange24hPct,
      source: SOURCE_COINGECKO,
      observedAtMs,
      fetchedAtMs,
      stale: age > SOURCE_STALE_MS,
      staleReason: age > SOURCE_STALE_MS ? `CoinGecko has not updated for ${Math.round(age / MINUTE)} minutes` : null,
    };
  }

  private async fromFallback(): Promise<LivePrice> {
    const [solUsd, usdInr] = await Promise.all([this.deps.solUsd(), this.deps.usdInr()]);
    if (!(solUsd.value > 0) || !(usdInr.value > 0)) throw new Error('fallback price missing');
    const fetchedAtMs = this.now();
    const age = fetchedAtMs - solUsd.loadedAtMs;
    return {
      inr: solUsd.value * usdInr.value,
      usd: solUsd.value,
      usdInr: usdInr.value,
      change24hPct: null,
      source: SOURCE_FALLBACK_LIVE,
      observedAtMs: solUsd.loadedAtMs,
      fetchedAtMs,
      stale: age > FALLBACK_STALE_MS,
      staleReason: age > FALLBACK_STALE_MS ? `SOL/USD was last read ${Math.round(age / MINUTE)} minutes ago` : null,
    };
  }

  /** Runs a CoinGecko call unless CoinGecko asked us to wait (HTTP 429); a 429 pauses it until its reset time. */
  private async coingecko<T>(call: () => Promise<T>): Promise<T> {
    if (this.now() < this.coingeckoPausedUntil) {
      throw new Error(`CoinGecko rate limit: paused until ${new Date(this.coingeckoPausedUntil).toISOString()}`);
    }
    try {
      return await call();
    } catch (error) {
      if (error instanceof SourceRateLimitedError) {
        this.coingeckoPausedUntil = error.retryAtMs;
        logger.warn('CoinGecko rate-limited this server; using the fallbacks', { until: error.retryAtMs });
      }
      throw error;
    }
  }

  // ── History ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Daily prices covering [fromMs, toMs] (a day of margin each side): CoinGecko where it has the day, the fallback for
   * the rest. Never throws: a book without the days the sources could not give, with `missing` saying why.
   */
  async history(fromMs: number, toMs: number): Promise<{ book: PriceBook; notes: string[] }> {
    const notes: string[] = [];
    const from = fromMs - 2 * DAY;
    const to = Math.min(toMs, this.now()) + DAY;
    let coingecko: InrPoint[] = [];
    try {
      coingecko = await this.daily.get();
    } catch (error) {
      notes.push(`CoinGecko daily prices unavailable (${String(error)})`);
    }
    const byDay = new Map<number, PricedPoint>();
    const covered = coingecko.length > 0 ? coingecko[0].ms : Infinity;
    if (from < covered - DAY) {
      const fallbackTo = Math.min(to, covered);
      try {
        for (const point of await this.fallbackDaily.get(`${utcDate(from)}..${utcDate(fallbackTo)}`)) {
          byDay.set(point.ms, point);
        }
      } catch (error) {
        notes.push(`fallback daily prices unavailable (${String(error)})`);
      }
    }
    for (const point of coingecko) {
      if (point.ms >= from && point.ms <= to) byDay.set(point.ms, { ...point, source: SOURCE_COINGECKO });
    }
    return { book: new PriceBook([...byDay.values()]), notes };
  }

  /** CoinGecko's daily points of the last `days` days (each 00:00 UTC), oldest first; for the price sparkline. */
  async recentDaily(days: number): Promise<InrPoint[]> {
    const since = this.now() - days * DAY;
    return (await this.daily.get()).filter((p) => p.ms >= since && p.ms % DAY === 0);
  }

  /** `YYYY-MM-DD..YYYY-MM-DD` (UTC): SOL/USDT daily opens × the ECB rate of that day or the business day before. */
  private async loadFallback(key: string): Promise<PricedPoint[]> {
    const [fromDate, toDate] = key.split('..');
    const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
    const toMs = Date.parse(`${toDate}T00:00:00Z`) + DAY - 1;
    const [candles, rates] = await Promise.all([
      this.deps.usdHistory.solUsdDaily(fromMs, toMs),
      // A week of margin: the first days may fall on a weekend or an ECB holiday.
      this.deps.fxHistory.usdInrDaily(utcDate(fromMs - 7 * DAY), toDate),
    ]);
    const points: PricedPoint[] = [];
    let r = 0;
    for (const candle of [...candles].sort((a, b) => a.ms - b.ms)) {
      const day = utcDate(candle.ms);
      while (r + 1 < rates.length && rates[r + 1].date <= day) r++;
      const rate = rates[r] && rates[r].date <= day ? rates[r].rate : null;
      if (rate !== null) points.push({ ms: candle.ms, inr: candle.usd * rate, source: SOURCE_FALLBACK_HISTORY });
    }
    if (points.length === 0) throw new Error('no fallback prices for the range');
    return points;
  }
}
