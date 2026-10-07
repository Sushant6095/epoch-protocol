import { addressToBytes, JITO_TIP_ACCOUNTS } from '@epoch/solana';

import { sameKey } from '../Decoding/PriorityFee';

/**
 * What a block paid, by kind (request #30): base fees, priority fees and Jito tips, in lamports.
 *
 * Per transaction:
 * - **base** = 5,000 × (transaction signatures + precompile signatures). Agave counts the signatures each Ed25519,
 *   secp256k1 and secp256r1 precompile instruction verifies (its first data byte) into the fee. Votes pay it too.
 * - **priority** = `meta.fee` − base: covers legacy/v0 (ComputeBudget price × limit) and v1 (SIMD-0385, the fee is in
 *   the message) without re-deriving compute-unit limits.
 * - **tips** = lamports moved by System Program Transfer (2) or TransferWithSeed (11) into one of Jito's eight
 *   tip-payment accounts, in top-level and inner instructions, by successful transactions only (a failed transaction's
 *   transfers are rolled back). Moves out of the tip accounts (the validator's `change_tip_receiver`) are not tips.
 *
 * Per block, Agave pays the leader `priority + base − ⌊base × 50 ÷ 100⌋` (`calculate_reward_and_burn_fee_details`: half
 * of the block's base fees is burned, no priority fee is). Checked on real mainnet blocks in the tests; the RPC path
 * re-checks it on every block, and the gRPC path, which never sees votes, uses it to find the votes' base fees.
 */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
export const BASE_FEE_BURN_PERCENT = 50n;

const SYSTEM_PROGRAM = new Uint8Array(32);
const SYSTEM_TRANSFER = 2;
const SYSTEM_TRANSFER_WITH_SEED = 11;
const PRECOMPILES = [
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
].map(addressToBytes);
const TIP_ACCOUNTS = JITO_TIP_ACCOUNTS.map(addressToBytes);

export interface FeeMixInstruction {
  programIdIndex: number;
  /** Indexes into the transaction's full key list. */
  accounts: ArrayLike<number>;
  data: Uint8Array;
}

/** One transaction as both block sources can give it. */
export interface FeeMixTx {
  signatures: number;
  /** Static keys, then the lookup tables' writable and readonly addresses: the runtime's account index order. */
  keys: readonly Uint8Array[];
  instructions: readonly FeeMixInstruction[];
  /** Every inner instruction (only System Program ones matter). */
  innerInstructions: readonly FeeMixInstruction[];
  /** `meta.fee`; null when the node sent no meta. */
  fee: bigint | null;
  failed: boolean;
}

export interface TxFeeMix {
  baseLamports: bigint;
  priorityLamports: bigint;
  tipLamports: bigint;
}

const isTipAccount = (key: Uint8Array | undefined): boolean =>
  key !== undefined && TIP_ACCOUNTS.some((tip) => sameKey(key, tip));

/** Whether any of the keys is a tip account: without one a transaction cannot tip, so its inner data can be skipped. */
export const touchesTipAccount = (keys: readonly Uint8Array[]): boolean => keys.some(isTipAccount);

/** The System Program's id: 32 zero bytes. */
export const isSystemProgram = (key: Uint8Array | undefined): boolean => sameKey(key, SYSTEM_PROGRAM);

const u32le = (data: Uint8Array, at: number): number =>
  (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;

function u64le(data: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = at + 7; i >= at; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}

/** Lamports a System Program instruction moves into a tip account, else 0. */
function tipOf(ix: FeeMixInstruction, keys: readonly Uint8Array[]): bigint {
  if (!sameKey(keys[ix.programIdIndex], SYSTEM_PROGRAM) || ix.data.length < 12) return 0n;
  const kind = u32le(ix.data, 0);
  const to =
    kind === SYSTEM_TRANSFER ? ix.accounts[1] : kind === SYSTEM_TRANSFER_WITH_SEED ? ix.accounts[2] : undefined;
  if (to === undefined || !isTipAccount(keys[to])) return 0n;
  return u64le(ix.data, 4);
}

export function txFeeMix(tx: FeeMixTx): TxFeeMix {
  let signatures = tx.signatures;
  for (const ix of tx.instructions) {
    const program = tx.keys[ix.programIdIndex];
    if (ix.data.length > 0 && PRECOMPILES.some((p) => sameKey(program, p))) signatures += ix.data[0];
  }
  const baseLamports = LAMPORTS_PER_SIGNATURE * BigInt(signatures);
  const priorityLamports = tx.fee !== null && tx.fee > baseLamports ? tx.fee - baseLamports : 0n;
  let tipLamports = 0n;
  if (!tx.failed && touchesTipAccount(tx.keys)) {
    for (const ix of tx.instructions) tipLamports += tipOf(ix, tx.keys);
    for (const ix of tx.innerInstructions) tipLamports += tipOf(ix, tx.keys);
  }
  return { baseLamports, priorityLamports, tipLamports };
}

/** How the block's vote base fees were found. */
export type BaseFeeBasis = 'counted' | 'reward' | 'estimated';

export interface BlockFeeMix {
  baseLamports: bigint;
  priorityLamports: bigint;
  tipLamports: bigint;
  /** Successful transactions that tipped. */
  tipTxs: number;
  voteTxs: number;
  nonVoteTxs: number;
  /** The leader's Fee reward; null when the block reported none. */
  feeRewardLamports: bigint | null;
  baseFeeBasis: BaseFeeBasis;
  /** Counted blocks: whether the Fee reward equals Agave's split of what was counted (null when there is no reward). */
  rewardMatches: boolean | null;
}

/** The leader's share of a block's fees: all priority fees and the unburned half of the base fees. */
export const feeReward = (baseLamports: bigint, priorityLamports: bigint): bigint =>
  priorityLamports + baseLamports - (baseLamports * BASE_FEE_BURN_PERCENT) / 100n;

/** Sums a block's transactions as a decoder reads them. */
export class FeeMixTally {
  baseLamports = 0n;
  priorityLamports = 0n;
  tipLamports = 0n;
  tipTxs = 0;
  voteTxs = 0;
  nonVoteTxs = 0;

  add(mix: TxFeeMix, isVote: boolean): void {
    this.baseLamports += mix.baseLamports;
    this.priorityLamports += mix.priorityLamports;
    this.tipLamports += mix.tipLamports;
    if (mix.tipLamports > 0n) this.tipTxs++;
    if (isVote) this.voteTxs++;
    else this.nonVoteTxs++;
  }

  /** RPC blocks: every transaction, votes included, was counted. */
  counted(feeRewardLamports: bigint | null): BlockFeeMix {
    return {
      baseLamports: this.baseLamports,
      priorityLamports: this.priorityLamports,
      tipLamports: this.tipLamports,
      tipTxs: this.tipTxs,
      voteTxs: this.voteTxs,
      nonVoteTxs: this.nonVoteTxs,
      feeRewardLamports,
      baseFeeBasis: 'counted',
      rewardMatches:
        feeRewardLamports === null ? null : feeReward(this.baseLamports, this.priorityLamports) === feeRewardLamports,
    };
  }

  /**
   * Streamed blocks (the Yellowstone firehose leaves votes out): the votes' base fees come from the Fee reward
   * (base = 2 × (reward − priority)), else 5,000 per vote, the vote count being `executedTransactionCount` minus the
   * non-vote transactions seen.
   */
  streamed(feeRewardLamports: bigint | null, executedTransactionCount: number | null): BlockFeeMix {
    const voteTxs =
      executedTransactionCount !== null
        ? Math.max(this.voteTxs, executedTransactionCount - this.nonVoteTxs)
        : this.voteTxs;
    // Votes the stream did send were counted like any transaction; only the unseen ones are estimated.
    let baseLamports = this.baseLamports + LAMPORTS_PER_SIGNATURE * BigInt(voteTxs - this.voteTxs);
    let baseFeeBasis: BaseFeeBasis = 'estimated';
    if (feeRewardLamports !== null) {
      const fromReward = 2n * (feeRewardLamports - this.priorityLamports);
      // The reward must explain at least the counted non-vote base fees, in whole signatures.
      if (fromReward >= this.baseLamports && (fromReward - this.baseLamports) % LAMPORTS_PER_SIGNATURE === 0n) {
        baseLamports = fromReward;
        baseFeeBasis = 'reward';
      }
    }
    return {
      baseLamports,
      priorityLamports: this.priorityLamports,
      tipLamports: this.tipLamports,
      tipTxs: this.tipTxs,
      voteTxs,
      nonVoteTxs: this.nonVoteTxs,
      feeRewardLamports,
      baseFeeBasis,
      rewardMatches: null,
    };
  }
}
