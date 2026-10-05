import { sleep } from '@epoch/common';
import { EpochException } from '@epoch/exceptions';

import { redactUrl } from '../Lib/Http';

/** One price observation: when (epoch ms) and how many rupees one SOL was worth. */
export interface InrPoint {
  ms: number;
  inr: number;
}

/** HTTP 429: the source asked us to wait until `retryAtMs`. Never retried, so a throttled source is not hammered. */
export class SourceRateLimitedError extends EpochException {
  constructor(
    readonly host: string,
    readonly retryAtMs: number,
  ) {
    super(`HTTP 429 from ${host}`, 'UPSTREAM_RATE_LIMITED', 502, { host, retryAtMs });
  }
}

/** When a 429 says to come back: `retry-after` (seconds or a date), CoinGecko's `x-ratelimit-reset`, else a minute. */
export function retryAtFrom(headers: Headers, now: number): number {
  const after = headers.get('retry-after');
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return now + Math.max(1, seconds) * 1_000;
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(now + 1_000, date);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    // `2026-10-03 13:00:00 +0000`
    const date = Date.parse(reset.trim().replace(' ', 'T').replace(' ', ''));
    if (Number.isFinite(date)) return Math.max(now + 1_000, Math.min(date, now + 15 * 60_000));
  }
  return now + 60_000;
}

/** GET JSON with a timeout; `retries` more attempts on network errors and 5xx, none on 4xx (429 included). */
export async function fetchJson<T>(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { headers = {}, timeoutMs = 15_000, retries = 1 } = options;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= retries) {
        throw new EpochException(`${redactUrl(url)} unreachable`, 'UPSTREAM_ERROR', 502, { error: String(error) });
      }
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 429) throw new SourceRateLimitedError(redactUrl(url), retryAtFrom(res.headers, Date.now()));
    if (res.ok) return (await res.json()) as T;
    if (res.status < 500 || attempt >= retries) {
      throw new EpochException(`HTTP ${res.status} from ${redactUrl(url)}`, 'UPSTREAM_ERROR', 502);
    }
    await sleep(500 * 2 ** attempt);
  }
}

const trim = (url: string): string => url.replace(/\/+$/, '');

/** CoinGecko's live SOL price in rupees (and dollars), with its own update time. */
export interface CoinGeckoQuote {
  inr: number;
  usd: number | null;
  inrChange24hPct: number | null;
  /** When CoinGecko last updated the price; null when it did not say. */
  updatedAtMs: number | null;
}

/** CoinGecko API v3. Without a key it is the public tier: about 30 calls a minute per IP, 365 days of history. */
export class CoinGeckoSource {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  /** The key goes in a header, never in the URL (URLs end up in logs). */
  private headers(): Record<string, string> {
    if (!this.apiKey) return {};
    return this.baseUrl.includes('pro-api.')
      ? { 'x-cg-pro-api-key': this.apiKey }
      : { 'x-cg-demo-api-key': this.apiKey };
  }

  /** `simple/price?ids=solana&vs_currencies=inr,usd` */
  async solInr(): Promise<CoinGeckoQuote> {
    const body = await fetchJson<{
      solana?: { inr?: number; usd?: number; inr_24h_change?: number; last_updated_at?: number };
    }>(
      `${trim(this.baseUrl)}/simple/price?ids=solana&vs_currencies=inr,usd&include_24hr_change=true&include_last_updated_at=true`,
      { headers: this.headers(), timeoutMs: 10_000 },
    );
    const row = body.solana;
    if (typeof row?.inr !== 'number' || !(row.inr > 0)) throw new Error('SOL/INR missing from CoinGecko simple/price');
    return {
      inr: row.inr,
      usd: typeof row.usd === 'number' ? row.usd : null,
      inrChange24hPct: typeof row.inr_24h_change === 'number' ? row.inr_24h_change : null,
      updatedAtMs: typeof row.last_updated_at === 'number' ? row.last_updated_at * 1_000 : null,
    };
  }

  /** `coins/solana/market_chart?vs_currency=inr&days=365&interval=daily`: one point a day at 00:00 UTC, then now. */
  async solInrDaily(days = 365): Promise<InrPoint[]> {
    const body = await fetchJson<{ prices?: [number, number][] }>(
      `${trim(this.baseUrl)}/coins/solana/market_chart?vs_currency=inr&days=${days}&interval=daily`,
      { headers: this.headers(), timeoutMs: 20_000 },
    );
    if (!Array.isArray(body.prices)) throw new Error('prices missing from CoinGecko market_chart');
    return body.prices
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0)
      .map(([ms, inr]) => ({ ms, inr }));
  }
}

/** Daily SOL/USDT candles from Binance's public market-data API (`/api/v3/klines`, no key, history to 2020). */
export class BinanceKlinesSource {
  constructor(private readonly klinesUrl: string) {}

  /** The open price of each UTC day in [fromMs, toMs], i.e. the price at 00:00 UTC, as CoinGecko's daily points. */
  async solUsdDaily(fromMs: number, toMs: number): Promise<{ ms: number; usd: number }[]> {
    const rows = await fetchJson<unknown[][]>(
      `${trim(this.klinesUrl)}?symbol=SOLUSDT&interval=1d&startTime=${Math.floor(fromMs)}&endTime=${Math.floor(toMs)}&limit=1000`,
      { timeoutMs: 15_000, retries: 2 },
    );
    if (!Array.isArray(rows)) throw new Error('klines missing from the SOL/USD history source');
    return rows
      .map((row) => ({ ms: Number(row[0]), usd: Number(row[1]) }))
      .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.usd) && p.usd > 0);
  }
}

/** USD/INR reference rates from the European Central Bank via Frankfurter (business days only). */
export class FrankfurterSource {
  constructor(private readonly baseUrl: string) {}

  /** `{ date: 'YYYY-MM-DD', rate }` for each ECB business day in [fromDate, toDate], oldest first. */
  async usdInrDaily(fromDate: string, toDate: string): Promise<{ date: string; rate: number }[]> {
    const body = await fetchJson<{ rates?: Record<string, { INR?: number }> }>(
      `${trim(this.baseUrl)}/${fromDate}..${toDate}?base=USD&symbols=INR`,
      { timeoutMs: 15_000, retries: 2 },
    );
    return Object.entries(body.rates ?? {})
      .map(([date, rates]) => ({ date, rate: Number(rates.INR) }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.rate) && r.rate > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
