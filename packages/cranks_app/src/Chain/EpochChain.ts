import {
  type AdvanceAccount,
  type EpochErrorInfo,
  type FeeIndexAccount,
  type PoolAccount,
  type RevenueTokenAccount,
  type ScoreConfigAccount,
  type SwapPositionAccount,
  type ValidatorHistoryAccount,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

/** A decoded program account and its address. */
export interface ProgramAccount<T> {
  address: PublicKey;
  account: T;
}

/** The program cluster's clock as the RPC sees it (confirmed commitment). */
export interface ChainClock {
  epoch: bigint;
  slot: bigint;
  /** Slots since the epoch's first slot (buyback slices are scheduled on it). */
  slotIndex: bigint;
}

/** A vote account's activated stake on the program cluster. */
export interface VoteStake {
  vote: string;
  activatedStake: bigint;
}

/**
 * Who signs. The crank key pays every fee; `scorer` transactions (update_score) are paid by the crank and co-signed
 * by the scorer key, so only the crank needs SOL.
 */
export type SignerRole = 'crank' | 'scorer';

/** Per-transaction options; the default compute budget fits every instruction but `execute_buyback`. */
export interface ExecuteOptions {
  computeUnitLimit?: number;
}

export type ExecuteResult =
  | { status: 'sent'; signature: string }
  /** DRY_RUN, or an explicit `simulate`: the transaction would succeed. */
  | { status: 'simulated'; logs: string[]; unitsConsumed?: number }
  | {
      status: 'failed';
      /** The Epoch program error, when the failure is one (deterministic: re-sending will not help this epoch). */
      error?: EpochErrorInfo;
      message: string;
      logs: string[];
      /** No program error recognised (RPC, timeout, blockhash): worth retrying on the next tick. */
      transient: boolean;
    };

/**
 * Everything a crank job needs from the Epoch program's cluster. `ProgramClient` is the real one; tests use a fake,
 * so every job's decision logic runs without a deployed program.
 */
export interface EpochChain {
  readonly programId: PublicKey;
  /** When true, `execute` simulates and sends nothing. */
  readonly dryRun: boolean;
  /** The public key for a role; undefined when that keypair is not configured. */
  keyOf(role: SignerRole): PublicKey | undefined;

  clock(): Promise<ChainClock>;
  /** True while the cluster is still paying this epoch's stake rewards (sweep must wait). */
  epochRewardsActive(): Promise<boolean>;

  pool(): Promise<ProgramAccount<PoolAccount> | null>;
  positions(): Promise<ProgramAccount<ValidatorPositionAccount>[]>;
  advance(address: PublicKey): Promise<AdvanceAccount | null>;
  feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null>;
  /** The queued withdrawal with this sequence number, or null when it does not exist (processed or never made). */
  withdrawRequest(seq: bigint): Promise<WithdrawRequestAccount | null>;
  /** Open swap positions (settled ones are closed by settle_swap), optionally only one taker's. */
  swaps(taker?: PublicKey): Promise<ProgramAccount<SwapPositionAccount>[]>;
  /** Every validator revenue token (ADR 0006). */
  revenueTokens(): Promise<ProgramAccount<RevenueTokenAccount>[]>;
  /** A vote account's `ValidatorHistory` (`["history", vote]`), or null when it has none. */
  history(vote: PublicKey): Promise<ValidatorHistoryAccount | null>;
  /** The pool's `ScoreConfig`, or null before `configure_scoring`. */
  scoreConfig(): Promise<ScoreConfigAccount | null>;
  /** Activated stake of every vote account on the program cluster (getVoteAccounts, delinquent included). */
  voteStakes(): Promise<VoteStake[]>;
  /** An account's balance (0 when it does not exist). */
  lamports(address: PublicKey): Promise<bigint>;
  /** The rent-exempt minimum for `space` bytes. */
  rentExempt(space: number): Promise<bigint>;
  /** Raw data of any accounts (any owner), in order, read 100 per call; null where an account does not exist. */
  accountsData(addresses: PublicKey[]): Promise<(Uint8Array | null)[]>;

  /** Simulate without sending (always, DRY_RUN or not). */
  simulate(
    label: string,
    instructions: TransactionInstruction[],
    role: SignerRole,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
  /** Send and confirm (or only simulate under DRY_RUN). Never throws: failures come back as `status: 'failed'`. */
  execute(
    label: string,
    instructions: TransactionInstruction[],
    role: SignerRole,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
}

/** One line for logs: the program error's name, else the message. */
export function describeFailure(result: ExecuteResult): string {
  if (result.status !== 'failed') return result.status;
  return result.error ? `${result.error.name} (${result.error.code}): ${result.error.message}` : result.message;
}
