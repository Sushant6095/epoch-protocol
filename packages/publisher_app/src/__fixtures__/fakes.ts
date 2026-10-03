/** Test doubles for the publisher: decoded accounts, an in-memory chain and an in-memory epoch_index store. */
import {
  type FeeIndexAccount,
  type FeeQuoteAccount,
  type InstructionName,
  instructionNameOf,
  type PoolAccount,
} from '@epoch/epoch-sdk';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';

import {
  type ChainClock,
  type ExecuteResult,
  type ProgramAccount,
  type PublisherChain,
  type PublisherRole,
} from '../Chain/PublisherChain';
import { InputsHasher, type SlotFeeInput } from '../Index/InputsHash';
import { type EpochIndexRow, type IndexStore } from '../Repositories/EpochIndexRepository';

export const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
export const PROGRAM_ID = key(42);
export const SOL = 1_000_000_000n;
export const SLOTS_PER_EPOCH = 432_000n;

export const feeIndex = (overrides: Partial<FeeIndexAccount> = {}): FeeIndexAccount => ({
  pool: key(10),
  publisher: key(5),
  bump: 255,
  epoch: 0n,
  value: 0n,
  inputsHash: new Uint8Array(32),
  finalizedSlot: 0n,
  hasProposal: false,
  proposedEpoch: 0n,
  proposedValue: 0n,
  proposedInputsHash: new Uint8Array(32),
  proposedSlot: 0n,
  disputeWindowSlots: 9_000n,
  maxMoveBps: 2_000,
  history: Array.from({ length: 16 }, () => ({ epoch: 0n, value: 0n })),
  historyHead: 0,
  historyCount: 0,
  ...overrides,
});

export const pool = (overrides: Partial<PoolAccount> = {}): PoolAccount =>
  ({ paused: false, treasury: key(2), scorer: key(3), admin: key(1), ...overrides }) as PoolAccount;

export const quote = (overrides: Partial<FeeQuoteAccount> = {}): FeeQuoteAccount => ({
  pool: key(10),
  maker: key(6),
  epoch: 101n,
  fixedRate: 1_000n,
  maxNotional: 50n * SOL,
  filledNotional: 0n,
  maxMoveBps: 2_000,
  expirySlot: 101n * SLOTS_PER_EPOCH,
  collateral: 10n * SOL,
  lockedCollateral: 0n,
  openSwaps: 0,
  bump: 255,
  ...overrides,
});

export interface PublisherCall {
  label: string;
  role: PublisherRole;
  name: InstructionName | null;
  instruction: TransactionInstruction;
}

/** An in-memory PublisherChain; tests set the state, tick a step, then inspect `calls`. */
export class FakePublisherChain implements PublisherChain {
  readonly programId = PROGRAM_ID;
  dryRun = false;
  publisher: PublicKey | undefined = key(5);
  maker: PublicKey | undefined = key(6);
  epoch = 100n;
  slot = 100n * SLOTS_PER_EPOCH + 1_000n;
  poolAccount: PoolAccount | null = pool();
  feeIndexAccount: FeeIndexAccount | null = feeIndex();
  quoteAccounts: FeeQuoteAccount[] = [];
  makerBalance = 1_000n * SOL;
  proposalSignatures = new Map<string, string>();
  readonly calls: PublisherCall[] = [];
  onExecute: (call: PublisherCall) => ExecuteResult = (call) => ({ status: 'sent', signature: `sig:${call.label}` });

  keyOf(role: PublisherRole): PublicKey | undefined {
    return role === 'publisher' ? this.publisher : this.maker;
  }
  async clock(): Promise<ChainClock> {
    return { epoch: this.epoch, slot: this.slot };
  }
  async firstSlotOfEpoch(epoch: bigint): Promise<bigint> {
    return epoch * SLOTS_PER_EPOCH;
  }
  async pool(): Promise<PoolAccount | null> {
    return this.poolAccount;
  }
  async feeIndex(): Promise<FeeIndexAccount | null> {
    return this.feeIndexAccount;
  }
  async quotes(maker: PublicKey): Promise<ProgramAccount<FeeQuoteAccount>[]> {
    return this.quoteAccounts
      .filter((q) => q.maker.equals(maker))
      .map((account, i) => ({ address: key(200 + i), account }));
  }
  async balance(): Promise<bigint> {
    return this.makerBalance;
  }
  async rentExemptMinimum(dataSize: number): Promise<bigint> {
    return BigInt(dataSize + 128) * 6_960n;
  }
  async findProposalSignature(inputsHash: Uint8Array): Promise<string | null> {
    return this.proposalSignatures.get(Buffer.from(inputsHash).toString('hex')) ?? null;
  }
  async execute(label: string, instructions: TransactionInstruction[], role: PublisherRole): Promise<ExecuteResult> {
    const instruction = instructions[instructions.length - 1];
    const call = { label, role, name: instructionNameOf(instruction.data), instruction };
    this.calls.push(call);
    if (this.dryRun) return { status: 'simulated', logs: [] };
    return this.onExecute(call);
  }
}

/** Slot rows for a mainnet epoch: `count` slots from the epoch's first slot, leaders cycling over three keys. */
export function slotRows(epoch: number, count = 4, price = (i: number) => 1_000 + i): SlotFeeInput[] {
  return Array.from({ length: count }, (_, i) => ({
    slot: epoch * 432_000 + i,
    leader: key(150 + (i % 3)).toBase58(),
    medianCuPrice: price(i),
    txCount: 100 + i,
  }));
}

/** epoch_index + slot_fees in memory, with the same semantics as PgIndexStore. */
export class MemoryIndexStore implements IndexStore {
  readonly rows = new Map<number, EpochIndexRow>();
  readonly slots = new Map<number, SlotFeeInput[]>();

  add(epoch: number, value: number, postedSignature: string | null = null, slots = slotRows(epoch)): this {
    this.rows.set(epoch, { epoch, value, postedSignature });
    this.slots.set(epoch, slots);
    return this;
  }

  async latestPosted(): Promise<EpochIndexRow | null> {
    const posted = [...this.rows.values()].filter((r) => r.postedSignature !== null).sort((a, b) => b.epoch - a.epoch);
    return posted[0] ? { ...posted[0] } : null;
  }
  async unposted(after: number | null): Promise<EpochIndexRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.postedSignature === null && (after === null || r.epoch > after))
      .sort((a, b) => a.epoch - b.epoch)
      .map((r) => ({ ...r }));
  }
  async markPosted(epoch: number, signature: string): Promise<boolean> {
    const row = this.rows.get(epoch);
    if (!row || row.postedSignature !== null) return false;
    row.postedSignature = signature;
    return true;
  }
  async inputsHash(epoch: number): Promise<{ hash: Uint8Array; slots: number }> {
    return new InputsHasher(epoch).update(this.slots.get(epoch) ?? []).digest();
  }
}
