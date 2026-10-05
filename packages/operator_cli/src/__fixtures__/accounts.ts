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

// ─── Raw account data for register-revenue-token (the program's fixed offsets) ───

/** An SPL Token mint: no authorities, initialized, `supply`. */
export function mintData(
  overrides: { supply?: bigint; mintAuthority?: boolean; freezeAuthority?: boolean } = {},
): Uint8Array {
  const d = new Uint8Array(82);
  const view = new DataView(d.buffer);
  if (overrides.mintAuthority) view.setUint32(0, 1, true);
  view.setBigUint64(36, overrides.supply ?? 1_000_000_000_000n, true);
  d[44] = 6;
  d[45] = 1;
  if (overrides.freezeAuthority) view.setUint32(46, 1, true);
  return d;
}

/** A DBC `PoolConfig` like Epoch's preset: quotes SOL, DAMM v2 at 1%, 1% curve fee, 100% of the LP locked. */
export function dbcConfigData(
  treasury: PublicKey,
  overrides: { feeClaimer?: PublicKey; leftoverReceiver?: PublicKey; creatorUnlocked?: number } = {},
): Uint8Array {
  const d = new Uint8Array(1_048);
  d.set([26, 108, 14, 123, 116, 230, 129, 43], 0);
  d.set(new PublicKey('So11111111111111111111111111111111111111112').toBytes(), 8);
  d.set((overrides.feeClaimer ?? treasury).toBytes(), 40);
  d.set((overrides.leftoverReceiver ?? treasury).toBytes(), 72);
  new DataView(d.buffer).setBigUint64(104, 10_000_000n, true);
  d[233] = 1; // DAMM v2
  d[239] = 100 - (overrides.creatorUnlocked ?? 0); // partner permanently locked
  d[242] = overrides.creatorUnlocked ?? 0;
  d[243] = 2; // 1% DAMM v2
  d[244] = 1; // fixed supply
  return d;
}

/** A DBC `VirtualPool` trading `mint` with `config`. */
export function dbcPoolData(config: PublicKey, mint: PublicKey): Uint8Array {
  const d = new Uint8Array(424);
  d.set([213, 224, 5, 209, 98, 69, 119, 92], 0);
  d.set(config.toBytes(), 72);
  d.set(mint.toBytes(), 136);
  return d;
}

/** A complete set of PoolParams that passes `PoolParams::validate`. */
export const poolParamsJson = {
  seniorRateBpsPerEpoch: 3,
  protocolFeeBps: 1_000,
  advanceBpsUnhedged: 2_500,
  advanceBpsHedged: 4_000,
  bondMultiplier: 4,
  feeBps: 200,
  remitBps: 5_000,
  minScore: 6_000,
  scoreTtlEpochs: 3,
  minAdvanceLamports: '1000000000',
  maxAdvanceLamports: '500000000000',
  maxPoolAssets: '5000000000000',
  maxUtilizationBps: 6_000,
  minJuniorBps: 2_000,
  juniorLockEpochs: 2,
  maxAdvanceEpochs: 20,
  voteReserveLamports: '1600000000',
  minCommissionBps: 0,
};
