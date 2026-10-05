import {
  encodeLivePayload,
  type EpochDb,
  epochIndex,
  epochStakes,
  feeIndexLive,
  indexerCursors,
  LIVE_NOTIFY_CHANNEL,
  type LiveIndexPayload,
  type LiveSlotPayload,
  liveSlots,
  slotFees,
  SolamiUsageStore,
} from '@epoch/pg_models';
import { type SolamiUsageReport } from '@epoch/solana';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { type BlockFeesResult } from '../Blocks/BlockFees';
import { type SlotFeeRow } from './SlotFeeRepository';

/** Where a processed block came from. */
export type SlotSource = 'grpc' | 'hybrid' | 'rpc' | 'gap-fill';

export interface SlotRecord {
  fees: BlockFeesResult;
  epoch: number;
  blockTime: number | null;
  source: SlotSource;
}

/** The contiguous run of done slots (see SlotWatermark): what a restart resumes from. */
export interface IndexerCursor {
  watermark: number;
  runStart: number;
}

export interface StakeRow {
  epoch: number;
  stakes: Map<string, bigint>;
}

export type EpochIndexWrite = 'written' | 'posted';

/** Postgres as the indexer uses it (an in-memory fake in tests). */
export interface IndexerStore {
  /**
   * One transaction: slot_fees for slots with priced transactions (the index input), live_slots for every block, a
   * NOTIFY per live slot, and the cursor. Delivered to listeners only if it commits.
   */
  writeBatch(batch: { records: SlotRecord[]; notify: LiveSlotPayload[]; cursor?: IndexerCursor }): Promise<void>;
  readCursor(): Promise<IndexerCursor | null>;
  /** fee_index_live upsert and its NOTIFY. */
  writeLive(live: LiveIndexPayload): Promise<void>;
  /** An epoch's slot_fees rows, ascending slot. */
  epochRows(epoch: number): Promise<SlotFeeRow[]>;
  saveStakes(epoch: number, stakes: ReadonlyMap<string, bigint>): Promise<void>;
  /** The stake snapshot taken during `epoch`, else the earliest later one (null when there is none). */
  stakesFor(epoch: number): Promise<StakeRow | null>;
  /** epoch_index, unless that epoch was already posted on-chain (then nothing changes). NOTIFY on write. */
  writeEpochIndex(epoch: number, value: number): Promise<EpochIndexWrite>;
  /** Keeps the newest `keep` live_slots rows. */
  pruneLiveSlots(keep: number): Promise<number>;
  /** This process's Solami usage (solami_usage row `indexer`), read by GET /v1/live/solami. */
  writeUsage(report: SolamiUsageReport): Promise<void>;
}

export const CURSOR_NAME = 'slot_stream';
export const CURSOR_START_NAME = 'slot_stream_start';
const CHUNK = 500;
const EPOCH_PAGE = 50_000;

const toDate = (unixSeconds: number | null): Date | null =>
  unixSeconds === null ? null : new Date(unixSeconds * 1000);

export class PgIndexerStore implements IndexerStore {
  constructor(private readonly db: EpochDb) {}

  async writeBatch(batch: { records: SlotRecord[]; notify: LiveSlotPayload[]; cursor?: IndexerCursor }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const priced = batch.records.filter((r) => r.fees.medianCuPrice !== null && r.fees.pricedTxs > 0);
      for (let i = 0; i < priced.length; i += CHUNK) {
        await tx
          .insert(slotFees)
          .values(
            priced.slice(i, i + CHUNK).map((r) => ({
              slot: r.fees.slot,
              epoch: r.epoch,
              leader: r.fees.leader,
              medianCuPrice: r.fees.medianCuPrice as number,
              txCount: r.fees.pricedTxs,
            })),
          )
          .onConflictDoNothing();
      }
      for (let i = 0; i < batch.records.length; i += CHUNK) {
        await tx
          .insert(liveSlots)
          .values(
            batch.records.slice(i, i + CHUNK).map((r) => ({
              slot: r.fees.slot,
              epoch: r.epoch,
              leader: r.fees.leader,
              blockTime: toDate(r.blockTime),
              medianCuPrice: r.fees.medianCuPrice,
              p25CuPrice: r.fees.p25CuPrice,
              p75CuPrice: r.fees.p75CuPrice,
              p90CuPrice: r.fees.p90CuPrice,
              pricedTxs: r.fees.pricedTxs,
              unpricedTxs: r.fees.unpricedTxs,
              leaderPaidTxs: r.fees.leaderPaidTxs,
              failedTxs: r.fees.failedTxs,
              source: r.source,
            })),
          )
          .onConflictDoNothing();
      }
      if (batch.cursor) {
        const now = new Date();
        for (const [name, slot] of [
          [CURSOR_NAME, batch.cursor.watermark],
          [CURSOR_START_NAME, batch.cursor.runStart],
        ] as const) {
          await tx
            .insert(indexerCursors)
            .values({ name, slot, updatedAt: now })
            .onConflictDoUpdate({ target: indexerCursors.name, set: { slot, updatedAt: now } });
        }
      }
      for (const payload of batch.notify) {
        await tx.execute(sql`select pg_notify(${LIVE_NOTIFY_CHANNEL}, ${encodeLivePayload(payload)})`);
      }
    });
  }

  async readCursor(): Promise<IndexerCursor | null> {
    const rows = await this.db
      .select({ name: indexerCursors.name, slot: indexerCursors.slot })
      .from(indexerCursors)
      .where(inArray(indexerCursors.name, [CURSOR_NAME, CURSOR_START_NAME]));
    const watermark = rows.find((r) => r.name === CURSOR_NAME)?.slot;
    const runStart = rows.find((r) => r.name === CURSOR_START_NAME)?.slot;
    return watermark === undefined || runStart === undefined ? null : { watermark, runStart };
  }

  async writeLive(live: LiveIndexPayload): Promise<void> {
    const values = {
      epoch: live.epoch,
      estimate: live.estimate,
      leaders: live.leaders,
      slotsWithFees: live.slotsWithFees,
      pricedTxs: live.pricedTxs,
      firstSlot: live.firstSlot,
      processedSlot: live.processedSlot,
      watermarkSlot: live.watermarkSlot,
      tipSlot: live.tipSlot,
      stakeEpoch: live.stakeEpoch,
      source: live.source,
      endpoint: live.endpoint,
      status: live.status,
      stride: live.stride,
      lastSlotAt: live.lastSlotAt === null ? null : new Date(live.lastSlotAt),
      updatedAt: new Date(),
    };
    await this.db.transaction(async (tx) => {
      await tx.insert(feeIndexLive).values(values).onConflictDoUpdate({ target: feeIndexLive.epoch, set: values });
      await tx.execute(sql`select pg_notify(${LIVE_NOTIFY_CHANNEL}, ${encodeLivePayload(live)})`);
    });
  }

  async epochRows(epoch: number): Promise<SlotFeeRow[]> {
    const out: SlotFeeRow[] = [];
    let after = -1;
    for (;;) {
      const page = await this.db
        .select({
          slot: slotFees.slot,
          epoch: slotFees.epoch,
          leader: slotFees.leader,
          medianCuPrice: slotFees.medianCuPrice,
          txCount: slotFees.txCount,
        })
        .from(slotFees)
        .where(and(eq(slotFees.epoch, epoch), gt(slotFees.slot, after)))
        .orderBy(asc(slotFees.slot))
        .limit(EPOCH_PAGE);
      out.push(...page);
      if (page.length < EPOCH_PAGE) return out;
      after = page[page.length - 1].slot;
    }
  }

  async saveStakes(epoch: number, stakes: ReadonlyMap<string, bigint>): Promise<void> {
    const rows = [...stakes].map(([identity, stakeLamports]) => ({ epoch, identity, stakeLamports }));
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx
          .insert(epochStakes)
          .values(rows.slice(i, i + CHUNK))
          .onConflictDoUpdate({
            target: [epochStakes.epoch, epochStakes.identity],
            set: { stakeLamports: sql`excluded.stake_lamports`, takenAt: new Date() },
          });
      }
    });
  }

  async stakesFor(epoch: number): Promise<StakeRow | null> {
    const [first] = await this.db
      .select({ epoch: epochStakes.epoch })
      .from(epochStakes)
      .where(gte(epochStakes.epoch, epoch))
      .orderBy(asc(epochStakes.epoch))
      .limit(1);
    if (!first) return null;
    const rows = await this.db
      .select({ identity: epochStakes.identity, stakeLamports: epochStakes.stakeLamports })
      .from(epochStakes)
      .where(eq(epochStakes.epoch, first.epoch));
    return { epoch: first.epoch, stakes: new Map(rows.map((r) => [r.identity, r.stakeLamports])) };
  }

  async writeEpochIndex(epoch: number, value: number): Promise<EpochIndexWrite> {
    return this.db.transaction(async (tx) => {
      const written = await tx
        .insert(epochIndex)
        .values({ epoch, value, computedAt: new Date() })
        .onConflictDoUpdate({
          target: epochIndex.epoch,
          set: { value, computedAt: new Date() },
          // A value already posted on-chain is final: never rewrite it.
          setWhere: isNull(epochIndex.postedSignature),
        })
        .returning({ epoch: epochIndex.epoch });
      if (written.length === 0) return 'posted';
      await tx.execute(
        sql`select pg_notify(${LIVE_NOTIFY_CHANNEL}, ${encodeLivePayload({ t: 'epoch', epoch, value })})`,
      );
      return 'written';
    });
  }

  async pruneLiveSlots(keep: number): Promise<number> {
    const [edge] = await this.db
      .select({ slot: liveSlots.slot })
      .from(liveSlots)
      .orderBy(desc(liveSlots.slot))
      .offset(keep)
      .limit(1);
    if (!edge) return 0;
    const result = await this.db.delete(liveSlots).where(lt(liveSlots.slot, edge.slot + 1));
    return result.rowCount ?? 0;
  }

  async writeUsage(report: SolamiUsageReport): Promise<void> {
    await new SolamiUsageStore(this.db).save(report);
  }
}
