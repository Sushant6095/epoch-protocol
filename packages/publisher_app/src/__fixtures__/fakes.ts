/** Test doubles for the publisher: decoded accounts, an in-memory chain and an in-memory epoch_index store. */
import {
  type FeeIndexAccount,
  type FeeQuoteAccount,
  findFeeIndexPda,
  findIndexOperatorsPda,
  findPoolPda,
  type IndexBallotAccount,
  type IndexOperatorsAccount,
  type IndexVote,
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
  type PublisherSigner,
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

/** The operator registry PDA of PROGRAM_ID's FeeIndex: the FeeIndex's `publisher` once consensus is on. */
export const REGISTRY = findIndexOperatorsPda(
  PROGRAM_ID,
  findFeeIndexPda(PROGRAM_ID, findPoolPda(PROGRAM_ID)[0])[0],
)[0];

/** A registry of `weights.length` operators `key(60 + i)`, threshold 6,667 bps, tolerance 100 bps. */
export const indexOperators = (weights: number[] = [1, 1, 1]): IndexOperatorsAccount => ({
  feeIndex: key(11),
  bump: 254,
  thresholdBps: 6_667,
  toleranceBps: 100,
  operatorCount: weights.length,
  totalWeight: BigInt(weights.reduce((a, b) => a + b, 0)),
  operators: [
    ...weights.map((weight, i) => ({ key: key(60 + i), weight })),
    ...Array.from({ length: 8 - weights.length }, () => ({ key: key(0), weight: 0 })),
  ],
});

const emptyVote = (): IndexVote => ({
  operator: key(0),
  weight: 0,
  voted: false,
  value: 0n,
  inputsHash: new Uint8Array(32),
  slot: 0n,
  deviationBps: 0,
  agrees: false,
  late: false,
});

/** A ballot for `epoch` opened on `registry` (round 0, nobody voted); `votes` fills slots by operator index. */
export const indexBallot = (
  epoch: bigint,
  registry: IndexOperatorsAccount = indexOperators(),
  overrides: Partial<IndexBallotAccount> = {},
  votes: Record<number, Partial<IndexVote>> = {},
): IndexBallotAccount => ({
  feeIndex: key(11),
  epoch,
  bump: 253,
  payer: key(60),
  round: 0,
  openedSlot: 1n,
  thresholdBps: registry.thresholdBps,
  toleranceBps: registry.toleranceBps,
  totalWeight: registry.totalWeight,
  operatorCount: registry.operatorCount,
  votesCast: Object.values(votes).filter((v) => v.voted).length,
  votes: registry.operators.map((o, i) =>
    i < registry.operatorCount ? { ...emptyVote(), operator: o.key, weight: o.weight, ...votes[i] } : emptyVote(),
  ),
  medianValue: 0n,
  agreeingWeight: 0n,
  consensusSlot: 0n,
  consensusValue: 0n,
  consensusInputsHash: new Uint8Array(32),
  proposedSlot: 0n,
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
  role: PublisherSigner;
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
  /** Configured operator keys (INDEX_OPERATOR_KEYPAIR_PATHS). */
  operators: PublicKey[] = [];
  registryAccount: IndexOperatorsAccount | null = null;
  ballotAccounts: IndexBallotAccount[] = [];
  /** `${operator}:${hex(inputsHash)}` → signature of that key's cast_index_vote. */
  voteSignatures = new Map<string, string>();
  readonly calls: PublisherCall[] = [];
  onExecute: (call: PublisherCall) => ExecuteResult = (call) => ({ status: 'sent', signature: `sig:${call.label}` });

  keyOf(role: PublisherRole): PublicKey | undefined {
    return role === 'publisher' ? this.publisher : this.maker;
  }
  operatorKeys(): PublicKey[] {
    return [...this.operators];
  }
  async indexOperators(): Promise<IndexOperatorsAccount | null> {
    return this.registryAccount;
  }
  async indexBallots(): Promise<IndexBallotAccount[]> {
    return [...this.ballotAccounts];
  }
  async findVoteSignature(operator: PublicKey, inputsHash: Uint8Array): Promise<string | null> {
    return this.voteSignatures.get(`${operator.toBase58()}:${Buffer.from(inputsHash).toString('hex')}`) ?? null;
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
  async execute(label: string, instructions: TransactionInstruction[], role: PublisherSigner): Promise<ExecuteResult> {
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
