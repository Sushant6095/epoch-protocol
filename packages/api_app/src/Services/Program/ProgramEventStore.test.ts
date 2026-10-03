import { PostgresConnectionManager, programEvents, indexerCursors, runMigrations } from '@epoch/pg_models';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { MemoryEventStore, PgEventStore, type ProgramEventStore } from './ProgramEventStore';

const event = (slot: number, ix: number, name: StoredProgramEvent['name'], data: StoredProgramEvent['data']) =>
  ({
    signature: `sig${slot}`,
    ix,
    slot,
    epoch: 7,
    blockTime: '2026-10-03T00:00:00.000Z',
    name,
    data,
  }) as StoredProgramEvent;

const EVENTS = [
  event(10, 0, 'Deposited', { owner: 'alice', tranche: 'senior', assets: '5' }),
  event(11, 0, 'Deposited', { owner: 'bob', tranche: 'junior', assets: '7' }),
  event(11, 1, 'WithdrawRequested', { owner: 'alice', seq: '0' }),
  event(12, 0, 'SwapOpened', { taker: 'bob', quote: 'q1', epoch: '9' }),
];

function contract(name: string, make: () => Promise<ProgramEventStore>) {
  describe(name, () => {
    let store: ProgramEventStore;
    beforeEach(async () => {
      store = await make();
    });

    it('stores each (signature, ix) once and returns only the new ones', async () => {
      expect(await store.insert(EVENTS)).toHaveLength(4);
      expect(await store.insert([EVENTS[0], event(13, 0, 'Accrued', { epoch: '8' })])).toEqual([
        event(13, 0, 'Accrued', { epoch: '8' }),
      ]);
    });

    it('filters by name, payload field and slot range, newest first by default', async () => {
      await store.insert(EVENTS);
      const deposits = await store.query({ names: ['Deposited'] });
      expect(deposits.map((e) => e.data.owner)).toEqual(['bob', 'alice']);
      expect((await store.query({ where: { owner: 'alice' }, order: 'asc' })).map((e) => e.name)).toEqual([
        'Deposited',
        'WithdrawRequested',
      ]);
      expect(await store.query({ sinceSlot: 11, beforeSlot: 12, limit: 1 })).toEqual([EVENTS[2]]);
      expect(await store.query({ names: [] })).toEqual([]);
    });

    it('keeps a cursor', async () => {
      expect(await store.getCursor('c')).toBeNull();
      await store.setCursor('c', { slot: 5, signature: 's5' });
      await store.setCursor('c', { slot: 6, signature: 's6' });
      expect(await store.getCursor('c')).toEqual({ slot: 6, signature: 's6' });
    });
  });
}

contract('MemoryEventStore', async () => new MemoryEventStore());

describe('MemoryEventStore capacity', () => {
  it('drops the oldest events beyond its capacity', async () => {
    const store = new MemoryEventStore(2);
    await store.insert(EVENTS);
    expect((await store.query({ order: 'asc' })).map((e) => e.slot)).toEqual([11, 12]);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgEventStore (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  contract('PgEventStore', async () => {
    const db = PostgresConnectionManager.getDb();
    await db.delete(programEvents);
    await db.delete(indexerCursors);
    return new PgEventStore(db);
  });
});
