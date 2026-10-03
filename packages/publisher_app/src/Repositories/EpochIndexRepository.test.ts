import { epochIndex, PostgresConnectionManager, runMigrations, slotFees } from '@epoch/pg_models';

import { MemoryIndexStore, slotRows } from '../__fixtures__/fakes';
import { computeInputsHash, type SlotFeeInput } from '../Index/InputsHash';
import { type IndexStore, PgIndexStore } from './EpochIndexRepository';

interface Seed {
  rows: { epoch: number; value: number; postedSignature: string | null }[];
  slots: SlotFeeInput[];
}

const SEED: Seed = {
  rows: [
    { epoch: 1_045, value: 990, postedSignature: 'sig1045' },
    { epoch: 1_046, value: 1_000, postedSignature: null },
    { epoch: 1_047, value: 1_010, postedSignature: null },
    { epoch: 1_044, value: 980, postedSignature: null },
  ],
  // 1046 has more slots than one page would hold in a small-page run; out of order on purpose.
  slots: [...slotRows(1_047, 3), ...slotRows(1_046, 5).reverse()],
};

function contract(name: string, make: (seed: Seed) => Promise<IndexStore>) {
  describe(name, () => {
    let store: IndexStore;
    beforeEach(async () => {
      store = await make(SEED);
    });

    it('finds the latest posted row and the unposted ones after it, oldest first', async () => {
      expect(await store.latestPosted()).toEqual({ epoch: 1_045, value: 990, postedSignature: 'sig1045' });
      expect((await store.unposted(1_045)).map((r) => r.epoch)).toEqual([1_046, 1_047]);
      expect((await store.unposted(null)).map((r) => r.epoch)).toEqual([1_044, 1_046, 1_047]);
    });

    it('marks a row posted once', async () => {
      expect(await store.markPosted(1_046, 'sigA')).toBe(true);
      expect(await store.markPosted(1_046, 'sigB')).toBe(false);
      expect(await store.markPosted(9_999, 'sigC')).toBe(false);
      expect(await store.latestPosted()).toMatchObject({ epoch: 1_046, postedSignature: 'sigA' });
    });

    it('hashes an epoch’s slot_fees rows in slot order', async () => {
      const { hash, slots } = await store.inputsHash(1_046);
      expect(slots).toBe(5);
      expect(Buffer.from(hash)).toEqual(Buffer.from(computeInputsHash(1_046, slotRows(1_046, 5))));
      expect((await store.inputsHash(2_000)).slots).toBe(0);
    });
  });
}

contract('MemoryIndexStore', async (seed) => {
  const store = new MemoryIndexStore();
  for (const row of seed.rows) {
    const slots = seed.slots.filter((s) => Math.floor(s.slot / 432_000) === row.epoch).sort((a, b) => a.slot - b.slot);
    store.add(row.epoch, row.value, row.postedSignature, slots);
  }
  return store;
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgIndexStore (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  contract('PgIndexStore', async (seed) => {
    const db = PostgresConnectionManager.getDb();
    await db.delete(epochIndex);
    await db.delete(slotFees);
    await db.insert(epochIndex).values(seed.rows);
    await db.insert(slotFees).values(seed.slots.map((s) => ({ ...s, epoch: Math.floor(s.slot / 432_000) })));
    return new PgIndexStore(db);
  });
});
