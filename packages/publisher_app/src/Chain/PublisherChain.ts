import { type EpochErrorInfo, type FeeIndexAccount, type FeeQuoteAccount, type PoolAccount } from '@epoch/epoch-sdk';
import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

/** `publisher` signs post_index (the FeeIndex's publisher key); `maker` signs quotes and pays their collateral. */
export type PublisherRole = 'publisher' | 'maker';

export interface ProgramAccount<T> {
  address: PublicKey;
  account: T;
}

export interface ChainClock {
  epoch: bigint;
  slot: bigint;
}

export type ExecuteResult =
  | { status: 'sent'; signature: string }
  | { status: 'simulated'; logs: string[]; unitsConsumed?: number }
  | { status: 'failed'; error?: EpochErrorInfo; message: string; logs: string[]; transient: boolean };

/** The publisher's view of the Epoch program's cluster. `PublisherClient` is the real one; tests use a fake. */
export interface PublisherChain {
  readonly programId: PublicKey;
  readonly dryRun: boolean;
  keyOf(role: PublisherRole): PublicKey | undefined;
  clock(): Promise<ChainClock>;
  /** First slot of a program-cluster epoch (its epoch schedule). */
  firstSlotOfEpoch(epoch: bigint): Promise<bigint>;
  pool(): Promise<PoolAccount | null>;
  feeIndex(): Promise<FeeIndexAccount | null>;
  /** Every FeeQuote account of one maker. */
  quotes(maker: PublicKey): Promise<ProgramAccount<FeeQuoteAccount>[]>;
  balance(address: PublicKey): Promise<bigint>;
  rentExemptMinimum(dataSize: number): Promise<bigint>;
  /**
   * The signature of the publisher's own post_index transaction whose IndexProposed event carries `inputsHash`,
   * searched in the publisher key's recent transactions; null when not found.
   */
  findProposalSignature(inputsHash: Uint8Array): Promise<string | null>;
  /** Send and confirm (simulate only under DRY_RUN). Never throws. */
  execute(label: string, instructions: TransactionInstruction[], role: PublisherRole): Promise<ExecuteResult>;
}

export function describeFailure(result: ExecuteResult): string {
  if (result.status !== 'failed') return result.status;
  return result.error ? `${result.error.name} (${result.error.code}): ${result.error.message}` : result.message;
}
