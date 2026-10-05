import { type SubscribeUpdateBlockMeta, type SubscribeUpdateTransaction } from '@epoch/solana';

import { priorityFeeOf } from '../Decoding/PriorityFee';
import { type DecodedBlock, type TxFeeInput } from './BlockFees';

/** `solana.storage.ConfirmedBlock.RewardType.Fee`. */
const REWARD_TYPE_FEE = 1;
/** Completed slots remembered to recognise a transaction that arrives after its block meta. */
const COMPLETED_MEMORY = 512;

interface PendingSlot {
  txs: TxFeeInput[];
  votes: number;
  malformed: number;
}

/**
 * Rebuilds blocks from the Yellowstone firehose: at `confirmed` commitment the server sends a slot's transactions,
 * then its block meta, so transactions are collected per slot and the block meta closes it. Only the fee inputs are
 * kept (payer, price, failed), not the updates themselves.
 */
export class GrpcBlockAssembler {
  private readonly pending = new Map<number, PendingSlot>();
  private readonly completed = new Set<number>();
  private readonly completedOrder: number[] = [];
  /** Transactions that arrived after their slot's block meta (ignored; expected to stay 0). */
  lateTransactions = 0;

  get pendingSlots(): number {
    return this.pending.size;
  }

  addTransaction(update: SubscribeUpdateTransaction): void {
    const slot = Number(update.slot);
    const info = update.transaction;
    if (!info) return;
    if (this.completed.has(slot)) {
      this.lateTransactions++;
      return;
    }
    let entry = this.pending.get(slot);
    if (!entry) {
      entry = { txs: [], votes: 0, malformed: 0 };
      this.pending.set(slot, entry);
    }
    if (info.isVote) {
      entry.votes++;
      return;
    }
    const message = info.transaction?.message;
    const payer = message?.accountKeys[0];
    if (!message || !payer || payer.length !== 32) {
      entry.malformed++;
      return;
    }
    // `config` is set exactly for v1 (SIMD-0385) messages; its fields are optional.
    const config = message.config;
    entry.txs.push({
      // A copy: the original is a view into the whole update's buffer.
      payer: Uint8Array.from(payer),
      price: priorityFeeOf({
        accountKeys: message.accountKeys,
        instructions: message.instructions,
        v1Config: config
          ? {
              priorityFeeLamports: config.priorityFee !== undefined ? BigInt(config.priorityFee) : undefined,
              computeUnitLimit: config.computeUnitLimit,
            }
          : undefined,
      }),
      failed: info.meta?.err !== undefined,
    });
  }

  /** The block for `meta.slot`, with every transaction received for it. */
  completeBlock(meta: SubscribeUpdateBlockMeta): DecodedBlock {
    const slot = Number(meta.slot);
    const entry = this.pending.get(slot) ?? { txs: [], votes: 0, malformed: 0 };
    this.pending.delete(slot);
    this.remember(slot);
    const reward = meta.rewards?.rewards.find((r) => r.rewardType === REWARD_TYPE_FEE);
    const timestamp = meta.blockTime?.timestamp;
    return {
      slot,
      parentSlot: Number(meta.parentSlot),
      blockTime: timestamp !== undefined && timestamp !== '' ? Number(timestamp) : null,
      rewardPubkey: reward?.pubkey ?? null,
      txs: entry.txs,
      votes: entry.votes,
      malformed: entry.malformed,
    };
  }

  /** Forget partial slots: after a reconnect the server replays them from `fromSlot`. */
  reset(): void {
    this.pending.clear();
  }

  /** Partial slots below `slot` whose block meta never came (a lost update): removed and returned. */
  dropBefore(slot: number): number[] {
    const dropped = [...this.pending.keys()].filter((s) => s < slot);
    for (const s of dropped) this.pending.delete(s);
    return dropped;
  }

  private remember(slot: number): void {
    this.completed.add(slot);
    this.completedOrder.push(slot);
    if (this.completedOrder.length > COMPLETED_MEMORY) this.completed.delete(this.completedOrder.shift() as number);
  }
}
