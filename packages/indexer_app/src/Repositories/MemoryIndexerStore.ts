import { type LiveIndexPayload, type LivePayload, type LiveSlotPayload } from '@epoch/pg_models';
import { type SolamiUsageReport } from '@epoch/solana';

import {
  type EpochIndexWrite,
  type IndexerCursor,
  type IndexerStore,
  rollUpFeeMix,
  type SlotRecord,
  type StakeRow,
} from './IndexerStore';
import { type SlotFeeRow } from './SlotFeeRepository';

/** Notifications kept (the newest), so a long `pnpm demo:solami` run stays small. */
const MAX_NOTIFICATIONS = 5_000;

/**
 * IndexerStore in memory, with the same rules as PgIndexerStore (a posted epoch_index row is never rewritten): the
 * tests' store, and `pnpm demo:solami`'s, which must never touch a real indexer's cursor.
 */
export class MemoryIndexerStore implements IndexerStore {
  readonly slotFees = new Map<number, SlotFeeRow>();
  readonly liveSlots = new Map<number, SlotRecord>();
  /** slot_fee_mix, keyed by slot. */
  readonly feeMix = new Map<number, SlotRecord>();
  /** epoch_fee_mix, keyed by epoch. */
  readonly epochFeeMix = new Map<number, ReturnType<typeof rollUpFeeMix>[number]>();
  readonly notifications: LivePayload[] = [];
  readonly live = new Map<number, LiveIndexPayload>();
  readonly stakes = new Map<number, Map<string, bigint>>();
  readonly epochIndex = new Map<number, { value: number; postedSignature: string | null }>();
  cursor: IndexerCursor | null = null;
  usage: SolamiUsageReport | null = null;
  batches = 0;
  failNextBatch = false;

  async writeBatch(batch: { records: SlotRecord[]; notify: LiveSlotPayload[]; cursor?: IndexerCursor }) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('connection terminated');
    }
    this.batches++;
    for (const record of batch.records) {
      if (record.fees.medianCuPrice !== null && record.fees.pricedTxs > 0 && !this.slotFees.has(record.fees.slot)) {
        this.slotFees.set(record.fees.slot, {
          slot: record.fees.slot,
          epoch: record.epoch,
          leader: record.fees.leader,
          medianCuPrice: record.fees.medianCuPrice,
          txCount: record.fees.pricedTxs,
        });
      }
      if (!this.liveSlots.has(record.fees.slot)) this.liveSlots.set(record.fees.slot, record);
    }
    const inserted = batch.records.filter((r) => r.feeMix !== undefined && !this.feeMix.has(r.fees.slot));
    for (const record of inserted) this.feeMix.set(record.fees.slot, record);
    const rows = inserted.map((r) => {
      const mix = r.feeMix as NonNullable<SlotRecord['feeMix']>;
      return {
        slot: r.fees.slot,
        epoch: r.epoch,
        baseFeeLamports: mix.baseLamports,
        priorityFeeLamports: mix.priorityLamports,
        tipLamports: mix.tipLamports,
        tipTxs: mix.tipTxs,
        voteTxs: mix.voteTxs,
        nonVoteTxs: mix.nonVoteTxs,
        feeRewardLamports: mix.feeRewardLamports,
        baseFeeBasis: mix.baseFeeBasis,
      };
    });
    for (const sum of rollUpFeeMix(rows)) {
      const before = this.epochFeeMix.get(sum.epoch);
      this.epochFeeMix.set(
        sum.epoch,
        before
          ? {
              epoch: sum.epoch,
              blocks: before.blocks + sum.blocks,
              baseFeeLamports: before.baseFeeLamports + sum.baseFeeLamports,
              priorityFeeLamports: before.priorityFeeLamports + sum.priorityFeeLamports,
              tipLamports: before.tipLamports + sum.tipLamports,
              tipTxs: before.tipTxs + sum.tipTxs,
              voteTxs: before.voteTxs + sum.voteTxs,
              nonVoteTxs: before.nonVoteTxs + sum.nonVoteTxs,
              feeRewardLamports: before.feeRewardLamports + sum.feeRewardLamports,
              estimatedBlocks: before.estimatedBlocks + sum.estimatedBlocks,
              firstSlot: Math.min(before.firstSlot, sum.firstSlot),
              lastSlot: Math.max(before.lastSlot, sum.lastSlot),
            }
          : sum,
      );
    }
    if (batch.cursor) this.cursor = { ...batch.cursor };
    this.notify(...batch.notify);
  }

  async readCursor() {
    return this.cursor;
  }

  async writeLive(live: LiveIndexPayload) {
    this.live.set(live.epoch, live);
    this.notify(live);
  }

  async writeUsage(report: SolamiUsageReport) {
    this.usage = report;
  }

  async epochRows(epoch: number) {
    return [...this.slotFees.values()].filter((r) => r.epoch === epoch).sort((a, b) => a.slot - b.slot);
  }

  async saveStakes(epoch: number, stakes: ReadonlyMap<string, bigint>) {
    this.stakes.set(epoch, new Map(stakes));
  }

  async stakesFor(epoch: number): Promise<StakeRow | null> {
    const epochs = [...this.stakes.keys()].filter((e) => e >= epoch).sort((a, b) => a - b);
    return epochs.length ? { epoch: epochs[0], stakes: this.stakes.get(epochs[0]) as Map<string, bigint> } : null;
  }

  async writeEpochIndex(epoch: number, value: number): Promise<EpochIndexWrite> {
    const existing = this.epochIndex.get(epoch);
    if (existing?.postedSignature) return 'posted';
    this.epochIndex.set(epoch, { value, postedSignature: null });
    this.notify({ t: 'epoch', epoch, value });
    return 'written';
  }

  async pruneFeeMix(keepEpochs: number) {
    let newest = -1;
    for (const record of this.feeMix.values()) newest = Math.max(newest, record.epoch);
    let removed = 0;
    for (const [slot, record] of this.feeMix) {
      if (record.epoch < newest - keepEpochs + 1) {
        this.feeMix.delete(slot);
        removed++;
      }
    }
    return removed;
  }

  async pruneLiveSlots(keep: number) {
    const slots = [...this.liveSlots.keys()].sort((a, b) => b - a).slice(keep);
    for (const slot of slots) this.liveSlots.delete(slot);
    return slots.length;
  }

  private notify(...payloads: LivePayload[]): void {
    this.notifications.push(...payloads);
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications.splice(0, this.notifications.length - MAX_NOTIFICATIONS);
    }
  }
}
