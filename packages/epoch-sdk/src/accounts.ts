/**
 * Account types and decoders for every `#[account]` in `programs/epoch/src/state/`.
 *
 * Accounts are fixed-size on chain (`8 + INIT_SPACE`) but their contents are plain Borsh, decoded sequentially
 * exactly as Anchor's `try_deserialize` does: discriminator, every field in declaration order, then the trailing
 * `_reserved` bytes (required, never exposed); anything after that is ignored.
 * `ValidatorPosition.open_advance` is an `Option<Pubkey>`: when it is `None` it takes one byte instead of 33, every
 * later field sits 32 bytes earlier, and the unused tail of the allocation keeps whatever bytes were there before.
 * Only fields before that Option have fixed offsets (see `FIELD_OFFSETS`).
 */
import { type GetProgramAccountsFilter, PublicKey } from '@solana/web3.js';

import { BorshReader, type BorshWriter, U64_MAX } from './borsh';
import {
  ADVANCE_STATES,
  type AdvanceState,
  POSITION_STATUSES,
  type PositionStatus,
  PROGRAM_CONSTANTS,
  REVENUE_TOKEN_FLAGS,
  REVENUE_TOKEN_STATUSES,
  type RevenueTokenStatus,
  SIDES,
  type Side,
  type Tranche,
  TRANCHES,
} from './constants';
import { ACCOUNT_DISCRIMINATORS, type AccountName, accountNameOf } from './discriminators';
import { base58Encode, bytesEqual } from './encoding';

export interface PoolParams {
  seniorRateBpsPerEpoch: number;
  protocolFeeBps: number;
  advanceBpsUnhedged: number;
  advanceBpsHedged: number;
  bondMultiplier: number;
  feeBps: number;
  remitBps: number;
  minScore: number;
  scoreTtlEpochs: number;
  minAdvanceLamports: bigint;
  maxAdvanceLamports: bigint;
  maxPoolAssets: bigint;
  maxUtilizationBps: number;
  minJuniorBps: number;
  juniorLockEpochs: number;
  maxAdvanceEpochs: number;
  voteReserveLamports: bigint;
  minCommissionBps: number;
}

export interface PoolAccount {
  admin: PublicKey;
  treasury: PublicKey;
  scorer: PublicKey;
  params: PoolParams;
  bump: number;
  vaultBump: number;
  paused: boolean;
  cash: bigint;
  outstandingPrincipal: bigint;
  expectedFees: bigint;
  incomeUnallocated: bigint;
  bondTotal: bigint;
  seniorAssets: bigint;
  seniorShares: bigint;
  juniorAssets: bigint;
  juniorShares: bigint;
  seniorPendingShares: bigint;
  juniorPendingShares: bigint;
  withdrawHead: bigint;
  withdrawTail: bigint;
  lastAccruedEpoch: bigint;
  validators: number;
  openAdvances: number;
  totalAdvanced: bigint;
  totalRepaid: bigint;
  totalDefaulted: bigint;
}

export interface LenderSharesAccount {
  pool: PublicKey;
  owner: PublicKey;
  tranche: Tranche;
  shares: bigint;
  pendingShares: bigint;
  lastDepositEpoch: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  bump: number;
}

export interface WithdrawRequestAccount {
  pool: PublicKey;
  owner: PublicKey;
  tranche: Tranche;
  shares: bigint;
  seq: bigint;
  requestedEpoch: bigint;
  cancelled: boolean;
  bump: number;
}

export interface ValidatorPositionAccount {
  pool: PublicKey;
  vote: PublicKey;
  identity: PublicKey;
  operator: PublicKey;
  payout: PublicKey;
  originalWithdrawer: PublicKey;
  bump: number;
  voteAuthBump: number;
  escrowBump: number;
  status: PositionStatus;
  hedged: boolean;
  score: number;
  lastScoredEpoch: bigint;
  /** Raw ring buffer (array order); see `revenueHistory` for oldest → newest. */
  revenue: bigint[];
  revenueHead: number;
  revenueCount: number;
  lastSweptEpoch: bigint;
  totalSwept: bigint;
  totalRemitted: bigint;
  bondLamports: bigint;
  openAdvance: PublicKey | null;
  advanceSeq: bigint;
  lateEpochs: number;
  inflationCommissionBps: number;
  blockCommissionBps: number;
  onboardedEpoch: bigint;
  /** The validator's `RevenueToken` account, or null for none (all zeros on chain; the bytes were `_reserved`). */
  revenueToken: PublicKey | null;
}

export interface AdvanceAccount {
  pool: PublicKey;
  vote: PublicKey;
  position: PublicKey;
  seq: bigint;
  principal: bigint;
  fee: bigint;
  totalDue: bigint;
  repaid: bigint;
  principalRepaid: bigint;
  feeRepaid: bigint;
  remitBps: number;
  openedEpoch: bigint;
  closedEpoch: bigint;
  state: AdvanceState;
  bump: number;
}

export interface IndexPoint {
  epoch: bigint;
  value: bigint;
}

export interface FeeIndexAccount {
  pool: PublicKey;
  publisher: PublicKey;
  bump: number;
  epoch: bigint;
  value: bigint;
  inputsHash: Uint8Array;
  finalizedSlot: bigint;
  hasProposal: boolean;
  proposedEpoch: bigint;
  proposedValue: bigint;
  proposedInputsHash: Uint8Array;
  proposedSlot: bigint;
  disputeWindowSlots: bigint;
  maxMoveBps: number;
  /** Raw ring buffer (array order); see `feeIndexHistory` for oldest → newest. */
  history: IndexPoint[];
  historyHead: number;
  historyCount: number;
}

export interface FeeQuoteAccount {
  pool: PublicKey;
  maker: PublicKey;
  epoch: bigint;
  fixedRate: bigint;
  maxNotional: bigint;
  filledNotional: bigint;
  maxMoveBps: number;
  expirySlot: bigint;
  collateral: bigint;
  lockedCollateral: bigint;
  openSwaps: number;
  bump: number;
}

export interface SwapPositionAccount {
  quote: PublicKey;
  taker: PublicKey;
  epoch: bigint;
  side: Side;
  notional: bigint;
  fixedRate: bigint;
  maxMoveBps: number;
  collateral: bigint;
  settled: boolean;
  /** Taker's realised profit (positive) or loss (negative), lamports (`i64`). */
  pnl: bigint;
  bump: number;
}

/** A validator's revenue token (`["revenue_token", vote]`). */
export interface RevenueTokenAccount {
  pool: PublicKey;
  position: PublicKey;
  vote: PublicKey;
  /** Paid the rent; receives it back on close. */
  operator: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  /** The DAMM v2 pool it graduated to; null until `sync_revenue_token_pool`. */
  dammPool: PublicKey | null;
  shareBps: number;
  termEpochs: number;
  registeredEpoch: bigint;
  /** First epoch whose sweep pays the share. */
  startEpoch: bigint;
  /** `startEpoch + termEpochs`: the first epoch after the term. */
  termEndEpoch: bigint;
  /** Advances with a lower `seq` predate the token and are repaid before the share. */
  advanceSeqAtRegistration: bigint;
  inflationCommissionBps: number;
  blockCommissionBps: number;
  bump: number;
  escrowBump: number;
  tokensBump: number;
  wsolBump: number;
  slicesPerEpoch: number;
  windowSlots: number;
  maxSlippageBps: number;
  maxImpactBps: number;
  /** `REVENUE_TOKEN_FLAGS` bits. */
  flags: number;
  status: RevenueTokenStatus;
  buybackEpoch: bigint;
  epochBudget: bigint;
  epochSpent: bigint;
  /** Bit i set = slice i ran in `buybackEpoch`. */
  slicesDone: number;
  lastShareEpoch: bigint;
  totalEscrowed: bigint;
  totalSpent: bigint;
  totalBought: bigint;
  totalBurned: bigint;
  totalRedeemed: bigint;
  totalRedeemedLamports: bigint;
  buybackCount: number;
  /** The lowest fee, bps, the token's venues can charge (from its DBC config); `maxImpactBps` ≤ twice it. */
  feeFloorBps: number;
}

/** Account name → decoded type. */
export interface EpochAccountMap {
  Pool: PoolAccount;
  LenderShares: LenderSharesAccount;
  WithdrawRequest: WithdrawRequestAccount;
  ValidatorPosition: ValidatorPositionAccount;
  Advance: AdvanceAccount;
  FeeIndex: FeeIndexAccount;
  FeeQuote: FeeQuoteAccount;
  SwapPosition: SwapPositionAccount;
  RevenueToken: RevenueTokenAccount;
}

/** A decoded account of any type, discriminated by `name`. */
export type DecodedAccount = { [K in AccountName]: { name: K; account: EpochAccountMap[K] } }[AccountName];

/** On-chain allocation, `8 + INIT_SPACE` (an `Option<Pubkey>` counts its full 33 bytes). */
export const ACCOUNT_SIZES: Readonly<Record<AccountName, number>> = Object.freeze({
  Pool: 374,
  LenderShares: 130,
  WithdrawRequest: 115,
  ValidatorPosition: 415,
  Advance: 196,
  FeeIndex: 486,
  FeeQuote: 151,
  SwapPosition: 133,
  RevenueToken: 503,
});

/** Byte offsets of the fixed-position pubkey fields used in getProgramAccounts memcmp filters. */
export const FIELD_OFFSETS = Object.freeze({
  LenderShares: Object.freeze({ pool: 8, owner: 40 }),
  WithdrawRequest: Object.freeze({ pool: 8, owner: 40 }),
  ValidatorPosition: Object.freeze({ pool: 8, vote: 40, operator: 104 }),
  Advance: Object.freeze({ pool: 8, vote: 40 }),
  FeeQuote: Object.freeze({ pool: 8, maker: 40 }),
  SwapPosition: Object.freeze({ quote: 8, taker: 40 }),
  RevenueToken: Object.freeze({ pool: 8, position: 40, vote: 72, operator: 104, mint: 136, dbcPool: 200 }),
});

/** Length of each account's trailing `_reserved: [u8; N]`: read past (Borsh requires the bytes), never exposed. */
const RESERVED: Readonly<Record<AccountName, number>> = {
  Pool: 64,
  LenderShares: 16,
  WithdrawRequest: 16,
  // Its 32 reserved bytes are `revenue_token` now.
  ValidatorPosition: 0,
  Advance: 16,
  FeeIndex: 32,
  FeeQuote: 16,
  SwapPosition: 16,
  // Its first 2 reserved bytes are `fee_floor_bps` now.
  RevenueToken: 62,
};

// ─── Field codecs ──────────────────────────────────────────────────────────

/** Borsh `PoolParams` (the `initialize_pool` / `update_params` argument and the `Pool.params` field). */
export function readPoolParams(r: BorshReader): PoolParams {
  return {
    seniorRateBpsPerEpoch: r.u16('seniorRateBpsPerEpoch'),
    protocolFeeBps: r.u16('protocolFeeBps'),
    advanceBpsUnhedged: r.u16('advanceBpsUnhedged'),
    advanceBpsHedged: r.u16('advanceBpsHedged'),
    bondMultiplier: r.u8('bondMultiplier'),
    feeBps: r.u16('feeBps'),
    remitBps: r.u16('remitBps'),
    minScore: r.u16('minScore'),
    scoreTtlEpochs: r.u16('scoreTtlEpochs'),
    minAdvanceLamports: r.u64('minAdvanceLamports'),
    maxAdvanceLamports: r.u64('maxAdvanceLamports'),
    maxPoolAssets: r.u64('maxPoolAssets'),
    maxUtilizationBps: r.u16('maxUtilizationBps'),
    minJuniorBps: r.u16('minJuniorBps'),
    juniorLockEpochs: r.u16('juniorLockEpochs'),
    maxAdvanceEpochs: r.u16('maxAdvanceEpochs'),
    voteReserveLamports: r.u64('voteReserveLamports'),
    minCommissionBps: r.u16('minCommissionBps'),
  };
}

export function writePoolParams(w: BorshWriter, p: PoolParams): BorshWriter {
  return w
    .u16(p.seniorRateBpsPerEpoch, 'seniorRateBpsPerEpoch')
    .u16(p.protocolFeeBps, 'protocolFeeBps')
    .u16(p.advanceBpsUnhedged, 'advanceBpsUnhedged')
    .u16(p.advanceBpsHedged, 'advanceBpsHedged')
    .u8(p.bondMultiplier, 'bondMultiplier')
    .u16(p.feeBps, 'feeBps')
    .u16(p.remitBps, 'remitBps')
    .u16(p.minScore, 'minScore')
    .u16(p.scoreTtlEpochs, 'scoreTtlEpochs')
    .u64(p.minAdvanceLamports, 'minAdvanceLamports')
    .u64(p.maxAdvanceLamports, 'maxAdvanceLamports')
    .u64(p.maxPoolAssets, 'maxPoolAssets')
    .u16(p.maxUtilizationBps, 'maxUtilizationBps')
    .u16(p.minJuniorBps, 'minJuniorBps')
    .u16(p.juniorLockEpochs, 'juniorLockEpochs')
    .u16(p.maxAdvanceEpochs, 'maxAdvanceEpochs')
    .u64(p.voteReserveLamports, 'voteReserveLamports')
    .u16(p.minCommissionBps, 'minCommissionBps');
}

// ─── Decoders ──────────────────────────────────────────────────────────────

/** All-zero pubkey fields mean "none". */
const optionalKey = (key: PublicKey): PublicKey | null => (key.equals(PublicKey.default) ? null : key);

/** Check the 8-byte discriminator and return a reader positioned after it. */
function open(name: AccountName, data: Uint8Array): BorshReader {
  if (!(data instanceof Uint8Array)) throw new TypeError(`decode${name}: data must be a Uint8Array`);
  if (data.length < 8 || !bytesEqual(data.subarray(0, 8), ACCOUNT_DISCRIMINATORS[name])) {
    throw new Error(`decode${name}: account discriminator mismatch (not a ${name} account)`);
  }
  return new BorshReader(data, 8);
}

export function decodePool(data: Uint8Array): PoolAccount {
  const r = open('Pool', data);
  const account: PoolAccount = {
    admin: r.pubkey('admin'),
    treasury: r.pubkey('treasury'),
    scorer: r.pubkey('scorer'),
    params: readPoolParams(r),
    bump: r.u8('bump'),
    vaultBump: r.u8('vaultBump'),
    paused: r.bool('paused'),
    cash: r.u64('cash'),
    outstandingPrincipal: r.u64('outstandingPrincipal'),
    expectedFees: r.u64('expectedFees'),
    incomeUnallocated: r.u64('incomeUnallocated'),
    bondTotal: r.u64('bondTotal'),
    seniorAssets: r.u64('seniorAssets'),
    seniorShares: r.u64('seniorShares'),
    juniorAssets: r.u64('juniorAssets'),
    juniorShares: r.u64('juniorShares'),
    seniorPendingShares: r.u64('seniorPendingShares'),
    juniorPendingShares: r.u64('juniorPendingShares'),
    withdrawHead: r.u64('withdrawHead'),
    withdrawTail: r.u64('withdrawTail'),
    lastAccruedEpoch: r.u64('lastAccruedEpoch'),
    validators: r.u32('validators'),
    openAdvances: r.u32('openAdvances'),
    totalAdvanced: r.u64('totalAdvanced'),
    totalRepaid: r.u64('totalRepaid'),
    totalDefaulted: r.u64('totalDefaulted'),
  };
  r.skip(RESERVED.Pool, '_reserved');
  return account;
}

export function decodeLenderShares(data: Uint8Array): LenderSharesAccount {
  const r = open('LenderShares', data);
  const account: LenderSharesAccount = {
    pool: r.pubkey('pool'),
    owner: r.pubkey('owner'),
    tranche: r.variant(TRANCHES, 'tranche'),
    shares: r.u64('shares'),
    pendingShares: r.u64('pendingShares'),
    lastDepositEpoch: r.u64('lastDepositEpoch'),
    totalDeposited: r.u64('totalDeposited'),
    totalWithdrawn: r.u64('totalWithdrawn'),
    bump: r.u8('bump'),
  };
  r.skip(RESERVED.LenderShares, '_reserved');
  return account;
}

export function decodeWithdrawRequest(data: Uint8Array): WithdrawRequestAccount {
  const r = open('WithdrawRequest', data);
  const account: WithdrawRequestAccount = {
    pool: r.pubkey('pool'),
    owner: r.pubkey('owner'),
    tranche: r.variant(TRANCHES, 'tranche'),
    shares: r.u64('shares'),
    seq: r.u64('seq'),
    requestedEpoch: r.u64('requestedEpoch'),
    cancelled: r.bool('cancelled'),
    bump: r.u8('bump'),
  };
  r.skip(RESERVED.WithdrawRequest, '_reserved');
  return account;
}

export function decodeValidatorPosition(data: Uint8Array): ValidatorPositionAccount {
  const r = open('ValidatorPosition', data);
  const account: ValidatorPositionAccount = {
    pool: r.pubkey('pool'),
    vote: r.pubkey('vote'),
    identity: r.pubkey('identity'),
    operator: r.pubkey('operator'),
    payout: r.pubkey('payout'),
    originalWithdrawer: r.pubkey('originalWithdrawer'),
    bump: r.u8('bump'),
    voteAuthBump: r.u8('voteAuthBump'),
    escrowBump: r.u8('escrowBump'),
    status: r.variant(POSITION_STATUSES, 'status'),
    hedged: r.bool('hedged'),
    score: r.u16('score'),
    lastScoredEpoch: r.u64('lastScoredEpoch'),
    revenue: r.array(PROGRAM_CONSTANTS.REVENUE_WINDOW, () => r.u64('revenue')),
    revenueHead: r.u8('revenueHead'),
    revenueCount: r.u8('revenueCount'),
    lastSweptEpoch: r.u64('lastSweptEpoch'),
    totalSwept: r.u64('totalSwept'),
    totalRemitted: r.u64('totalRemitted'),
    bondLamports: r.u64('bondLamports'),
    openAdvance: r.option(() => r.pubkey('openAdvance'), 'openAdvance'),
    advanceSeq: r.u64('advanceSeq'),
    lateEpochs: r.u8('lateEpochs'),
    inflationCommissionBps: r.u16('inflationCommissionBps'),
    blockCommissionBps: r.u16('blockCommissionBps'),
    onboardedEpoch: r.u64('onboardedEpoch'),
    revenueToken: optionalKey(r.pubkey('revenueToken')),
  };
  r.skip(RESERVED.ValidatorPosition, '_reserved');
  return account;
}

export function decodeRevenueToken(data: Uint8Array): RevenueTokenAccount {
  const r = open('RevenueToken', data);
  const account: RevenueTokenAccount = {
    pool: r.pubkey('pool'),
    position: r.pubkey('position'),
    vote: r.pubkey('vote'),
    operator: r.pubkey('operator'),
    mint: r.pubkey('mint'),
    tokenProgram: r.pubkey('tokenProgram'),
    dbcPool: r.pubkey('dbcPool'),
    dbcConfig: r.pubkey('dbcConfig'),
    dammPool: optionalKey(r.pubkey('dammPool')),
    shareBps: r.u16('shareBps'),
    termEpochs: r.u16('termEpochs'),
    registeredEpoch: r.u64('registeredEpoch'),
    startEpoch: r.u64('startEpoch'),
    termEndEpoch: r.u64('termEndEpoch'),
    advanceSeqAtRegistration: r.u64('advanceSeqAtRegistration'),
    inflationCommissionBps: r.u16('inflationCommissionBps'),
    blockCommissionBps: r.u16('blockCommissionBps'),
    bump: r.u8('bump'),
    escrowBump: r.u8('escrowBump'),
    tokensBump: r.u8('tokensBump'),
    wsolBump: r.u8('wsolBump'),
    slicesPerEpoch: r.u8('slicesPerEpoch'),
    windowSlots: r.u32('windowSlots'),
    maxSlippageBps: r.u16('maxSlippageBps'),
    maxImpactBps: r.u16('maxImpactBps'),
    flags: r.u8('flags'),
    status: r.variant(REVENUE_TOKEN_STATUSES, 'status'),
    buybackEpoch: r.u64('buybackEpoch'),
    epochBudget: r.u64('epochBudget'),
    epochSpent: r.u64('epochSpent'),
    slicesDone: r.u32('slicesDone'),
    lastShareEpoch: r.u64('lastShareEpoch'),
    totalEscrowed: r.u64('totalEscrowed'),
    totalSpent: r.u64('totalSpent'),
    totalBought: r.u64('totalBought'),
    totalBurned: r.u64('totalBurned'),
    totalRedeemed: r.u64('totalRedeemed'),
    totalRedeemedLamports: r.u64('totalRedeemedLamports'),
    buybackCount: r.u32('buybackCount'),
    feeFloorBps: r.u16('feeFloorBps'),
  };
  r.skip(RESERVED.RevenueToken, '_reserved');
  return account;
}

/** The sweep in `epoch` pays the share (`RevenueToken::in_term`). */
export const revenueTokenInTerm = (rt: RevenueTokenAccount, epoch: bigint): boolean =>
  epoch >= rt.startEpoch && epoch < rt.termEndEpoch;

/** Release and commission cuts are blocked (`RevenueToken::term_active`). */
export const revenueTokenTermActive = (rt: RevenueTokenAccount, epoch: bigint): boolean => epoch < rt.termEndEpoch;

/** `redeem` is open: after the term, or during it when the admin set `redeemDuringTerm`. */
export const revenueTokenRedeemOpen = (rt: RevenueTokenAccount, epoch: bigint): boolean =>
  !revenueTokenTermActive(rt, epoch) || (rt.flags & REVENUE_TOKEN_FLAGS.redeemDuringTerm) !== 0;

/** The highest `maxImpactBps` `configure_revenue_token` accepts: twice the fee floor, capped at 1,000 bps. */
export const revenueTokenMaxImpactBound = (rt: RevenueTokenAccount): number => Math.min(rt.feeFloorBps * 2, 1_000);

/**
 * Whether `close_revenue_token` may run (`RevenueToken::close_mode`): `'spent'` after the term once at most
 * `MAX_CLOSE_DUST_LAMPORTS` remain (all to the operator); `'unclaimed'` once `REDEEM_GRACE_EPOCHS` passed after the
 * term, whatever the escrow holds (the rest becomes pool income); null otherwise.
 */
export function revenueTokenCloseMode(
  rt: RevenueTokenAccount,
  epoch: bigint,
  escrowAvailable: bigint,
): 'spent' | 'unclaimed' | null {
  if (revenueTokenTermActive(rt, epoch)) return null;
  if (escrowAvailable <= PROGRAM_CONSTANTS.MAX_CLOSE_DUST_LAMPORTS) return 'spent';
  return epoch >= rt.termEndEpoch + PROGRAM_CONSTANTS.REDEEM_GRACE_EPOCHS ? 'unclaimed' : null;
}

/** Buybacks paused by the pool admin. */
export const revenueTokenBuybacksPaused = (rt: RevenueTokenAccount): boolean =>
  (rt.flags & REVENUE_TOKEN_FLAGS.buybacksPaused) !== 0;

export function decodeAdvance(data: Uint8Array): AdvanceAccount {
  const r = open('Advance', data);
  const account: AdvanceAccount = {
    pool: r.pubkey('pool'),
    vote: r.pubkey('vote'),
    position: r.pubkey('position'),
    seq: r.u64('seq'),
    principal: r.u64('principal'),
    fee: r.u64('fee'),
    totalDue: r.u64('totalDue'),
    repaid: r.u64('repaid'),
    principalRepaid: r.u64('principalRepaid'),
    feeRepaid: r.u64('feeRepaid'),
    remitBps: r.u16('remitBps'),
    openedEpoch: r.u64('openedEpoch'),
    closedEpoch: r.u64('closedEpoch'),
    state: r.variant(ADVANCE_STATES, 'state'),
    bump: r.u8('bump'),
  };
  r.skip(RESERVED.Advance, '_reserved');
  return account;
}

export function decodeFeeIndex(data: Uint8Array): FeeIndexAccount {
  const r = open('FeeIndex', data);
  const account: FeeIndexAccount = {
    pool: r.pubkey('pool'),
    publisher: r.pubkey('publisher'),
    bump: r.u8('bump'),
    epoch: r.u64('epoch'),
    value: r.u64('value'),
    inputsHash: r.bytes(32, 'inputsHash'),
    finalizedSlot: r.u64('finalizedSlot'),
    hasProposal: r.bool('hasProposal'),
    proposedEpoch: r.u64('proposedEpoch'),
    proposedValue: r.u64('proposedValue'),
    proposedInputsHash: r.bytes(32, 'proposedInputsHash'),
    proposedSlot: r.u64('proposedSlot'),
    disputeWindowSlots: r.u64('disputeWindowSlots'),
    maxMoveBps: r.u16('maxMoveBps'),
    history: r.array(PROGRAM_CONSTANTS.INDEX_HISTORY, () => ({
      epoch: r.u64('history.epoch'),
      value: r.u64('history.value'),
    })),
    historyHead: r.u8('historyHead'),
    historyCount: r.u8('historyCount'),
  };
  r.skip(RESERVED.FeeIndex, '_reserved');
  return account;
}

export function decodeFeeQuote(data: Uint8Array): FeeQuoteAccount {
  const r = open('FeeQuote', data);
  const account: FeeQuoteAccount = {
    pool: r.pubkey('pool'),
    maker: r.pubkey('maker'),
    epoch: r.u64('epoch'),
    fixedRate: r.u64('fixedRate'),
    maxNotional: r.u64('maxNotional'),
    filledNotional: r.u64('filledNotional'),
    maxMoveBps: r.u16('maxMoveBps'),
    expirySlot: r.u64('expirySlot'),
    collateral: r.u64('collateral'),
    lockedCollateral: r.u64('lockedCollateral'),
    openSwaps: r.u32('openSwaps'),
    bump: r.u8('bump'),
  };
  r.skip(RESERVED.FeeQuote, '_reserved');
  return account;
}

export function decodeSwapPosition(data: Uint8Array): SwapPositionAccount {
  const r = open('SwapPosition', data);
  const account: SwapPositionAccount = {
    quote: r.pubkey('quote'),
    taker: r.pubkey('taker'),
    epoch: r.u64('epoch'),
    side: r.variant(SIDES, 'side'),
    notional: r.u64('notional'),
    fixedRate: r.u64('fixedRate'),
    maxMoveBps: r.u16('maxMoveBps'),
    collateral: r.u64('collateral'),
    settled: r.bool('settled'),
    pnl: r.i64('pnl'),
    bump: r.u8('bump'),
  };
  r.skip(RESERVED.SwapPosition, '_reserved');
  return account;
}

const DECODERS: { [K in AccountName]: (data: Uint8Array) => EpochAccountMap[K] } = {
  Pool: decodePool,
  LenderShares: decodeLenderShares,
  WithdrawRequest: decodeWithdrawRequest,
  ValidatorPosition: decodeValidatorPosition,
  Advance: decodeAdvance,
  FeeIndex: decodeFeeIndex,
  FeeQuote: decodeFeeQuote,
  SwapPosition: decodeSwapPosition,
  RevenueToken: decodeRevenueToken,
};

/**
 * Decode any Epoch account by its discriminator. Returns null when the discriminator is not one of the program's
 * accounts; throws when it is but the data is malformed (too short, invalid bool/Option/enum byte).
 */
export function decodeAccount(data: Uint8Array): DecodedAccount | null {
  const name = accountNameOf(data);
  if (name === null) return null;
  return { name, account: DECODERS[name](data) } as DecodedAccount;
}

// ─── getProgramAccounts filters ────────────────────────────────────────────

/** `[memcmp(discriminator) at 0, dataSize]`: every account of one type. */
export function accountFilters(name: AccountName): GetProgramAccountsFilter[] {
  const discriminator = ACCOUNT_DISCRIMINATORS[name];
  if (discriminator === undefined) throw new Error(`Unknown account type '${String(name)}'`);
  return [{ memcmp: { offset: 0, bytes: base58Encode(discriminator) } }, { dataSize: ACCOUNT_SIZES[name] }];
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** memcmp on a fixed-offset pubkey field, e.g. `fieldFilter('LenderShares', 'owner', wallet)`. */
export function fieldFilter(name: AccountName, field: string, key: PublicKey): GetProgramAccountsFilter {
  const table = FIELD_OFFSETS as Readonly<Record<string, Readonly<Record<string, number>>>>;
  if (!hasOwn(table, name) || !hasOwn(table[name], field)) {
    const supported = Object.entries(FIELD_OFFSETS)
      .map(([account, fields]) => `${account}.{${Object.keys(fields).join(',')}}`)
      .join(' ');
    throw new Error(`No fixed-offset pubkey field '${field}' on ${String(name)}; supported: ${supported}`);
  }
  return { memcmp: { offset: table[name][field], bytes: key.toBase58() } };
}

// ─── Ring buffers ──────────────────────────────────────────────────────────

function ring<T>(slots: readonly T[], head: number, count: number): T[] {
  const size = slots.length;
  const n = Math.min(count, size);
  const start = (head % size) - n + size;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(slots[(start + i) % size]);
  return out;
}

/** The filled `history` entries, oldest → newest (finalized points before the current `epoch`/`value`). */
export function feeIndexHistory(index: FeeIndexAccount): IndexPoint[] {
  return ring(index.history, index.historyHead, index.historyCount);
}

/**
 * Mirrors `FeeIndex::value_for`: the current value if `epoch` is the finalized epoch (and something was finalized),
 * else the first matching history slot in array order, else null.
 */
export function feeIndexValueFor(index: FeeIndexAccount, epoch: bigint): bigint | null {
  if (index.epoch === epoch && index.finalizedSlot > 0n) return index.value;
  const n = Math.min(index.historyCount, index.history.length);
  for (let i = 0; i < n; i++) if (index.history[i].epoch === epoch) return index.history[i].value;
  return null;
}

/** The filled `revenue` entries, oldest → newest. */
export function revenueHistory(position: ValidatorPositionAccount): bigint[] {
  return ring(position.revenue, position.revenueHead, position.revenueCount);
}

/** Mirrors `ValidatorPosition::trailing_revenue`: saturating sum of the filled slots. */
export function trailingRevenue(position: ValidatorPositionAccount): bigint {
  const n = Math.min(position.revenueCount, PROGRAM_CONSTANTS.REVENUE_WINDOW);
  let sum = 0n;
  for (let i = 0; i < n; i++) {
    sum += position.revenue[i];
    if (sum > U64_MAX) return U64_MAX;
  }
  return sum;
}
