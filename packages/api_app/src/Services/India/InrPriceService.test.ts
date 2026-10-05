import { SourceRateLimitedError } from '../../Sources/IndiaPriceSources';
import binance from './__fixtures__/binance-klines.recorded.json';
import chart from './__fixtures__/coingecko-market-chart.recorded.json';
import simple from './__fixtures__/coingecko-simple-price.recorded.json';
import frankfurter from './__fixtures__/frankfurter-usd-inr.recorded.json';
import {
  type InrPriceDeps,
  InrPriceService,
  PriceBook,
  SOURCE_COINGECKO,
  SOURCE_FALLBACK_HISTORY,
  SOURCE_FALLBACK_LIVE,
} from './InrPriceService';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const RECORDED_AT = Date.parse('2026-10-03T12:36:00Z');

const coingeckoQuote = () => ({
  inr: simple.body.solana.inr,
  usd: simple.body.solana.usd,
  inrChange24hPct: simple.body.solana.inr_24h_change,
  updatedAtMs: simple.body.solana.last_updated_at * 1_000,
});
const dailyPoints = () => chart.body.prices.map(([ms, inr]) => ({ ms, inr }));
const candles = () => binance.body.map((row) => ({ ms: Number(row[0]), usd: Number(row[1]) }));
const rates = () => Object.entries(frankfurter.body.rates).map(([date, r]) => ({ date, rate: r.INR }));

function setup(over: Partial<InrPriceDeps> = {}) {
  let now = RECORDED_AT;
  const deps = {
    coingecko: { solInr: jest.fn(async () => coingeckoQuote()), solInrDaily: jest.fn(async () => dailyPoints()) },
    solUsd: jest.fn(async () => ({ value: 119.31, loadedAtMs: now - 10 * SECOND })),
    usdInr: jest.fn(async () => ({ value: 96.32, loadedAtMs: now - HOUR })),
    usdHistory: { solUsdDaily: jest.fn(async () => candles()) },
    fxHistory: { usdInrDaily: jest.fn(async () => rates()) },
    ...over,
  };
  const service = new InrPriceService({ ...deps, now: () => now });
  return { service, deps, advance: (ms: number) => (now += ms) };
}

describe('InrPriceService: live SOL/INR', () => {
  it('reads CoinGecko once a minute (recorded quote of 3 Oct 2026)', async () => {
    const { service, deps, advance } = setup();
    const price = await service.live();
    expect(price).toMatchObject({
      inr: 11496.63,
      usd: 119.35,
      source: SOURCE_COINGECKO,
      observedAtMs: Date.parse('2026-10-03T12:35:10Z'),
      fetchedAtMs: RECORDED_AT,
      stale: false,
      staleReason: null,
    });
    expect(price.usdInr).toBeCloseTo(96.33, 2);
    advance(59 * SECOND);
    await service.live();
    expect(deps.coingecko.solInr).toHaveBeenCalledTimes(1);
    advance(2 * SECOND);
    await service.live();
    expect(deps.coingecko.solInr).toHaveBeenCalledTimes(2);
  });

  it('falls back to Jupiter SOL/USD × USD/INR when CoinGecko fails', async () => {
    const { service } = setup({
      coingecko: { solInr: jest.fn().mockRejectedValue(new Error('HTTP 502')), solInrDaily: jest.fn() },
    });
    const price = await service.live();
    expect(price).toMatchObject({ usd: 119.31, usdInr: 96.32, source: SOURCE_FALLBACK_LIVE, stale: false });
    expect(price.inr).toBeCloseTo(119.31 * 96.32, 6);
  });

  it('serves the last known price marked stale when every source fails, and retries after a backoff', async () => {
    const solInr = jest.fn(async () => coingeckoQuote());
    const solUsd = jest.fn(async () => ({ value: 119.31, loadedAtMs: RECORDED_AT }));
    const { service, advance } = setup({ coingecko: { solInr, solInrDaily: jest.fn() }, solUsd });
    expect((await service.live()).stale).toBe(false);
    solInr.mockRejectedValue(new Error('HTTP 500'));
    solUsd.mockRejectedValue(new Error('Jupiter down'));
    advance(2 * MINUTE);
    const stale = await service.live();
    expect(stale).toMatchObject({ inr: 11496.63, source: SOURCE_COINGECKO, stale: true });
    expect(stale.staleReason).toMatch(/price sources unavailable since/);
    const calls = solInr.mock.calls.length;
    advance(5 * SECOND);
    expect((await service.live()).stale).toBe(true);
    expect(solInr.mock.calls.length).toBe(calls);
    solInr.mockImplementation(async () => ({ ...coingeckoQuote(), updatedAtMs: RECORDED_AT + 2 * MINUTE }));
    advance(15 * SECOND);
    expect(await service.live()).toMatchObject({ stale: false, source: SOURCE_COINGECKO });
  });

  it('answers 503 PRICE_UNAVAILABLE when no source has ever answered', async () => {
    const { service } = setup({
      coingecko: { solInr: jest.fn().mockRejectedValue(new Error('down')), solInrDaily: jest.fn() },
      solUsd: jest.fn().mockRejectedValue(new Error('down')),
    });
    await expect(service.live()).rejects.toMatchObject({ statusCode: 503, code: 'PRICE_UNAVAILABLE' });
  });

  it('does not call a CoinGecko price that stopped updating live', async () => {
    const old = { ...coingeckoQuote(), updatedAtMs: RECORDED_AT - 20 * MINUTE };
    const { service } = setup({ coingecko: { solInr: jest.fn(async () => old), solInrDaily: jest.fn() } });
    expect(await service.live()).toMatchObject({ source: SOURCE_FALLBACK_LIVE, stale: false });

    const { service: alone } = setup({
      coingecko: { solInr: jest.fn(async () => old), solInrDaily: jest.fn() },
      solUsd: jest.fn().mockRejectedValue(new Error('down')),
    });
    const price = await alone.live();
    expect(price).toMatchObject({ source: SOURCE_COINGECKO, stale: true });
    expect(price.staleReason).toBe('CoinGecko has not updated for 20 minutes');
  });

  it('pauses CoinGecko after an HTTP 429 until its reset time', async () => {
    const solInr = jest
      .fn()
      .mockRejectedValue(new SourceRateLimitedError('api.coingecko.com', RECORDED_AT + 10 * MINUTE));
    const { service, advance } = setup({ coingecko: { solInr, solInrDaily: jest.fn() } });
    expect((await service.live()).source).toBe(SOURCE_FALLBACK_LIVE);
    advance(2 * MINUTE);
    await service.live();
    expect(solInr).toHaveBeenCalledTimes(1);
    solInr.mockResolvedValue({ ...coingeckoQuote(), updatedAtMs: RECORDED_AT + 10 * MINUTE });
    advance(9 * MINUTE);
    expect((await service.live()).source).toBe(SOURCE_COINGECKO);
  });
});

describe('InrPriceService: daily history', () => {
  it('uses CoinGecko alone inside its 365 days', async () => {
    const { service, deps } = setup();
    const { book, notes } = await service.history(
      Date.parse('2026-04-01T00:00:00+05:30'),
      Date.parse('2026-04-05T00:00:00+05:30'),
    );
    expect(notes).toEqual([]);
    expect(deps.usdHistory.solUsdDaily).not.toHaveBeenCalled();
    expect(book.sources).toEqual([SOURCE_COINGECKO]);
    // Epoch 948 ended 31 Mar 2026 04:42 IST (23:12 UTC on 30 Mar): the 31 Mar 00:00 UTC price is 48 minutes away.
    expect(book.at(Date.parse('2026-03-31T04:42:05+05:30'))).toMatchObject({
      ms: Date.parse('2026-03-31T00:00:00Z'),
      source: SOURCE_COINGECKO,
    });
  });

  it("prices older days at Binance's SOL/USDT open × the ECB rate of that day or the business day before", async () => {
    const { service, deps } = setup();
    const { book } = await service.history(
      Date.parse('2025-03-30T00:00:00+05:30'),
      Date.parse('2025-04-03T00:00:00+05:30'),
    );
    // Two days of margin before the range, one after; a week more of rates for weekends and holidays.
    expect(deps.usdHistory.solUsdDaily).toHaveBeenCalledWith(
      Date.parse('2025-03-27T00:00:00Z'),
      Date.parse('2025-04-04T00:00:00Z') - 1,
    );
    expect(deps.fxHistory.usdInrDaily).toHaveBeenCalledWith('2025-03-20', '2025-04-03');
    const at = (iso: string) => book.at(Date.parse(iso));
    expect(at('2025-04-01T00:00:00Z')).toEqual({
      ms: Date.parse('2025-04-01T00:00:00Z'),
      inr: 124.53 * 85.63,
      source: SOURCE_FALLBACK_HISTORY,
    });
    // Sunday 30 March 2025: no ECB rate that day, Friday's (85.53) is used.
    const sunday = candles().find((c) => c.ms === Date.parse('2025-03-30T00:00:00Z'));
    expect(at('2025-03-30T00:00:00Z')?.inr).toBeCloseTo((sunday?.usd ?? 0) * 85.53, 9);
  });

  it('fills the whole range from the fallback while CoinGecko is down, and says so', async () => {
    const { service } = setup({
      coingecko: { solInr: jest.fn(), solInrDaily: jest.fn().mockRejectedValue(new Error('HTTP 500')) },
    });
    const { book, notes } = await service.history(
      Date.parse('2025-03-30T00:00:00Z'),
      Date.parse('2025-04-02T00:00:00Z'),
    );
    expect(notes[0]).toMatch(/CoinGecko daily prices unavailable/);
    expect(book.sources).toEqual([SOURCE_FALLBACK_HISTORY]);
  });

  it('returns CoinGecko daily points only for the sparkline', async () => {
    const { service } = setup();
    const recent = await service.recentDaily(3);
    expect(recent.map((p) => new Date(p.ms).toISOString().slice(0, 10))).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });
});

describe('PriceBook', () => {
  const day = (iso: string, inr: number) => ({ ms: Date.parse(iso), inr, source: 'test' });
  const book = new PriceBook([
    day('2026-04-02T00:00:00Z', 2),
    day('2026-04-01T00:00:00Z', 1),
    day('2026-04-05T00:00:00Z', 5),
  ]);

  it('answers the nearest daily price, the earlier one on a tie', () => {
    expect(book.at(Date.parse('2026-04-01T13:00:00Z'))?.inr).toBe(2);
    expect(book.at(Date.parse('2026-04-01T12:00:00Z'))?.inr).toBe(1);
    expect(book.at(Date.parse('2026-03-31T20:00:00Z'))?.inr).toBe(1);
    expect(book.at(Date.parse('2026-04-03T11:00:00Z'))?.inr).toBe(2);
  });

  it('answers null more than 36 hours from any price', () => {
    expect(book.at(Date.parse('2026-03-30T11:00:00Z'))).toBeNull();
    expect(book.at(Date.parse('2026-04-03T13:00:00Z'))?.inr).toBe(5);
    const gap = new PriceBook([day('2026-04-01T00:00:00Z', 1), day('2026-04-05T00:00:00Z', 5)]);
    expect(gap.at(Date.parse('2026-04-03T00:00:00Z'))).toBeNull();
    expect(new PriceBook([]).at(Date.now())).toBeNull();
  });
});
