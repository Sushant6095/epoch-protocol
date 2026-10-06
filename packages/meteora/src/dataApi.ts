/**
 * Meteora's DAMM v2 data API (`https://damm-v2.datapi.meteora.ag`; docs.meteora.ag, developer-guides/damm-v2/
 * api-reference): the indexed view of a pool (TVL, volume and fees by window, locked liquidity), OHLCV candles, volume
 * history and the protocol's totals. It indexes mainnet only, runs seconds behind the chain and allows 10 requests a
 * second, so the Launch page uses it for depth and keeps its own chain reads as the record. Amounts in USD are Meteora's
 * valuation; prices are the pool's (quote per base: SOL per token for a SOL-quoted pool). Browser-safe (global fetch).
 */

export const DAMM_V2_DATA_API_URL = 'https://damm-v2.datapi.meteora.ag';

/** The candle and volume buckets the API serves. */
export const DATA_API_TIMEFRAMES = ['5m', '30m', '1h', '2h', '4h', '12h', '24h'] as const;
export type DataApiTimeframe = (typeof DATA_API_TIMEFRAMES)[number];

/** A metric over the API's rolling windows. */
export interface DataApiWindows {
  '30m': number;
  '1h': number;
  '2h': number;
  '4h': number;
  '12h': number;
  '24h': number;
}

/** `GET /pools/{address}`, in our names. */
export interface DammIndexedPool {
  address: string;
  name: string;
  tvlUsd: number;
  /** Quote per base (token Y per token X): SOL per token for a SOL-quoted pool. */
  price: number;
  tokenX: { address: string; symbol: string; decimals: number; holders: number; priceUsd: number };
  tokenY: { address: string; symbol: string; decimals: number; priceUsd: number };
  /** UI units in the pool. */
  tokenXAmount: number;
  tokenYAmount: number;
  volumeUsd: DataApiWindows;
  feesUsd: DataApiWindows;
  protocolFeesUsd: DataApiWindows;
  /** Lifetime totals, when the API reports them. */
  cumulative: { volumeUsd: number; feesUsd: number } | null;
  /** Liquidity that can never be withdrawn, USD (all of it for an Epoch launch). */
  permanentLockLiquidityUsd: number;
  baseFeePct: number;
  /** 0 both tokens, 1 quote token only. */
  collectFeeMode: number;
  dynamicFee: boolean;
  launchpad: string | null;
  isBlacklisted: boolean;
  /** Unix ms. */
  createdAt: number;
}

export interface DammIndexedCandle {
  /** Bucket start, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface DammIndexedVolume {
  /** Bucket start, unix seconds. */
  time: number;
  volumeUsd: number;
  feesUsd: number;
  protocolFeesUsd: number;
}

/** A bucketed series and the range the API answered for (unix seconds). */
export interface DataApiSeries<T> {
  timeframe: DataApiTimeframe;
  startTime: number;
  endTime: number;
  points: T[];
}

/** `GET /stats/protocol_metrics`. */
export interface DammProtocolMetrics {
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  totalVolumeUsd: number;
  totalFeesUsd: number;
  pools: number;
  /** When Meteora last refreshed the totals, unix seconds (null when not reported). */
  refreshedAt: number | null;
}

/** A failed request: the HTTP status (0 for a network error or a timeout) and the API's message. */
export class DataApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DataApiError';
  }
}

type Json = Record<string, unknown>;

const obj = (value: unknown, what: string): Json => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataApiError(200, `unexpected data API answer: ${what} is not an object`);
  }
  return value as Json;
};
const num = (o: Json, key: string, what: string): number => {
  const value = o[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DataApiError(200, `unexpected data API answer: ${what}.${key} is not a number`);
  }
  return value;
};
const optNum = (o: Json, key: string): number | null =>
  typeof o[key] === 'number' && Number.isFinite(o[key]) ? (o[key] as number) : null;
const str = (o: Json, key: string, what: string): string => {
  const value = o[key];
  if (typeof value !== 'string') throw new DataApiError(200, `unexpected data API answer: ${what}.${key} is not text`);
  return value;
};
const windows = (o: Json, key: string): DataApiWindows => {
  const w = obj(o[key], key);
  return {
    '30m': num(w, '30m', key),
    '1h': num(w, '1h', key),
    '2h': num(w, '2h', key),
    '4h': num(w, '4h', key),
    '12h': num(w, '12h', key),
    '24h': num(w, '24h', key),
  };
};
const timeframeOf = (value: unknown): DataApiTimeframe =>
  (DATA_API_TIMEFRAMES as readonly string[]).includes(value as string) ? (value as DataApiTimeframe) : '24h';

/** `GET /pools/{address}` → `DammIndexedPool` (pure). */
export function mapIndexedPool(raw: unknown): DammIndexedPool {
  const pool = obj(raw, 'pool');
  const x = obj(pool.token_x, 'token_x');
  const y = obj(pool.token_y, 'token_y');
  const config = obj(pool.pool_config, 'pool_config');
  const cumulative =
    typeof pool.cumulative_metrics === 'object' && pool.cumulative_metrics !== null
      ? (pool.cumulative_metrics as Json)
      : null;
  return {
    address: str(pool, 'address', 'pool'),
    name: str(pool, 'name', 'pool'),
    tvlUsd: num(pool, 'tvl', 'pool'),
    price: num(pool, 'current_price', 'pool'),
    tokenX: {
      address: str(x, 'address', 'token_x'),
      symbol: str(x, 'symbol', 'token_x'),
      decimals: num(x, 'decimals', 'token_x'),
      holders: num(x, 'holders', 'token_x'),
      priceUsd: num(x, 'price', 'token_x'),
    },
    tokenY: {
      address: str(y, 'address', 'token_y'),
      symbol: str(y, 'symbol', 'token_y'),
      decimals: num(y, 'decimals', 'token_y'),
      priceUsd: num(y, 'price', 'token_y'),
    },
    tokenXAmount: num(pool, 'token_x_amount', 'pool'),
    tokenYAmount: num(pool, 'token_y_amount', 'pool'),
    volumeUsd: windows(pool, 'volume'),
    feesUsd: windows(pool, 'fees'),
    protocolFeesUsd: windows(pool, 'protocol_fees'),
    cumulative:
      cumulative && optNum(cumulative, 'volume') !== null && optNum(cumulative, 'fees') !== null
        ? { volumeUsd: cumulative.volume as number, feesUsd: cumulative.fees as number }
        : null,
    permanentLockLiquidityUsd: num(pool, 'permanent_lock_liquidity', 'pool'),
    baseFeePct: num(config, 'base_fee_pct', 'pool_config'),
    collectFeeMode: num(config, 'collect_fee_mode', 'pool_config'),
    dynamicFee: config.dynamic_fee_initialized === true,
    launchpad: typeof pool.launchpad === 'string' ? pool.launchpad : null,
    isBlacklisted: pool.is_blacklisted === true,
    createdAt: num(pool, 'created_at', 'pool'),
  };
}

const series = <T>(raw: unknown, what: string, point: (o: Json) => T): DataApiSeries<T> => {
  const body = obj(raw, what);
  const data = body.data;
  if (!Array.isArray(data)) throw new DataApiError(200, `unexpected data API answer: ${what}.data is not a list`);
  return {
    timeframe: timeframeOf(body.timeframe),
    startTime: num(body, 'start_time', what),
    endTime: num(body, 'end_time', what),
    points: data.map((item) => point(obj(item, `${what}.data[]`))),
  };
};

/** `GET /pools/{address}/ohlcv` → candles, oldest first (pure). */
export const mapIndexedCandles = (raw: unknown): DataApiSeries<DammIndexedCandle> =>
  series(raw, 'ohlcv', (o) => ({
    time: num(o, 'timestamp', 'ohlcv'),
    open: num(o, 'open', 'ohlcv'),
    high: num(o, 'high', 'ohlcv'),
    low: num(o, 'low', 'ohlcv'),
    close: num(o, 'close', 'ohlcv'),
    volumeUsd: num(o, 'volume', 'ohlcv'),
  }));

/** `GET /pools/{address}/volume/history` → buckets, oldest first (pure). */
export const mapIndexedVolume = (raw: unknown): DataApiSeries<DammIndexedVolume> =>
  series(raw, 'volume', (o) => ({
    time: num(o, 'timestamp', 'volume'),
    volumeUsd: num(o, 'volume', 'volume'),
    feesUsd: num(o, 'fees', 'volume'),
    protocolFeesUsd: num(o, 'protocol_fees', 'volume'),
  }));

/** `GET /stats/protocol_metrics` (pure). */
export function mapProtocolMetrics(raw: unknown): DammProtocolMetrics {
  const body = obj(raw, 'protocol_metrics');
  return {
    tvlUsd: num(body, 'total_tvl', 'protocol_metrics'),
    volume24hUsd: num(body, 'volume_24h', 'protocol_metrics'),
    fees24hUsd: num(body, 'fee_24h', 'protocol_metrics'),
    totalVolumeUsd: num(body, 'total_volume', 'protocol_metrics'),
    totalFeesUsd: num(body, 'total_fees', 'protocol_metrics'),
    pools: num(body, 'total_pools', 'protocol_metrics'),
    refreshedAt: optNum(body, 'refreshed_at'),
  };
}

export interface DammDataApiOptions {
  /** Default `DAMM_V2_DATA_API_URL`. */
  baseUrl?: string;
  /** Tests: a fake fetch. */
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Per request, default 10 s. */
  timeoutMs?: number;
}

/** A range for candles and volume, unix seconds; the API infers a missing bound from the timeframe. */
export interface DataApiRange {
  timeframe: DataApiTimeframe;
  startTime?: number;
  endTime?: number;
}

/** Read-only client for the DAMM v2 data API. */
export class DammDataApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: NonNullable<DammDataApiOptions['fetch']>;

  constructor(options: DammDataApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DAMM_V2_DATA_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The pool's indexed state; null when the API does not know the pool (404: not mainnet, or not indexed yet). */
  async pool(address: string): Promise<DammIndexedPool | null> {
    const body = await this.get(`/pools/${encodeURIComponent(address)}`, true);
    return body === null ? null : mapIndexedPool(body);
  }

  async ohlcv(address: string, range: DataApiRange): Promise<DataApiSeries<DammIndexedCandle>> {
    return mapIndexedCandles(await this.get(`/pools/${encodeURIComponent(address)}/ohlcv${query(range)}`));
  }

  async volumeHistory(address: string, range: DataApiRange): Promise<DataApiSeries<DammIndexedVolume>> {
    return mapIndexedVolume(await this.get(`/pools/${encodeURIComponent(address)}/volume/history${query(range)}`));
  }

  async protocolMetrics(): Promise<DammProtocolMetrics> {
    return mapProtocolMetrics(await this.get('/stats/protocol_metrics'));
  }

  private async get(path: string, notFoundIsNull = false): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new DataApiError(0, `data API unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status === 404 && notFoundIsNull) return null;
    const text = await res.text();
    if (!res.ok) {
      // Errors are JSON `{ message }`, or plain text for a bad query string.
      let message = text.trim();
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === 'string') message = parsed.message;
      } catch {
        // plain text
      }
      throw new DataApiError(res.status, `data API ${res.status}: ${message.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DataApiError(res.status, 'data API answered with something other than JSON');
    }
  }
}

const query = (range: DataApiRange): string => {
  if (!(DATA_API_TIMEFRAMES as readonly string[]).includes(range.timeframe)) {
    throw new RangeError(`timeframe must be one of ${DATA_API_TIMEFRAMES.join(', ')}, got ${range.timeframe}`);
  }
  const params = [`timeframe=${range.timeframe}`];
  if (range.startTime !== undefined) params.push(`start_time=${Math.floor(range.startTime)}`);
  if (range.endTime !== undefined) params.push(`end_time=${Math.floor(range.endTime)}`);
  return `?${params.join('&')}`;
};
