import { type SubscribeUpdateBlockMeta, type SubscribeUpdateTransaction } from '@epoch/solana';

import { priorityFeeOf } from '../Decoding/PriorityFee';
import { type DecodedBlock, type TxFeeInput } from './BlockFees';
import { FeeMixTally, touchesTipAccount, txFeeMix } from './FeeMix';

/** `solana.storage.ConfirmedBlock.RewardType.Fee`. */
const REWARD_TYPE_FEE = 1;
/** Completed slots remembered to recognise a transaction that arrives after its block meta. */
const COMPLETED_MEMORY = 512;

interface PendingSlot {
  txs: TxFeeInput[];
  votes: number;
  malformed: number;
  tally: FeeMixTally;
}

const newPending = (): PendingSlot => ({ txs: [], votes: 0, malformed: 0, tally: new FeeMixTally() });

/** A uint64 Yellowstone sends as a decimal string; null when absent or empty. */
const u64Text = (text: string | undefined): bigint | null => (text !== undefined && text !== '' ? BigInt(text) : null);

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
      entry = newPending();
      this.pending.set(slot, entry);
    }
    const message = info.transaction?.message;
    const meta = info.meta;
    const failed = meta?.err !== undefined;
    if (message) {
      const keys = [
        ...message.accountKeys,
        ...(meta?.loadedWritableAddresses ?? []),
        ...(meta?.loadedReadonlyAddresses ?? []),
      ];
      entry.tally.add(
        txFeeMix({
          signatures: message.header?.numRequiredSignatures ?? info.transaction?.signatures.length ?? 1,
          keys,
          instructions: message.instructions,
          innerInstructions:
            failed || !touchesTipAccount(keys) ? [] : (meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
          fee: u64Text(meta?.fee),
          failed,
        }),
        info.isVote,
      );
    }
    if (info.isVote) {
      entry.votes++;
      return;
    }
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
      failed,
    });
  }

  /** The block for `meta.slot`, with every transaction received for it. */
  completeBlock(meta: SubscribeUpdateBlockMeta): DecodedBlock {
    const slot = Number(meta.slot);
    const entry = this.pending.get(slot) ?? newPending();
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
      feeMix: entry.tally.streamed(
        reward ? u64Text(reward.lamports) : null,
        u64Text(meta.executedTransactionCount) === null ? null : Number(meta.executedTransactionCount),
      ),
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
