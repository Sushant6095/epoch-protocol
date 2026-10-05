import {
  indexerCursors,
  launchFeeEvents,
  launchTrades,
  PostgresConnectionManager,
  runMigrations,
} from '@epoch/pg_models';
import { inArray } from 'drizzle-orm';

import {
  decodeTradeCursor,
  encodeTradeCursor,
  type LaunchTradeStore,
  MemoryLaunchTradeStore,
  PgLaunchTradeStore,
  type StoredLaunchFeeEvent,
  type StoredLaunchTrade,
} from './LaunchTradeStore';

/** 2026-10-03 10:00 IST. */
const T0 = Date.parse('2026-10-03T04:30:00Z');
/** Signatures that sort the same way in JS and in any Postgres collation (they differ in one lowercase letter). */
const sig = (n: number): string => `5${'z'.repeat(60)}${'abcdefghijkmnopqrstuvwxyz'[n]}`;

const trade = (mint: string, n: number, overrides: Partial<StoredLaunchTrade> = {}): StoredLaunchTrade => ({
  signature: sig(n),
  ix: 0,
  mint,
  pool: 'pool',
  venue: 'dbc',
  side: n % 3 === 2 ? 'sell' : 'buy',
  trader: `trader-${n}`,
  slot: 1_000 + n,
  blockTime: new Date(T0 + n * 60_000),
  solLamports: 100_000_000n,
  tokenAmount: 40_000_000_000n + BigInt(n),
  feeAmount: 1_000_000n,
  feeInToken: false,
  priceSol: 0.0000025 + n * 1e-7,
  postPriceSol: 0.0000026 + n * 1e-7,
  quoteReserveLamports: 200_000_000n + BigInt(n) * 100_000_000n,
  ...overrides,
});

const feeEvent = (mint: string, n: number, kind: string): StoredLaunchFeeEvent => ({
  signature: sig(n),
  ix: 0,
  mint,
  pool: 'pool',
  kind,
  owner: 'treasury',
  slot: 2_000 + n,
  blockTime: new Date(T0 + n * 60_000),
  solLamports: 7_283_420n,
  tokenAmount: 639_263_000_567n,
});

describe('trade cursors', () => {
  it('round-trips (slot, signature, ix) and rejects anything else', () => {
    const cursor = { slot: 3_443, signature: sig(4), ix: 2 };
    expect(decodeTradeCursor(encodeTradeCursor(cursor))).toEqual(cursor);
    expect(decodeTradeCursor('3443:not-base58!:2')).toBeNull();
    expect(decodeTradeCursor('abc')).toBeNull();
    expect(decodeTradeCursor(`-1:${sig(1)}:0`)).toBeNull();
  });
});

function contract(name: string, make: () => Promise<LaunchTradeStore>, mints: [string, string], cursorPrefix: string) {
  describe(name, () => {
    let store: LaunchTradeStore;
    const [mint, other] = mints;
    beforeEach(async () => {
      store = await make();
    });

    it('stores each (signature, ix) once and returns only the new rows', async () => {
      const first = await store.insertTrades([trade(mint, 0), trade(mint, 1)]);
      expect(first.map((row) => row.signature)).toEqual([sig(0), sig(1)]);
      // The migration transaction is read through both pools: the second read adds nothing.
      const again = await store.insertTrades([trade(mint, 1), trade(mint, 1, { ix: 3 }), trade(other, 2)]);
      expect(again.map((row) => [row.signature, row.ix])).toEqual([
        [sig(1), 3],
        [sig(2), 0],
      ]);
      expect(await store.insertTrades([])).toEqual([]);
    });

    it('keeps u64 amounts and prices exact', async () => {
      const big = trade(mint, 5, {
        tokenAmount: 18_446_744_073_709_551_615n,
        feeAmount: 12_345n,
        feeInToken: true,
        venue: 'damm-v2',
      });
      await store.insertTrades([big]);
      const [row] = await store.trades(mint, { limit: 1 });
      expect(row).toEqual(big);
    });

    it('pages newest first with a cursor', async () => {
      await store.insertTrades([0, 1, 2, 3, 4].map((n) => trade(mint, n)));
      await store.insertTrades([trade(mint, 4, { ix: 1 })]);
      await store.insertTrades([trade(other, 9)]);
      const page1 = await store.trades(mint, { limit: 3 });
      expect(page1.map((row) => [row.slot, row.ix])).toEqual([
        [1_004, 1],
        [1_004, 0],
        [1_003, 0],
      ]);
      const last = page1[page1.length - 1];
      const page2 = await store.trades(mint, { limit: 3, before: decodeTradeCursor(encodeTradeCursor(last)) });
      expect(page2.map((row) => row.slot)).toEqual([1_002, 1_001, 1_000]);
      expect(await store.trades(mint, { limit: 3, before: page2[2] })).toEqual([]);
      expect(await store.trades('no-such-mint', { limit: 10 })).toEqual([]);
    });

    it('buckets candles in SQL-equivalent OHLC, with the close before the range', async () => {
      // Minutes 0..5 at 10:00 IST onwards; 5-minute buckets from 10:00 hold minutes 0-4, the next minute 5.
      await store.insertTrades([0, 1, 2, 3, 4, 5].map((n) => trade(mint, n)));
      const from = new Date(T0 + 60_000);
      const to = new Date(T0 + 10 * 60_000);
      const { candles, previousClose } = await store.candles(mint, '5m', from, to);
      expect(previousClose).toBeCloseTo(0.0000025, 12);
      expect(candles).toHaveLength(2);
      expect(candles[0]).toEqual({
        t: T0 / 1000,
        open: expect.closeTo(0.0000026, 12),
        high: expect.closeTo(0.0000029, 12),
        low: expect.closeTo(0.0000026, 12),
        close: expect.closeTo(0.0000029, 12),
        volumeSol: expect.closeTo(0.4, 9),
        trades: 4,
      });
      expect(candles[1]).toMatchObject({ t: T0 / 1000 + 300, trades: 1, volumeSol: expect.closeTo(0.1, 9) });
      expect(await store.candles(other, '1h', from, to)).toEqual({ candles: [], previousClose: null });
    });

    it('sums the last 24 hours', async () => {
      await store.insertTrades([0, 1, 2, 3].map((n) => trade(mint, n)));
      const day = await store.dayStats(mint, new Date(T0 + 60_000));
      expect(day).toEqual({
        volumeSol: expect.closeTo(0.3, 9),
        trades: 3,
        buys: 2,
        sells: 1,
        firstPriceSol: expect.closeTo(0.0000026, 12),
        lastPriceSol: expect.closeTo(0.0000028, 12),
      });
      expect(await store.dayStats(other, new Date(T0))).toEqual({
        volumeSol: 0,
        trades: 0,
        buys: 0,
        sells: 0,
        firstPriceSol: null,
        lastPriceSol: null,
      });
    });

    it('keeps fee events once each, newest first', async () => {
      const claim = feeEvent(mint, 1, 'partnerTradingFee');
      expect(await store.insertFeeEvents([feeEvent(mint, 0, 'curveComplete'), claim])).toHaveLength(2);
      expect(await store.insertFeeEvents([claim, feeEvent(mint, 2, 'leftover')])).toEqual([
        feeEvent(mint, 2, 'leftover'),
      ]);
      expect((await store.feeEvents(mint, 2)).map((row) => row.kind)).toEqual(['leftover', 'partnerTradingFee']);
      expect(await store.feeEvents(other, 10)).toEqual([]);
      expect(await store.insertFeeEvents([])).toEqual([]);
    });

    it('remembers ingest cursors', async () => {
      const name = `${cursorPrefix}:pool`;
      expect(await store.cursor(name)).toBeNull();
      await store.setCursor(name, 10, sig(1));
      await store.setCursor(name, 12, sig(2));
      expect(await store.cursor(name)).toEqual({ slot: 12, signature: sig(2) });
    });
  });
}

contract('MemoryLaunchTradeStore', async () => new MemoryLaunchTradeStore(), ['mint-a', 'mint-b'], 'launch_trades');

describe('MemoryLaunchTradeStore limits', () => {
  it('keeps the newest maxRows trades per launch', async () => {
    const store = new MemoryLaunchTradeStore(3);
    await store.insertTrades([0, 1, 2, 3, 4].map((n) => trade('m', n)));
    expect((await store.trades('m', { limit: 10 })).map((row) => row.slot)).toEqual([1_004, 1_003, 1_002]);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgLaunchTradeStore (TEST_DATABASE_URL)', () => {
  const mints: [string, string] = ['test-launch-trades-a', 'test-launch-trades-b'];
  const cursorPrefix = 'test-launch-trades';
  const clean = async () => {
    const db = PostgresConnectionManager.getDb();
    await db.delete(launchTrades).where(inArray(launchTrades.mint, mints));
    await db.delete(launchFeeEvents).where(inArray(launchFeeEvents.mint, mints));
    await db.delete(indexerCursors).where(inArray(indexerCursors.name, [`${cursorPrefix}:pool`]));
  };
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(async () => {
    await clean();
    await PostgresConnectionManager.close();
  });

  contract(
    'PgLaunchTradeStore',
    async () => {
      await clean();
      return new PgLaunchTradeStore(PostgresConnectionManager.getDb());
    },
    mints,
    cursorPrefix,
  );
});
