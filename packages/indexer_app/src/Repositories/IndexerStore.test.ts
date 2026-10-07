import { sleep } from '@epoch/common';
import {
  decodeLivePayload,
  type EpochDb,
  epochFeeMix,
  epochIndex,
  feeIndexLive,
  LIVE_NOTIFY_CHANNEL,
  type LiveIndexPayload,
  type LivePayload,
  type LiveSlotPayload,
  liveSlots,
  PgListener,
  PostgresConnectionManager,
  runMigrations,
  slotFeeMix,
  slotFees,
} from '@epoch/pg_models';
import { asc, count, eq, TransactionRollbackError } from 'drizzle-orm';

import { type BlockFeesResult } from '../Blocks/BlockFees';
import { type BlockFeeMix } from '../Blocks/FeeMix';
import { MemoryIndexerStore } from './MemoryIndexerStore';
import { PgIndexerStore, rollUpFeeMix, type SlotRecord } from './IndexerStore';

const TEST_DB = process.env.TEST_DATABASE_URL;
const LEADER = '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS';
// CI runs every package's test files in parallel against one database: these tests use epochs and slots no other test
// file uses, write inside transactions that are rolled back, and never delete rows they did not write.
const EPOCH = 7_101;
const S = EPOCH * 432_000;
const NOTIFY_EPOCH = 7_190;
/** slot_fee_mix rows only these tests write (the table is new in migration 0004). */
const MIX_EPOCH = 7_301;
const MS = MIX_EPOCH * 432_000;
const NS = NOTIFY_EPOCH * 432_000;

const fees = (slot: number, median: number | null): BlockFeesResult => ({
  slot,
  leader: LEADER,
  medianCuPrice: median,
  p25CuPrice: median,
  p75CuPrice: median,
  p90CuPrice: median,
  pricedTxs: median === null ? 0 : 12,
  unpricedTxs: 3,
  leaderPaidTxs: 0,
  failedTxs: 1,
});
const record = (
  slot: number,
  median: number | null,
  source: SlotRecord['source'] = 'grpc',
  epoch = EPOCH,
): SlotRecord => ({ fees: fees(slot, median), epoch, blockTime: 1_791_031_700, source });

const mix = (base: bigint, tips: bigint, basis: BlockFeeMix['baseFeeBasis'] = 'counted'): BlockFeeMix => ({
  baseLamports: base,
  priorityLamports: 1_000_000n,
  tipLamports: tips,
  tipTxs: tips > 0n ? 2 : 0,
  voteTxs: 600,
  nonVoteTxs: 300,
  feeRewardLamports: 1_000_000n + base / 2n,
  baseFeeBasis: basis,
  rewardMatches: basis === 'counted' ? true : null,
});

const mixRecord = (slot: number, epoch: number, base: bigint, tips: bigint, basis?: BlockFeeMix['baseFeeBasis']) => ({
  ...record(slot, 5_000, 'grpc', epoch),
  feeMix: mix(base, tips, basis),
});

describe('rollUpFeeMix', () => {
  it('sums rows per epoch with block counts, slot range and estimated blocks', () => {
    const row = (slot: number, epoch: number, basis: string) => ({
      slot,
      epoch,
      baseFeeLamports: 5_000n,
      priorityFeeLamports: 7n,
      tipLamports: 3n,
      tipTxs: 1,
      voteTxs: 2,
      nonVoteTxs: 4,
      feeRewardLamports: basis === 'estimated' ? null : 2_507n,
      baseFeeBasis: basis,
    });
    expect(rollUpFeeMix([row(10, 1, 'counted'), row(8, 1, 'estimated'), row(20, 2, 'reward')])).toEqual([
      {
        epoch: 1,
        blocks: 2,
        baseFeeLamports: 10_000n,
        priorityFeeLamports: 14n,
        tipLamports: 6n,
        tipTxs: 2,
        voteTxs: 4,
        nonVoteTxs: 8,
        feeRewardLamports: 2_507n,
        estimatedBlocks: 1,
        firstSlot: 8,
        lastSlot: 10,
      },
      expect.objectContaining({ epoch: 2, blocks: 1, firstSlot: 20, lastSlot: 20 }),
    ]);
  });
});

describe('MemoryIndexerStore fee mix', () => {
  it('rolls each slot up once and prunes old epochs', async () => {
    const store = new MemoryIndexerStore();
    await store.writeBatch({ records: [mixRecord(1, 1, 10_000n, 5n), mixRecord(2, 1, 20_000n, 0n)], notify: [] });
    await store.writeBatch({ records: [mixRecord(2, 1, 99_999n, 9n), mixRecord(3, 2, 5_000n, 1n)], notify: [] });
    expect(store.epochFeeMix.get(1)).toMatchObject({ blocks: 2, baseFeeLamports: 30_000n, tipLamports: 5n, tipTxs: 2 });
    expect(store.epochFeeMix.get(2)).toMatchObject({ blocks: 1, baseFeeLamports: 5_000n });
    expect(await store.pruneFeeMix(1)).toBe(2);
    expect([...store.feeMix.keys()]).toEqual([3]);
    expect(store.epochFeeMix.get(1)?.blocks).toBe(2);
  });
});

const LIVE: LiveIndexPayload = {
  t: 'index',
  epoch: EPOCH,
  estimate: 9_500,
  leaders: 812,
  slotsWithFees: 1_000,
  pricedTxs: 120_000,
  firstSlot: S,
  processedSlot: S + 201_400,
  watermarkSlot: S + 201_390,
  tipSlot: S + 201_404,
  stakeEpoch: EPOCH,
  source: 'grpc',
  endpoint: 'solami',
  status: 'streaming',
  stride: 1,
  lastSlotAt: 1_791_031_701_000,
};

const SLOT: LiveSlotPayload = {
  t: 'slot',
  slot: NS + 1,
  epoch: NOTIFY_EPOCH,
  leader: LEADER,
  medianCuPrice: 10_000,
  p25CuPrice: 870,
  p75CuPrice: 312_500,
  p90CuPrice: 1_134_380,
  pricedTxs: 132,
  unpricedTxs: 101,
  leaderPaidTxs: 0,
  failedTxs: 31,
  blockTime: 1_791_031_700,
  source: 'grpc',
};

(TEST_DB ? describe : describe.skip)('PgIndexerStore (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });

  afterAll(() => PostgresConnectionManager.close());

  /** Runs `test` in a snapshot transaction that is always rolled back (the store's own transactions nest as savepoints). */
  const inRollback = (test: (store: PgIndexerStore, db: EpochDb) => Promise<void>) =>
    PostgresConnectionManager.getDb()
      .transaction(
        async (tx) => {
          const db = tx as unknown as EpochDb;
          await test(new PgIndexerStore(db), db);
          tx.rollback();
        },
        { isolationLevel: 'repeatable read' },
      )
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

  it('writes a batch: priced slots to slot_fees, every block to live_slots, and the cursor', () =>
    inRollback(async (store, db) => {
      await store.writeBatch({
        records: [record(S + 1, 10_000), record(S + 2, null), record(S + 3, 7_700, 'gap-fill')],
        notify: [],
        cursor: { watermark: S + 3, runStart: S },
      });
      expect(await store.epochRows(EPOCH)).toEqual([
        { slot: S + 1, epoch: EPOCH, leader: LEADER, medianCuPrice: 10_000, txCount: 12 },
        { slot: S + 3, epoch: EPOCH, leader: LEADER, medianCuPrice: 7_700, txCount: 12 },
      ]);
      const live = await db.select().from(liveSlots).where(eq(liveSlots.epoch, EPOCH)).orderBy(asc(liveSlots.slot));
      expect(live.map((r) => [r.slot, r.medianCuPrice, r.pricedTxs, r.source])).toEqual([
        [S + 1, 10_000, 12, 'grpc'],
        [S + 2, null, 0, 'grpc'],
        [S + 3, 7_700, 12, 'gap-fill'],
      ]);
      expect(live[0].blockTime?.toISOString()).toBe('2026-10-03T12:48:20.000Z');
      expect(await store.readCursor()).toEqual({ watermark: S + 3, runStart: S });

      // Replayed slots are written once.
      await store.writeBatch({ records: [record(S + 1, 1)], notify: [] });
      expect((await store.epochRows(EPOCH))[0].medianCuPrice).toBe(10_000);
    }));

  it('writes slot_fee_mix and adds each slot to epoch_fee_mix exactly once', () =>
    inRollback(async (store, db) => {
      await store.writeBatch({
        records: [mixRecord(MS + 1, MIX_EPOCH, 3_300_000n, 6_287_601n), mixRecord(MS + 2, MIX_EPOCH, 3_400_000n, 0n)],
        notify: [],
      });
      // A replay of slot 2 (different figures, as a second source might report) and a new slot, one of them estimated.
      await store.writeBatch({
        records: [
          mixRecord(MS + 2, MIX_EPOCH, 9_999_999n, 1n),
          mixRecord(MS + 5, MIX_EPOCH, 3_000_000n, 1_000n, 'estimated'),
          record(MS + 6, null, 'grpc', MIX_EPOCH),
        ],
        notify: [],
      });
      const rows = await db
        .select()
        .from(slotFeeMix)
        .where(eq(slotFeeMix.epoch, MIX_EPOCH))
        .orderBy(asc(slotFeeMix.slot));
      expect(rows.map((r) => [r.slot, r.baseFeeLamports, r.tipLamports, r.baseFeeBasis])).toEqual([
        [MS + 1, 3_300_000n, 6_287_601n, 'counted'],
        [MS + 2, 3_400_000n, 0n, 'counted'],
        [MS + 5, 3_000_000n, 1_000n, 'estimated'],
      ]);
      const [epoch] = await db.select().from(epochFeeMix).where(eq(epochFeeMix.epoch, MIX_EPOCH));
      expect(epoch).toMatchObject({
        blocks: 3,
        baseFeeLamports: 9_700_000n,
        priorityFeeLamports: 3_000_000n,
        tipLamports: 6_288_601n,
        tipTxs: 4,
        voteTxs: 1_800,
        nonVoteTxs: 900,
        feeRewardLamports: 3_000_000n + 4_850_000n,
        estimatedBlocks: 1,
        firstSlot: MS + 1,
        lastSlot: MS + 5,
      });
    }));

  it('prunes slot_fee_mix to the newest epochs and keeps epoch_fee_mix', () =>
    inRollback(async (store, db) => {
      await store.writeBatch({
        records: [
          mixRecord(MS + 10, MIX_EPOCH, 5_000n, 0n),
          mixRecord(MS + 432_000 + 10, MIX_EPOCH + 1, 5_000n, 0n),
          mixRecord(MS + 864_000 + 10, MIX_EPOCH + 2, 5_000n, 0n),
        ],
        notify: [],
      });
      expect(await store.pruneFeeMix(2)).toBeGreaterThanOrEqual(1);
      const left = await db.select({ epoch: slotFeeMix.epoch }).from(slotFeeMix).orderBy(asc(slotFeeMix.epoch));
      expect(left.map((r) => r.epoch).filter((e) => e >= MIX_EPOCH && e <= MIX_EPOCH + 2)).toEqual([
        MIX_EPOCH + 1,
        MIX_EPOCH + 2,
      ]);
      const totals = await db.select().from(epochFeeMix).where(eq(epochFeeMix.epoch, MIX_EPOCH));
      expect(totals[0]?.blocks).toBe(1);
    }));

  it('rolls a failed batch back entirely (no rows, cursor unchanged)', () =>
    inRollback(async (store) => {
      const before = await store.readCursor();
      await expect(
        store.writeBatch({
          // The second record breaks a NOT NULL constraint after the slot_fees insert ran.
          records: [record(S + 1, 10_000), { ...record(S + 2, 5), source: null as never }],
          notify: [],
          cursor: { watermark: S + 2, runStart: S + 1 },
        }),
      ).rejects.toThrow();
      expect(await store.epochRows(EPOCH)).toEqual([]);
      expect(await store.readCursor()).toEqual(before);
    }));

  it('upserts fee_index_live', () =>
    inRollback(async (store, db) => {
      await store.writeLive(LIVE);
      await store.writeLive({ ...LIVE, estimate: 9_600, status: 'reconnecting' });
      const rows = await db.select().from(feeIndexLive).where(eq(feeIndexLive.epoch, EPOCH));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ epoch: EPOCH, estimate: 9_600, status: 'reconnecting', leaders: 812, stride: 1 });
      expect(rows[0].lastSlotAt?.getTime()).toBe(1_791_031_701_000);
    }));

  it('keeps stake snapshots per epoch and falls back to the next later one', () =>
    inRollback(async (store) => {
      await store.saveStakes(EPOCH + 1, new Map([[LEADER, 13_000_000_000_000_005n]]));
      expect(await store.stakesFor(EPOCH)).toEqual({
        epoch: EPOCH + 1,
        stakes: new Map([[LEADER, 13_000_000_000_000_005n]]),
      });
      await store.saveStakes(EPOCH, new Map([[LEADER, 1n]]));
      await store.saveStakes(EPOCH, new Map([[LEADER, 2n]]));
      expect(await store.stakesFor(EPOCH)).toEqual({ epoch: EPOCH, stakes: new Map([[LEADER, 2n]]) });
      expect(await store.stakesFor(EPOCH + 2)).toBeNull();
    }));

  it('writes epoch_index, rewrites an unposted value, and never touches a posted one', () =>
    inRollback(async (store, db) => {
      expect(await store.writeEpochIndex(EPOCH, 9_000)).toBe('written');
      expect(await store.writeEpochIndex(EPOCH, 9_100)).toBe('written');
      await db.update(epochIndex).set({ postedSignature: 'sig' }).where(eq(epochIndex.epoch, EPOCH));
      expect(await store.writeEpochIndex(EPOCH, 1)).toBe('posted');
      const rows = await db.select({ value: epochIndex.value }).from(epochIndex).where(eq(epochIndex.epoch, EPOCH));
      expect(rows).toEqual([{ value: 9_100 }]);
    }));

  it('prunes live_slots to the newest rows', () =>
    inRollback(async (store, db) => {
      const [{ others }] = await db.select({ others: count() }).from(liveSlots);
      await store.writeBatch({ records: Array.from({ length: 10 }, (_, i) => record(S + 100 + i, 5)), notify: [] });
      // Our slots are the newest, so everything older than our last four goes.
      expect(await store.pruneLiveSlots(4)).toBe(others + 6);
      const left = await db.select({ slot: liveSlots.slot }).from(liveSlots).orderBy(asc(liveSlots.slot));
      expect(left.map((r) => r.slot)).toEqual([S + 106, S + 107, S + 108, S + 109]);
      expect(await store.pruneLiveSlots(4)).toBe(0);
    }));

  it('NOTIFYs slots, the running estimate and epoch values only when the write commits', async () => {
    const heard: LivePayload[] = [];
    const listener = new PgListener({
      channel: LIVE_NOTIFY_CHANNEL,
      connectionString: TEST_DB,
      onNotification: (payload) => {
        const decoded = decodeLivePayload(payload);
        // Other test files may notify on the same channel.
        if (decoded?.epoch === NOTIFY_EPOCH) heard.push(decoded);
      },
    });
    listener.start();
    try {
      for (let i = 0; i < 300 && !listener.isListening; i++) await sleep(10);
      expect(listener.isListening).toBe(true);

      // Rolled back: never announced.
      await inRollback((store) => store.writeLive({ ...LIVE, epoch: NOTIFY_EPOCH, estimate: 1 }));

      // Committed, after removing the rows again in the same transaction: the notifications go out, and no other test
      // file ever sees the rows.
      await PostgresConnectionManager.getDb().transaction(async (tx) => {
        const db = tx as unknown as EpochDb;
        const store = new PgIndexerStore(db);
        await store.writeBatch({ records: [record(NS + 1, 10_000, 'grpc', NOTIFY_EPOCH)], notify: [SLOT] });
        await store.writeLive({ ...LIVE, epoch: NOTIFY_EPOCH, estimate: 9_500 });
        await store.writeLive({ ...LIVE, epoch: NOTIFY_EPOCH, estimate: 9_600 });
        expect(await store.writeEpochIndex(NOTIFY_EPOCH, 9_000)).toBe('written');
        await db.delete(slotFees).where(eq(slotFees.epoch, NOTIFY_EPOCH));
        await db.delete(liveSlots).where(eq(liveSlots.epoch, NOTIFY_EPOCH));
        await db.delete(feeIndexLive).where(eq(feeIndexLive.epoch, NOTIFY_EPOCH));
        await db.delete(epochIndex).where(eq(epochIndex.epoch, NOTIFY_EPOCH));
      });

      for (let i = 0; i < 300 && heard.length < 4; i++) await sleep(10);
      expect(heard).toEqual([
        SLOT,
        expect.objectContaining({ t: 'index', epoch: NOTIFY_EPOCH, estimate: 9_500 }),
        expect.objectContaining({ t: 'index', epoch: NOTIFY_EPOCH, estimate: 9_600 }),
        { t: 'epoch', epoch: NOTIFY_EPOCH, value: 9_000 },
      ]);
    } finally {
      await listener.stop();
    }
  });
});
