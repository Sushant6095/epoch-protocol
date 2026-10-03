import { type PoolAccount } from '@epoch/epoch-sdk';
import { type EpochDb, PostgresConnectionManager, poolSnapshots, runMigrations } from '@epoch/pg_models';
import { asc, TransactionRollbackError } from 'drizzle-orm';

import { EventBus, type StoredProgramEvent } from '../../Lib/EventBus';
import {
  PgPoolSnapshotRepo,
  type PoolReader,
  PoolSnapshotRecorder,
  type PoolSnapshotRepo,
  type PoolSnapshotRow,
  snapshotRow,
  utilizationBps,
} from './PoolSnapshotRecorder';
import { MemoryEventStore } from './ProgramEventStore';

const SOL = 1_000_000_000n;

const pool = (overrides: Partial<PoolAccount> = {}): PoolAccount =>
  ({
    cash: 140n * SOL,
    outstandingPrincipal: 60n * SOL,
    seniorAssets: 150n * SOL,
    seniorShares: 150_000n * SOL,
    juniorAssets: 50n * SOL,
    juniorShares: 50_000n * SOL,
    ...overrides,
  }) as PoolAccount;

const accrued = (slot: number, epoch: number, senior: number, junior: number): StoredProgramEvent => ({
  signature: `sig${slot}`,
  ix: 0,
  slot,
  epoch,
  blockTime: null,
  name: 'Accrued',
  data: { epoch: String(epoch), seniorPriceE9: String(senior), juniorPriceE9: String(junior), income: '1' },
});

class FakeRepo implements PoolSnapshotRepo {
  rows = new Map<number, PoolSnapshotRow>();
  async isEmpty(): Promise<boolean> {
    return this.rows.size === 0;
  }
  async upsert(row: PoolSnapshotRow): Promise<void> {
    this.rows.set(row.epoch, row);
  }
  async insertMissing(rows: readonly PoolSnapshotRow[]): Promise<number> {
    const fresh = rows.filter((row) => !this.rows.has(row.epoch));
    for (const row of fresh) this.rows.set(row.epoch, row);
    return fresh.length;
  }
}

async function build(options: { stored?: StoredProgramEvent[]; repo?: FakeRepo | null; poolReader?: PoolReader } = {}) {
  const events = new MemoryEventStore();
  await events.insert(options.stored ?? []);
  const bus = new EventBus();
  const repo = options.repo === undefined ? new FakeRepo() : options.repo;
  const reader: PoolReader = options.poolReader ?? {
    requirePool: jest.fn(async () => ({ address: 'pool', account: pool() })),
  };
  let tick = 0;
  const recorder = new PoolSnapshotRecorder({
    pool: reader,
    events,
    repo,
    bus,
    enabled: true,
    now: () => new Date(Date.UTC(2026, 9, 3, 0, 0, tick++)),
  });
  return { recorder, bus, repo, reader };
}

describe('PoolSnapshotRecorder', () => {
  it('computes utilization as outstanding × 10,000 ÷ total assets', () => {
    expect(utilizationBps(pool())).toBe(3_000);
    expect(utilizationBps(pool({ seniorAssets: 0n, juniorAssets: 0n }))).toBe(0);
    expect(snapshotRow(accrued(1, 1044, 1_000_812, 1_002_345), pool(), new Date(0))).toEqual({
      epoch: 1044,
      seniorAssets: 150n * SOL,
      seniorShares: 150_000n * SOL,
      juniorAssets: 50n * SOL,
      juniorShares: 50_000n * SOL,
      outstandingPrincipal: 60n * SOL,
      cash: 140n * SOL,
      seniorPriceE9: 1_000_812,
      juniorPriceE9: 1_002_345,
      utilizationBps: 3_000,
      recordedAt: new Date(0),
    });
  });

  it('backfills an empty table from the stored Accrued events, all with one recorded_at', async () => {
    const { recorder, repo } = await build({
      stored: [accrued(10, 1042, 1_000_100, 1_000_900), accrued(20, 1043, 1_000_200, 1_001_800)],
    });
    expect(await recorder.backfill()).toBe(2);
    const rows = [...repo!.rows.values()];
    expect(rows.map((r) => [r.epoch, r.seniorPriceE9, r.juniorPriceE9, r.utilizationBps])).toEqual([
      [1042, 1_000_100, 1_000_900, 3_000],
      [1043, 1_000_200, 1_001_800, 3_000],
    ]);
    expect(new Set(rows.map((r) => r.recordedAt.getTime())).size).toBe(1);
    // Not empty any more: a second backfill writes nothing.
    expect(await recorder.backfill()).toBe(0);
  });

  it('upserts the row for each Accrued event on the bus, reading the Pool after it', async () => {
    const { recorder, bus, repo, reader } = await build();
    recorder.start();
    await recorder.idle();
    bus.emit('programEvent', accrued(30, 1044, 1_000_300, 1_002_000));
    bus.emit('programEvent', { ...accrued(31, 1044, 0, 0), name: 'Deposited' }); // ignored
    await recorder.idle();
    expect(repo!.rows.get(1044)).toMatchObject({ seniorPriceE9: 1_000_300, juniorPriceE9: 1_002_000 });
    expect(reader.requirePool).toHaveBeenCalledTimes(1);
    recorder.stop();
    bus.emit('programEvent', accrued(40, 1045, 1, 1));
    await recorder.idle();
    expect(repo!.rows.has(1045)).toBe(false);
  });

  it('keeps going when the Pool cannot be read', async () => {
    const requirePool = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('no pool'), { code: 'POOL_NOT_INITIALIZED' }))
      .mockResolvedValue({ address: 'pool', account: pool() });
    const { recorder, bus, repo } = await build({ poolReader: { requirePool } });
    recorder.start();
    bus.emit('programEvent', accrued(30, 1044, 1, 1));
    bus.emit('programEvent', accrued(31, 1045, 2, 2));
    await recorder.idle();
    expect([...repo!.rows.keys()]).toEqual([1045]);
  });

  it('does nothing without a database or without the program', async () => {
    const { recorder, bus } = await build({ repo: null });
    recorder.start();
    bus.emit('programEvent', accrued(30, 1044, 1, 1));
    await recorder.idle();
    expect(await recorder.backfill()).toBe(0);

    const requirePool = jest.fn();
    const repo = new FakeRepo();
    const disabled = new PoolSnapshotRecorder({
      pool: { requirePool },
      events: new MemoryEventStore(),
      repo,
      bus,
      enabled: false,
    });
    disabled.start();
    bus.emit('programEvent', accrued(31, 1045, 1, 1));
    await disabled.idle();
    expect(requirePool).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(0);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgPoolSnapshotRepo (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  /** Runs `test` in a snapshot transaction that is always rolled back: parallel test files never see its rows. */
  const inRollback = (test: (db: EpochDb) => Promise<void>) =>
    PostgresConnectionManager.getDb()
      .transaction(
        async (tx) => {
          await test(tx as unknown as EpochDb);
          tx.rollback();
        },
        { isolationLevel: 'repeatable read' },
      )
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

  it('inserts, replaces and fills in rows by epoch', () =>
    inRollback(async (db) => {
      await db.delete(poolSnapshots);
      const repo = new PgPoolSnapshotRepo(db);
      expect(await repo.isEmpty()).toBe(true);
      const row = snapshotRow(accrued(1, 1044, 1_000_100, 1_000_900), pool(), new Date('2026-10-03T00:00:00Z'));
      await repo.upsert(row);
      await repo.upsert({ ...row, seniorPriceE9: 1_000_150, cash: 141n * SOL });
      expect(await repo.isEmpty()).toBe(false);
      expect(
        await repo.insertMissing([
          { ...row, seniorPriceE9: 1 },
          { ...row, epoch: 1045 },
        ]),
      ).toBe(1);
      const rows = await db.select().from(poolSnapshots).orderBy(asc(poolSnapshots.epoch));
      expect(rows.map((r) => [r.epoch, r.seniorPriceE9, r.cash, r.utilizationBps])).toEqual([
        [1044, 1_000_150, 141n * SOL, 3_000],
        [1045, 1_000_100, 140n * SOL, 3_000],
      ]);
    }));
});
