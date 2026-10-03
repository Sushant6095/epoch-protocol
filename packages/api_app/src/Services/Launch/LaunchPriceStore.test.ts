import { launchPriceSamples, PostgresConnectionManager, runMigrations } from '@epoch/pg_models';
import { inArray } from 'drizzle-orm';

import {
  downsample,
  type LaunchPriceSample,
  type LaunchPriceStore,
  MemoryLaunchPriceStore,
  PgLaunchPriceStore,
} from './LaunchPriceStore';

const START = Date.parse('2026-10-01T00:00:00Z');
const samples = (mint: string, count: number): LaunchPriceSample[] =>
  Array.from({ length: count }, (_, i) => ({
    mint,
    t: new Date(START + i * 60_000),
    epoch: 1044 + Math.floor(i / 2_880),
    priceSol: 0.0006 + i * 1e-8,
  }));

describe('downsample', () => {
  it('keeps short series whole', () => {
    expect(downsample([1, 2, 3], 500)).toEqual([1, 2, 3]);
  });

  it('thins evenly to at most the limit, keeping the oldest and the newest', () => {
    const points = Array.from({ length: 1_234 }, (_, i) => i);
    const kept = downsample(points, 500);
    expect(kept.length).toBeLessThanOrEqual(500);
    expect(kept.length).toBeGreaterThan(400);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(1_233);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(() => downsample(points, 1)).toThrow(RangeError);
  });
});

function contract(name: string, make: () => Promise<LaunchPriceStore>, mints: [string, string]) {
  describe(name, () => {
    let store: LaunchPriceStore;
    beforeEach(async () => {
      store = await make();
    });

    it('stores each (mint, t) once', async () => {
      const batch = samples(mints[0], 3);
      expect(await store.insert(batch)).toBe(3);
      expect(await store.insert([batch[0], ...samples(mints[1], 1)])).toBe(1);
      expect(await store.insert([])).toBe(0);
    });

    it('returns a mint’s series oldest first, thinned to at most 500 points', async () => {
      await store.insert(samples(mints[0], 1_200).reverse());
      await store.insert(samples(mints[1], 2));
      const series = await store.series(mints[0]);
      expect(series.length).toBeLessThanOrEqual(500);
      expect(series[0].t.getTime()).toBe(START);
      expect(series[series.length - 1].t.getTime()).toBe(START + 1_199 * 60_000);
      expect(series.every((s, i) => i === 0 || s.t > series[i - 1].t)).toBe(true);
      expect(series[0]).toEqual({ mint: mints[0], t: new Date(START), epoch: 1044, priceSol: 0.0006 });
      expect(await store.series(mints[1])).toHaveLength(2);
      expect(await store.series('nothing-here')).toEqual([]);
    });
  });
}

contract('MemoryLaunchPriceStore', async () => new MemoryLaunchPriceStore(), ['mint-a', 'mint-b']);

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgLaunchPriceStore (TEST_DATABASE_URL)', () => {
  const mints: [string, string] = ['test-launch-mint-a', 'test-launch-mint-b'];
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(async () => {
    await PostgresConnectionManager.getDb().delete(launchPriceSamples).where(inArray(launchPriceSamples.mint, mints));
    await PostgresConnectionManager.close();
  });

  it('thins in SQL exactly as downsample() does', async () => {
    const db = PostgresConnectionManager.getDb();
    await db.delete(launchPriceSamples).where(inArray(launchPriceSamples.mint, mints));
    const all = samples(mints[0], 1_337);
    await new PgLaunchPriceStore(db).insert(all);
    const fromSql = await new PgLaunchPriceStore(db).series(mints[0], 500);
    expect(fromSql.map((s) => s.t.getTime())).toEqual(downsample(all, 500).map((s) => s.t.getTime()));
  });

  contract(
    'PgLaunchPriceStore',
    async () => {
      const db = PostgresConnectionManager.getDb();
      await db.delete(launchPriceSamples).where(inArray(launchPriceSamples.mint, mints));
      return new PgLaunchPriceStore(db);
    },
    mints,
  );
});
