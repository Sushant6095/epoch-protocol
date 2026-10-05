/** Decoded accounts for the operator CLI tests. */
import {
  type AdvanceAccount,
  type PoolAccount,
  type PoolParams,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';
import { type VoteState } from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

export const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
export const PROGRAM_ID = key(42);
export const SOL = 1_000_000_000n;

export const pool = (params: Partial<PoolParams> = {}): PoolAccount =>
  ({ paused: false, params: { minCommissionBps: 500, scoreTtlEpochs: 3, ...params } }) as PoolAccount;

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
  score: 8_200,
  lastScoredEpoch: 99n,
  revenue: [3n * SOL, 4n * SOL, 5n * SOL, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  revenueHead: 3,
  revenueCount: 3,
  lastSweptEpoch: 99n,
  totalSwept: 12n * SOL,
  totalRemitted: 0n,
  bondLamports: 2n * SOL,
  openAdvance: null,
  advanceSeq: 0n,
  lateEpochs: 0,
  inflationCommissionBps: 500,
  blockCommissionBps: 1_000,
  onboardedEpoch: 90n,
  revenueToken: null,
  ...overrides,
});

export const advance = (overrides: Partial<AdvanceAccount> = {}): AdvanceAccount => ({
  pool: key(10),
  vote: key(20),
  position: key(30),
  seq: 0n,
  principal: 3n * SOL,
  fee: 60_000_000n,
  totalDue: 3_060_000_000n,
  repaid: 1_000_000_000n,
  principalRepaid: 980_000_000n,
  feeRepaid: 20_000_000n,
  remitBps: 2_500,
  openedEpoch: 95n,
  closedEpoch: 0n,
  state: 'open',
  bump: 255,
  ...overrides,
});

export const voteState = (overrides: Partial<VoteState> = {}): VoteState => ({
  version: 'v4',
  nodePubkey: key(21).toBase58(),
  authorizedWithdrawer: '',
  inflationRewardsCollector: key(60).toBase58(),
  blockRevenueCollector: key(60).toBase58(),
  inflationRewardsCommissionBps: 500,
  blockRevenueCommissionBps: 1_000,
  pendingDelegatorRewards: 0n,
  rootSlot: null,
  epochCredits: [],
  lastTimestamp: { slot: 0n, timestamp: 0n },
  ...overrides,
});
