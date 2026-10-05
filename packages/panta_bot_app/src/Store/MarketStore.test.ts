import { epochIndex, pantaMarkets, PostgresConnectionManager, runMigrations } from '@epoch/pg_models';
import { and, gte, lt } from 'drizzle-orm';

import { MemoryIndexHistory, MemoryMarketStore, NOW } from '../__fixtures__/fakes';
import { type IndexHistory, type MarketStore, type NewMarket, PgIndexHistory, PgMarketStore } from './MarketStore';

/** This file's rows live in epochs [900,000, 900,100), so other tests' rows never mix in. */
const BASE = 900_000;

const market = (epoch: number, threshold: number): NewMarket => ({
  epoch,
  threshold,
  question: `Will the Solana Fee Index for epoch ${epoch} close above ${threshold} micro-lamports per CU?`,
  title: `t ${epoch} ${threshold}`,
  description: 'd',
  resolutionRule: 'r',
  sourcesOfTruth: ['https://api.epoch.example/v1/index/epochs/1'],
  imageUrl: 'https://cdn.epoch.example/i.png',
  startTime: new Date(NOW + 3_600_000),
  endTime: new Date(NOW + 7_200_000),
  resolutionTime: new Date(NOW + 9_000_000),
});

function contract(name: string, make: () => Promise<{ store: MarketStore; history: IndexHistory }>) {
  describe(name, () => {
    let store: MarketStore;
    let history: IndexHistory;
    beforeEach(async () => {
      ({ store, history } = await make());
    });

    it('plans each (epoch, threshold) once', async () => {
      const first = await store.plan(market(BASE + 1, 1_300));
      expect(first).toMatchObject({ epoch: BASE + 1, threshold: 1_300, status: 'planned', attempts: 0 });
      expect(await store.plan(market(BASE + 1, 1_300))).toBeNull();
      expect(await store.plan(market(BASE + 1, 1_350))).not.toBeNull();
      expect((await store.forEpochs([BASE + 1])).map((row) => row.threshold)).toEqual([1_300, 1_350]);
      expect(await store.forEpochs([])).toEqual([]);
    });

    it('moves a row only from the status it expects', async () => {
      const row = await store.plan(market(BASE + 2, 1_000));
      if (!row) throw new Error('not planned');
      expect(await store.transition(row.id, 'quoted', { status: 'signed' })).toBe(false);
      expect(await store.transition(row.id, 'planned', { status: 'quoted', createId: 'cr_1' })).toBe(true);
      expect(await store.transition(row.id, 'planned', { status: 'quoted', createId: 'cr_2' })).toBe(false);
      const [quoted] = await store.withStatus(['quoted']);
      expect(quoted).toMatchObject({ id: row.id, createId: 'cr_1' });
    });

    it('counts committed creation fees in the window', async () => {
      // The sum is global (the budget covers every market): measure what this test adds.
      const since = new Date(NOW - 1_000);
      const later = new Date(NOW + 1_000);
      const [before, beforeLater] = [await store.committedSince(since), await store.committedSince(later)];
      const a = await store.plan(market(BASE + 3, 1_000));
      const b = await store.plan(market(BASE + 4, 1_000));
      const c = await store.plan(market(BASE + 5, 1_000));
      if (!a || !b || !c) throw new Error('not planned');
      const signedAt = new Date(NOW);
      await store.transition(a.id, 'planned', { status: 'signed', quotedUsdcBase: 50_000_000, signedAt });
      await store.transition(b.id, 'planned', { status: 'registered', quotedUsdcBase: 30_000_000, signedAt });
      // Quoted but never signed: not committed.
      await store.transition(c.id, 'planned', { status: 'quoted', quotedUsdcBase: 99_000_000 });
      expect((await store.committedSince(since)) - before).toBe(80_000_000);
      expect((await store.committedSince(later)) - beforeLater).toBe(0);
      const mine = (await store.withStatus(['signed', 'registered'])).filter(
        (row) => row.epoch >= BASE && row.epoch < BASE + 100,
      );
      expect(mine.map((row) => row.epoch)).toEqual([BASE + 3, BASE + 4]);
    });

    it('reads finished epochs newest first', async () => {
      expect(await history.recent(BASE + 50, 2)).toEqual([
        { epoch: BASE + 49, value: 1_284 },
        { epoch: BASE + 48, value: 1_250 },
      ]);
    });
  });
}

const HISTORY = [
  { epoch: BASE + 48, value: 1_250 },
  { epoch: BASE + 49, value: 1_284 },
  { epoch: BASE + 50, value: 1_400 },
];

contract('MemoryMarketStore', async () => ({
  store: new MemoryMarketStore(),
  history: new MemoryIndexHistory(HISTORY),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgMarketStore (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  contract('PgMarketStore', async () => {
    const db = PostgresConnectionManager.getDb();
    const range = (column: typeof pantaMarkets.epoch | typeof epochIndex.epoch) =>
      and(gte(column, BASE), lt(column, BASE + 100));
    await db.delete(pantaMarkets).where(range(pantaMarkets.epoch));
    await db.delete(epochIndex).where(range(epochIndex.epoch));
    await db.insert(epochIndex).values(HISTORY);
    return { store: new PgMarketStore(db), history: new PgIndexHistory(db) };
  });
});
