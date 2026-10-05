import binance from '../Services/India/__fixtures__/binance-klines.recorded.json';
import chart from '../Services/India/__fixtures__/coingecko-market-chart.recorded.json';
import simple from '../Services/India/__fixtures__/coingecko-simple-price.recorded.json';
import frankfurter from '../Services/India/__fixtures__/frankfurter-usd-inr.recorded.json';
import {
  BinanceKlinesSource,
  CoinGeckoSource,
  FrankfurterSource,
  retryAtFrom,
  SourceRateLimitedError,
} from './IndiaPriceSources';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('India price sources', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  const calledUrl = (i = 0): string => String(fetchMock.mock.calls[i][0]);
  const calledHeaders = (i = 0): Record<string, string> =>
    (fetchMock.mock.calls[i][1] as RequestInit).headers as Record<string, string>;

  it('reads CoinGecko simple/price in rupees, with its update time (recorded 3 Oct 2026)', async () => {
    fetchMock.mockResolvedValue(json(simple.body));
    const quote = await new CoinGeckoSource('https://api.coingecko.com/api/v3/').solInr();
    expect(quote).toEqual({
      inr: 11496.63,
      usd: 119.35,
      inrChange24hPct: -2.1066008222794466,
      updatedAtMs: 1791030910000,
    });
    expect(calledUrl()).toBe(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=inr,usd&include_24hr_change=true&include_last_updated_at=true',
    );
    expect(calledHeaders()).toEqual({ accept: 'application/json' });
  });

  it('sends a demo key, or a paid key on pro-api, only in a header', async () => {
    fetchMock.mockResolvedValue(json(simple.body));
    await new CoinGeckoSource('https://api.coingecko.com/api/v3', 'CG-demo').solInr();
    expect(calledHeaders(0)).toMatchObject({ 'x-cg-demo-api-key': 'CG-demo' });
    expect(calledUrl(0)).not.toContain('CG-demo');
    fetchMock.mockResolvedValue(json(simple.body));
    await new CoinGeckoSource('https://pro-api.coingecko.com/api/v3', 'CG-paid').solInr();
    expect(calledHeaders(1)).toMatchObject({ 'x-cg-pro-api-key': 'CG-paid' });
  });

  it('reads the daily market chart in rupees (recorded)', async () => {
    fetchMock.mockResolvedValue(json(chart.body));
    const points = await new CoinGeckoSource('https://api.coingecko.com/api/v3').solInrDaily(365);
    expect(calledUrl()).toContain('/coins/solana/market_chart?vs_currency=inr&days=365&interval=daily');
    expect(points[0]).toEqual({ ms: Date.parse('2025-10-04T00:00:00Z'), inr: 20679.27355157951 });
    expect(points.find((p) => p.ms === Date.parse('2026-04-01T00:00:00Z'))?.inr).toBeCloseTo(7692.996, 3);
    expect(points.at(-1)).toEqual({ ms: Date.parse('2026-10-03T12:35:30Z'), inr: 11473.36172121417 });
    expect(points.every((p) => p.inr > 0)).toBe(true);
  });

  it('does not retry an HTTP 429 and says when to come back', async () => {
    fetchMock.mockResolvedValue(
      new Response('Throttled', { status: 429, headers: { 'x-ratelimit-reset': '2026-10-03 13:00:00 +0000' } }),
    );
    const error = await new CoinGeckoSource('https://api.coingecko.com/api/v3').solInr().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const now = Date.parse('2026-10-03T12:47:00Z');
    expect(retryAtFrom(new Headers({ 'x-ratelimit-reset': '2026-10-03 13:00:00 +0000' }), now)).toBe(
      Date.parse('2026-10-03T13:00:00Z'),
    );
    expect(retryAtFrom(new Headers({ 'retry-after': '30' }), now)).toBe(now + 30_000);
    expect(retryAtFrom(new Headers(), now)).toBe(now + 60_000);
  });

  it('retries a 5xx once, then fails', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    await expect(new CoinGeckoSource('https://api.coingecko.com/api/v3').solInr()).rejects.toThrow(
      'HTTP 503 from api.coingecko.com',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads Binance daily SOL/USDT opens and the ECB USD/INR rates (recorded)', async () => {
    fetchMock.mockResolvedValueOnce(json(binance.body)).mockResolvedValueOnce(json(frankfurter.body));
    const from = Date.parse('2025-03-27T00:00:00Z');
    const candles = await new BinanceKlinesSource('https://data-api.binance.vision/api/v3/klines').solUsdDaily(
      from,
      Date.parse('2025-04-06T00:00:00Z'),
    );
    expect(calledUrl(0)).toBe(
      `https://data-api.binance.vision/api/v3/klines?symbol=SOLUSDT&interval=1d&startTime=${from}&endTime=${Date.parse('2025-04-06T00:00:00Z')}&limit=1000`,
    );
    expect(candles[0]).toEqual({ ms: from, usd: 137.35 });
    expect(candles.find((c) => c.ms === Date.parse('2025-04-01T00:00:00Z'))?.usd).toBe(124.53);
    const rates = await new FrankfurterSource('https://api.frankfurter.dev/v1/').usdInrDaily(
      '2025-03-26',
      '2025-04-06',
    );
    expect(calledUrl(1)).toBe('https://api.frankfurter.dev/v1/2025-03-26..2025-04-06?base=USD&symbols=INR');
    expect(rates.slice(0, 4)).toEqual([
      { date: '2025-03-26', rate: 85.65 },
      { date: '2025-03-27', rate: 85.73 },
      { date: '2025-03-28', rate: 85.53 },
      { date: '2025-03-31', rate: 85.44 },
    ]);
  });
});
