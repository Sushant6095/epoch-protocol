/** Decoded program accounts for tests: sensible defaults, override what the test is about. */
import {
  type AdvanceAccount,
  type FeeIndexAccount,
  type PoolAccount,
  type PoolParams,
  type RevenueTokenAccount,
  type SwapPositionAccount,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { PublicKey } from '@solana/web3.js';

export const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
export const PROGRAM_ID = key(42);
export const SOL = 1_000_000_000n;

export const params = (overrides: Partial<PoolParams> = {}): PoolParams => ({
  seniorRateBpsPerEpoch: 3,
  protocolFeeBps: 1_000,
  advanceBpsUnhedged: 2_500,
  advanceBpsHedged: 4_000,
  bondMultiplier: 0,
  feeBps: 200,
  remitBps: 2_500,
  minScore: 6_000,
  scoreTtlEpochs: 3,
  minAdvanceLamports: SOL,
  maxAdvanceLamports: 25n * SOL,
  maxPoolAssets: 0n,
  maxUtilizationBps: 8_000,
  minJuniorBps: 1_000,
  juniorLockEpochs: 2,
  maxAdvanceEpochs: 30,
  voteReserveLamports: 1_600_000_000n,
  minCommissionBps: 500,
  ...overrides,
});

export const pool = (overrides: Partial<PoolAccount> = {}): PoolAccount => ({
  admin: key(1),
  treasury: key(2),
  scorer: key(91),
  params: params(),
  bump: 255,
  vaultBump: 254,
  paused: false,
  cash: 100n * SOL,
  outstandingPrincipal: 0n,
  expectedFees: 0n,
  incomeUnallocated: 0n,
  bondTotal: 0n,
  seniorAssets: 80n * SOL,
  seniorShares: 80n * SOL * 1_000n,
  juniorAssets: 20n * SOL,
  juniorShares: 20n * SOL * 1_000n,
  seniorPendingShares: 0n,
  juniorPendingShares: 0n,
  withdrawHead: 0n,
  withdrawTail: 0n,
  lastAccruedEpoch: 0n,
  validators: 1,
  openAdvances: 0,
  totalAdvanced: 0n,
  totalRepaid: 0n,
  totalDefaulted: 0n,
  ...overrides,
});

export const position = (overrides: Partial<ValidatorPositionAccount> = {}): ValidatorPositionAccount => ({
  pool: key(10),
  vote: key(20),
  identity: key(21),
  operator: key(22),
  payout: key(23),
  originalWithdrawer: key(24),
  bump: 255,
  voteAuthBump: 254,
  escrowBump: 253,
  status: 'active',
  hedged: false,
  score: 0,
  lastScoredEpoch: 0n,
  revenue: Array.from({ length: 10 }, () => 0n),
  revenueHead: 0,
  revenueCount: 0,
  lastSweptEpoch: 0n,
  totalSwept: 0n,
  totalRemitted: 0n,
  bondLamports: 0n,
  openAdvance: null,
  advanceSeq: 0n,
  lateEpochs: 0,
  inflationCommissionBps: 500,
  blockCommissionBps: 10_000,
  onboardedEpoch: 0n,
  revenueToken: null,
  ...overrides,
});

export const advance = (overrides: Partial<AdvanceAccount> = {}): AdvanceAccount => ({
  pool: key(10),
  vote: key(20),
  position: key(30),
  seq: 0n,
  principal: 10n * SOL,
  fee: SOL / 5n,
  totalDue: 10n * SOL + SOL / 5n,
  repaid: 0n,
  principalRepaid: 0n,
  feeRepaid: 0n,
  remitBps: 2_500,
  openedEpoch: 90n,
  closedEpoch: 0n,
  state: 'open',
  bump: 255,
  ...overrides,
});

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

/** A FeeIndex whose final values are `epochs` (oldest first, the last one current), each worth `value(epoch)`. */
export function finalizedIndex(epochs: bigint[], value = (epoch: bigint) => 1_000n + epoch): FeeIndexAccount {
  const index = feeIndex();
  const [current, ...older] = [...epochs].reverse();
  if (current === undefined) return index;
  // Replay finalize_index: each new final value pushes the previous one into the 16-entry ring.
  for (const epoch of [...older].reverse()) {
    const head = index.historyHead % 16;
    index.history[head] = { epoch, value: value(epoch) };
    index.historyHead = (head + 1) % 16;
    index.historyCount = Math.min(16, index.historyCount + 1);
  }
  return { ...index, epoch: current, value: value(current), finalizedSlot: 1_000n };
}

export const swap = (overrides: Partial<SwapPositionAccount> = {}): SwapPositionAccount => ({
  quote: key(60),
  taker: key(22),
  epoch: 101n,
  side: 'receiveFixed',
  notional: 5n * SOL,
  fixedRate: 1_200n,
  maxMoveBps: 2_000,
  collateral: SOL,
  settled: false,
  pnl: 0n,
  bump: 255,
  ...overrides,
});

/** A revenue token on its DBC curve, in its term at epoch 100 (registered at 89, start 90, end 142). */
export const revenueToken = (overrides: Partial<RevenueTokenAccount> = {}): RevenueTokenAccount => ({
  pool: key(10),
  position: key(30),
  vote: key(20),
  operator: key(22),
  mint: key(100),
  tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  dbcPool: key(101),
  dbcConfig: key(102),
  dammPool: null,
  shareBps: 1_000,
  termEpochs: 52,
  registeredEpoch: 89n,
  startEpoch: 90n,
  termEndEpoch: 142n,
  advanceSeqAtRegistration: 0n,
  inflationCommissionBps: 500,
  blockCommissionBps: 1_000,
  bump: 255,
  escrowBump: 254,
  tokensBump: 253,
  wsolBump: 252,
  slicesPerEpoch: 12,
  windowSlots: 9_000,
  maxSlippageBps: 300,
  maxImpactBps: 100,
  flags: 0,
  status: 'curve',
  buybackEpoch: 99n,
  epochBudget: 0n,
  epochSpent: 0n,
  slicesDone: 0,
  lastShareEpoch: 100n,
  totalEscrowed: 0n,
  totalSpent: 0n,
  totalBought: 0n,
  totalBurned: 0n,
  totalRedeemed: 0n,
  totalRedeemedLamports: 0n,
  buybackCount: 0,
  feeFloorBps: 100,
  ...overrides,
});

export const withdrawRequest = (overrides: Partial<WithdrawRequestAccount> = {}): WithdrawRequestAccount => ({
  pool: key(10),
  owner: key(70),
  tranche: 'senior',
  shares: SOL * 1_000n,
  seq: 0n,
  requestedEpoch: 99n,
  cancelled: false,
  bump: 255,
  ...overrides,
});
