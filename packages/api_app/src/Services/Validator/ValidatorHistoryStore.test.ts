import { PostgresConnectionManager, runMigrations, validatorEpochStats } from '@epoch/pg_models';

import {
  MemoryValidatorHistoryStore,
  PgValidatorHistoryStore,
  type ValidatorHistoryStore,
} from './ValidatorHistoryStore';

const byKey = (a: { vote: string; epoch: number }, b: { vote: string; epoch: number }) =>
  a.vote.localeCompare(b.vote) || a.epoch - b.epoch;

function contract(name: string, make: () => Promise<ValidatorHistoryStore>) {
  describe(name, () => {
    let store: ValidatorHistoryStore;
    beforeEach(async () => {
      store = await make();
    });

    it('merges fields into one row per (vote, epoch); null or missing keeps the stored value', async () => {
      await store.upsert([
        { vote: 'v', epoch: 10, commissionBps: 500, mevCommissionBps: 1_000, activeStakeLamports: 5n, credits: 7 },
      ]);
      await store.upsert([{ vote: 'v', epoch: 10, credits: 9, commissionBps: null }]);
      expect(await store.load(0)).toEqual([
        { vote: 'v', epoch: 10, commissionBps: 500, mevCommissionBps: 1_000, activeStakeLamports: 5n, credits: 9 },
      ]);
    });

    it('takes several rows for the same key in one batch and loads from an epoch on', async () => {
      await store.upsert([
        { vote: 'v', epoch: 11, commissionBps: 700 },
        { vote: 'v', epoch: 11, activeStakeLamports: 600_000_000_000_000_123n },
        { vote: 'w', epoch: 9, credits: 1 },
      ]);
      const rows = (await store.load(10)).sort(byKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        vote: 'v',
        epoch: 11,
        commissionBps: 700,
        activeStakeLamports: 600_000_000_000_000_123n,
      });
      expect((await store.load(0)).length).toBe(2);
    });
  });
}

contract('MemoryValidatorHistoryStore', async () => new MemoryValidatorHistoryStore());

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgValidatorHistoryStore (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  contract('PgValidatorHistoryStore', async () => {
    const db = PostgresConnectionManager.getDb();
    await db.delete(validatorEpochStats);
    return new PgValidatorHistoryStore(db);
  });
});
