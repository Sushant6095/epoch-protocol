import {
  type AdvanceAccount,
  type FeeIndexAccount,
  type InstructionName,
  instructionNameOf,
  type PoolAccount,
  type RevenueTokenAccount,
  type ScoreConfigAccount,
  type SwapPositionAccount,
  type ValidatorHistoryAccount,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import {
  type ChainClock,
  type EpochChain,
  type ExecuteOptions,
  type ExecuteResult,
  type ProgramAccount,
  type SignerRole,
  type VoteStake,
} from '../Chain/EpochChain';
import { key, pool, PROGRAM_ID } from './accounts';

export interface ChainCall {
  label: string;
  role: SignerRole;
  /** The (last) instruction's name, from its discriminator. */
  name: InstructionName | null;
  instructions: TransactionInstruction[];
  kind: 'simulate' | 'execute';
  options?: ExecuteOptions;
}

export const sent = (signature = 'sig'): ExecuteResult => ({ status: 'sent', signature });
export const programFailure = (name: string, code = 6000): ExecuteResult => ({
  status: 'failed',
  error: { code, name, message: name },
  message: name,
  logs: [],
  transient: false,
});
export const transientFailure = (message = 'blockhash not found'): ExecuteResult => ({
  status: 'failed',
  message,
  logs: [],
  transient: true,
});

/** An in-memory EpochChain: tests set the state, run a job, then inspect `calls`. */
export class FakeChain implements EpochChain {
  readonly programId = PROGRAM_ID;
  dryRun = false;
  crank: PublicKey | undefined = key(90);
  scorer: PublicKey | undefined = key(91);
  epoch = 100n;
  slot = 43_200_000n;
  slotIndex = 0n;
  rewardsActive = false;
  poolAccount: PoolAccount | null = pool();
  positionAccounts: ProgramAccount<ValidatorPositionAccount>[] = [];
  advances = new Map<string, AdvanceAccount>();
  feeIndexAccount: FeeIndexAccount | null = null;
  requests = new Map<bigint, WithdrawRequestAccount>();
  swapAccounts: ProgramAccount<SwapPositionAccount>[] = [];
  revenueTokenAccounts: ProgramAccount<RevenueTokenAccount>[] = [];
  balances = new Map<string, bigint>();
  /** Raw account data by address, for accountsData (e.g. Jito's TDA and ClaimStatus). */
  accountData = new Map<string, Uint8Array>();
  /** How many addresses each accountsData call asked for. */
  readonly accountReads: number[] = [];
  /** `ValidatorHistory` by vote account (base58). */
  histories = new Map<string, ValidatorHistoryAccount>();
  scoreConfigAccount: ScoreConfigAccount | null = null;
  stakes: VoteStake[] = [];
  /** Rent-exempt minimum per byte count (mainnet's: (128 + space) × 6,960). */
  rentFor = (space: number): bigint => BigInt((128 + space) * 6_960);
  readonly calls: ChainCall[] = [];
  /** Result of each execute call (default: sent). May mutate the fake's state to model the transaction landing. */
  onExecute: (call: ChainCall) => ExecuteResult = () => sent();
  /** Result of each simulate call (default: passes). */
  onSimulate: (call: ChainCall) => ExecuteResult = () => ({ status: 'simulated', logs: [] });

  keyOf(role: SignerRole): PublicKey | undefined {
    return role === 'crank' ? this.crank : this.scorer;
  }
  async clock(): Promise<ChainClock> {
    return { epoch: this.epoch, slot: this.slot, slotIndex: this.slotIndex };
  }
  async epochRewardsActive(): Promise<boolean> {
    return this.rewardsActive;
  }
  async pool(): Promise<ProgramAccount<PoolAccount> | null> {
    return this.poolAccount ? { address: key(10), account: this.poolAccount } : null;
  }
  async positions(): Promise<ProgramAccount<ValidatorPositionAccount>[]> {
    return this.positionAccounts;
  }
  async advance(address: PublicKey): Promise<AdvanceAccount | null> {
    return this.advances.get(address.toBase58()) ?? null;
  }
  async feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null> {
    return this.feeIndexAccount ? { address: key(11), account: this.feeIndexAccount } : null;
  }
  async withdrawRequest(seq: bigint): Promise<WithdrawRequestAccount | null> {
    return this.requests.get(seq) ?? null;
  }
  async swaps(taker?: PublicKey): Promise<ProgramAccount<SwapPositionAccount>[]> {
    return taker ? this.swapAccounts.filter((s) => s.account.taker.equals(taker)) : this.swapAccounts;
  }
  async revenueTokens(): Promise<ProgramAccount<RevenueTokenAccount>[]> {
    return this.revenueTokenAccounts;
  }
  async history(vote: PublicKey): Promise<ValidatorHistoryAccount | null> {
    return this.histories.get(vote.toBase58()) ?? null;
  }
  async scoreConfig(): Promise<ScoreConfigAccount | null> {
    return this.scoreConfigAccount;
  }
  async voteStakes(): Promise<VoteStake[]> {
    return this.stakes;
  }
  async lamports(address: PublicKey): Promise<bigint> {
    return this.balances.get(address.toBase58()) ?? 0n;
  }
  async rentExempt(space: number): Promise<bigint> {
    return this.rentFor(space);
  }
  async accountsData(addresses: PublicKey[]): Promise<(Uint8Array | null)[]> {
    this.accountReads.push(addresses.length);
    return addresses.map((address) => this.accountData.get(address.toBase58()) ?? null);
  }
  async simulate(
    label: string,
    instructions: TransactionInstruction[],
    role: SignerRole,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const call = this.record(label, instructions, role, 'simulate', options);
    return this.onSimulate(call);
  }
  async execute(
    label: string,
    instructions: TransactionInstruction[],
    role: SignerRole,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (this.dryRun) return this.simulate(label, instructions, role, options);
    return this.onExecute(this.record(label, instructions, role, 'execute', options));
  }

  /** Names of the executed (not simulated) instructions, in order. */
  executed(): (InstructionName | null)[] {
    return this.calls.filter((c) => c.kind === 'execute').map((c) => c.name);
  }

  private record(
    label: string,
    instructions: TransactionInstruction[],
    role: SignerRole,
    kind: ChainCall['kind'],
    options?: ExecuteOptions,
  ): ChainCall {
    const last = instructions[instructions.length - 1];
    const call = { label, role, name: last ? instructionNameOf(last.data) : null, instructions, kind, options };
    this.calls.push(call);
    return call;
  }
}

/** A position wrapped as a program account at `address`. */
export const atAddress = <T>(account: T, n: number): ProgramAccount<T> => ({ address: key(n), account });
