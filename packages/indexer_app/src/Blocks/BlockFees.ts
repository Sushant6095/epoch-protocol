import { addressToBytes } from '@epoch/solana';

import { type TxPrice, sameKey } from '../Decoding/PriorityFee';
import { median } from '../Processors/FeeProcessor';
import { type BlockFeeMix } from './FeeMix';

/** One non-vote transaction of a block, reduced to what the Fee Index reads. */
export interface TxFeeInput {
  /** Account key 0, the fee payer (32 bytes). */
  payer: Uint8Array;
  price: TxPrice;
  /** Failed on chain. Failed transactions still paid their priority fee to the leader, so they count. */
  failed: boolean;
}

/** A block reduced to its fee inputs, from either source (gRPC or RPC getBlock). */
export interface DecodedBlock {
  slot: number;
  parentSlot: number;
  /** Unix seconds; null when the node had none. */
  blockTime: number | null;
  /** The pubkey of the block's Fee reward (normally the leader identity; see LeaderResolver). */
  rewardPubkey: string | null;
  txs: TxFeeInput[];
  /** Simple vote transactions seen (always 0 from the gRPC firehose, which filters them out). */
  votes: number;
  /** Transactions the decoder could not read (counted, never priced). */
  malformed: number;
  /** Base fees, priority fees and Jito tips (request #30). */
  feeMix: BlockFeeMix;
}

/** A block's Fee Index inputs and the detail the Live page shows. Prices in µL/CU. */
export interface BlockFeesResult {
  slot: number;
  leader: string;
  /** The slot's median over priced, non-leader-paid transactions: slot_fees.median_cu_price. Null when none. */
  medianCuPrice: number | null;
  p25CuPrice: number | null;
  p75CuPrice: number | null;
  p90CuPrice: number | null;
  /** Transactions in the median: slot_fees.tx_count. */
  pricedTxs: number;
  /** Non-vote transactions without a positive price (left out of the median). */
  unpricedTxs: number;
  /** Paid by the slot leader's identity: always left out, priced or not. */
  leaderPaidTxs: number;
  /** Failed transactions among the priced ones (they are in the median). */
  failedTxs: number;
}

/** Nearest-rank percentile of an ascending list (p in 0..1). */
export function percentileSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

/**
 * The per-slot step of the Fee Index: leader-paid transactions out, unpriced transactions out, then the median of what
 * is left, with `median()` from FeeProcessor (the lower-middle rule for even counts: ⌊(a + b) / 2⌋).
 */
export function blockFees(slot: number, leader: string, txs: readonly TxFeeInput[]): BlockFeesResult {
  const leaderBytes = addressToBytes(leader);
  const prices: number[] = [];
  let unpriced = 0;
  let leaderPaid = 0;
  let failed = 0;
  for (const tx of txs) {
    if (sameKey(tx.payer, leaderBytes)) {
      leaderPaid++;
      continue;
    }
    if (tx.price.cuPrice === null) {
      unpriced++;
      continue;
    }
    prices.push(tx.price.cuPrice);
    if (tx.failed) failed++;
  }
  prices.sort((a, b) => a - b);
  return {
    slot,
    leader,
    medianCuPrice: prices.length > 0 ? median(prices) : null,
    p25CuPrice: percentileSorted(prices, 0.25),
    p75CuPrice: percentileSorted(prices, 0.75),
    p90CuPrice: percentileSorted(prices, 0.9),
    pricedTxs: prices.length,
    unpricedTxs: unpriced,
    leaderPaidTxs: leaderPaid,
    failedTxs: failed,
  };
}
