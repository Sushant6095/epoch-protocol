import { type LiveIndexPayload, type LivePayload, type LiveSlotPayload } from '@epoch/pg_models';

import {
  type EpochIndexWrite,
  type IndexerCursor,
  type IndexerStore,
  type SlotRecord,
  type StakeRow,
} from '../Repositories/IndexerStore';
import { type SlotFeeRow } from '../Repositories/SlotFeeRepository';

/** IndexerStore in memory, with the same rules as PgIndexerStore (a posted epoch_index row is never rewritten). */
export class MemoryIndexerStore implements IndexerStore {
  readonly slotFees = new Map<number, SlotFeeRow>();
  readonly liveSlots = new Map<number, SlotRecord>();
  readonly notifications: LivePayload[] = [];
  readonly live = new Map<number, LiveIndexPayload>();
  readonly stakes = new Map<number, Map<string, bigint>>();
  readonly epochIndex = new Map<number, { value: number; postedSignature: string | null }>();
  cursor: IndexerCursor | null = null;
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
    if (batch.cursor) this.cursor = { ...batch.cursor };
    this.notifications.push(...batch.notify);
  }

  async readCursor() {
    return this.cursor;
  }

  async writeLive(live: LiveIndexPayload) {
    this.live.set(live.epoch, live);
    this.notifications.push(live);
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
    this.notifications.push({ t: 'epoch', epoch, value });
    return 'written';
  }

  async pruneLiveSlots(keep: number) {
    const slots = [...this.liveSlots.keys()].sort((a, b) => b - a).slice(keep);
    for (const slot of slots) this.liveSlots.delete(slot);
    return slots.length;
  }
}
