/**
 * The 34 `#[event]`s in `programs/epoch/src/events.rs`. Anchor's `emit!` logs each as
 * `Program data: <base64(discriminator ++ borsh(event))>`.
 */
import { type PublicKey } from '@solana/web3.js';

import { BorshReader } from './borsh';
import {
  BUYBACK_VENUES,
  type BuybackVenue,
  SIDES,
  type Side,
  type Tranche,
  TRANCHES,
  TREASURY_CLAIM_KINDS,
  type TreasuryClaimKind,
} from './constants';
import { type EventName, eventNameOf } from './discriminators';
import { base64Decode, bytesToHex } from './encoding';

/** Event name → `data` shape: the Rust fields in camelCase (u64/i64 → bigint, u8/u16 → number). */
export interface EpochEventMap {
  PoolInitialized: { pool: PublicKey; admin: PublicKey; treasury: PublicKey; scorer: PublicKey };
  ParamsUpdated: { pool: PublicKey };
  PauseToggled: { pool: PublicKey; paused: boolean };
  Deposited: {
    pool: PublicKey;
    owner: PublicKey;
    tranche: Tranche;
    assets: bigint;
    shares: bigint;
    sharePriceE9: bigint;
  };
  WithdrawRequested: { pool: PublicKey; owner: PublicKey; tranche: Tranche; shares: bigint; seq: bigint };
  /** `reason`: 0 = cancelled by the owner, 1 = bounced by the junior floor at the head of the queue. */
  WithdrawCancelled: { pool: PublicKey; owner: PublicKey; seq: bigint; reason: number };
  WithdrawProcessed: {
    pool: PublicKey;
    owner: PublicKey;
    tranche: Tranche;
    shares: bigint;
    assets: bigint;
    seq: bigint;
  };
  Accrued: {
    pool: PublicKey;
    epoch: bigint;
    income: bigint;
    protocolFee: bigint;
    seniorGain: bigint;
    juniorGain: bigint;
    seniorPriceE9: bigint;
    juniorPriceE9: bigint;
  };
  ValidatorOnboarded: {
    pool: PublicKey;
    vote: PublicKey;
    identity: PublicKey;
    operator: PublicKey;
    originalWithdrawer: PublicKey;
    epoch: bigint;
  };
  CollectorsSet: { vote: PublicKey; collector: PublicKey };
  ScoreUpdated: { vote: PublicKey; epoch: bigint; score: number; hedged: boolean };
  BondPosted: { vote: PublicKey; lamports: bigint; bondTotal: bigint };
  BondWithdrawn: { vote: PublicKey; lamports: bigint; bondTotal: bigint };
  AdvanceOpened: {
    pool: PublicKey;
    vote: PublicKey;
    advance: PublicKey;
    seq: bigint;
    principal: bigint;
    fee: bigint;
    remitBps: number;
    epoch: bigint;
  };
  Swept: {
    pool: PublicKey;
    vote: PublicKey;
    epoch: bigint;
    /** Withdrawn from the vote account this sweep. */
    fromVote: bigint;
    /** Total gross revenue processed (vote withdrawal + collector deposits). */
    gross: bigint;
    remitted: bigint;
    toOperator: bigint;
  };
  AdvanceRepaid: { vote: PublicKey; advance: PublicKey; epoch: bigint };
  AdvanceDefaulted: {
    pool: PublicKey;
    vote: PublicKey;
    advance: PublicKey;
    principalLost: bigint;
    bondApplied: bigint;
    epoch: bigint;
  };
  /** `kind`: 0 = inflation rewards, 1 = block revenue. */
  CommissionUpdated: { vote: PublicKey; kind: number; commissionBps: number };
  IdentityUpdated: { vote: PublicKey; newIdentity: PublicKey };
  ValidatorReleased: { pool: PublicKey; vote: PublicKey; newWithdrawer: PublicKey; epoch: bigint };
  IndexProposed: { epoch: bigint; value: bigint; inputsHash: Uint8Array; slot: bigint };
  IndexFinalized: { epoch: bigint; value: bigint; inputsHash: Uint8Array; slot: bigint };
  IndexVetoed: { epoch: bigint; value: bigint };
  IndexOperatorsInitialized: {
    feeIndex: PublicKey;
    indexOperators: PublicKey;
    thresholdBps: number;
    toleranceBps: number;
  };
  IndexOperatorAdded: {
    feeIndex: PublicKey;
    operator: PublicKey;
    weight: number;
    totalWeight: bigint;
    operatorCount: number;
  };
  IndexOperatorRemoved: {
    feeIndex: PublicKey;
    operator: PublicKey;
    weight: number;
    totalWeight: bigint;
    operatorCount: number;
  };
  IndexOperatorWeightSet: {
    feeIndex: PublicKey;
    operator: PublicKey;
    oldWeight: number;
    weight: number;
    totalWeight: bigint;
  };
  IndexConsensusSet: { feeIndex: PublicKey; thresholdBps: number; toleranceBps: number };
  /** A ballot round opened, with the registry snapshot it votes under. */
  IndexBallotOpened: {
    feeIndex: PublicKey;
    ballot: PublicKey;
    epoch: bigint;
    round: number;
    operators: { key: PublicKey; weight: number }[];
    totalWeight: bigint;
    thresholdBps: number;
    toleranceBps: number;
    /** Opened by the admin's `reset_index_ballot`. */
    reset: boolean;
    slot: bigint;
  };
  /** One operator's vote and the round's tally after it. */
  IndexVoteCast: {
    feeIndex: PublicKey;
    epoch: bigint;
    round: number;
    operator: PublicKey;
    weight: number;
    value: bigint;
    inputsHash: Uint8Array;
    deviationBps: number;
    agrees: boolean;
    changed: boolean;
    late: boolean;
    medianValue: bigint;
    agreeingWeight: bigint;
    totalWeight: bigint;
    votesCast: number;
    slot: bigint;
  };
  /** `proposed`: the value went into the FeeIndex in the same instruction; otherwise it is queued. */
  IndexConsensusReached: {
    feeIndex: PublicKey;
    epoch: bigint;
    round: number;
    value: bigint;
    inputsHash: Uint8Array;
    agreeingWeight: bigint;
    totalWeight: bigint;
    thresholdBps: number;
    votesCast: number;
    proposed: boolean;
    slot: bigint;
  };
  IndexBallotSubmitted: { feeIndex: PublicKey; epoch: bigint; round: number; value: bigint; slot: bigint };
  IndexBallotClosed: { feeIndex: PublicKey; epoch: bigint; round: number; payer: PublicKey; lamports: bigint };
  QuotePosted: {
    quote: PublicKey;
    maker: PublicKey;
    epoch: bigint;
    fixedRate: bigint;
    maxNotional: bigint;
    maxMoveBps: number;
  };
  SwapOpened: {
    quote: PublicKey;
    swap: PublicKey;
    taker: PublicKey;
    epoch: bigint;
    side: Side;
    notional: bigint;
    fixedRate: bigint;
    collateral: bigint;
  };
  /** `takerPnl` is an `i64`: negative when the taker lost. */
  SwapSettled: { swap: PublicKey; epoch: bigint; indexValue: bigint; takerPnl: bigint };
  RevenueTokenRegistered: {
    pool: PublicKey;
    vote: PublicKey;
    revenueToken: PublicKey;
    mint: PublicKey;
    dbcPool: PublicKey;
    shareBps: number;
    termEpochs: number;
    startEpoch: bigint;
    termEndEpoch: bigint;
    inflationCommissionBps: number;
    blockCommissionBps: number;
  };
  /** The share a sweep moved into the buyback escrow (next to `Swept`, whose `gross` includes it). */
  RevenueShareSwept: {
    vote: PublicKey;
    mint: PublicKey;
    epoch: bigint;
    gross: bigint;
    share: bigint;
    /** The share came after a pre-registration advance's remittance. */
    afterSeniorAdvance: boolean;
    /** Escrow balance above rent after the sweep. */
    escrowBalance: bigint;
  };
  RevenueTokenPoolSynced: {
    vote: PublicKey;
    mint: PublicKey;
    dbcPool: PublicKey;
    dammPool: PublicKey;
    dammConfig: PublicKey;
  };
  BuybackExecuted: {
    vote: PublicKey;
    mint: PublicKey;
    venue: BuybackVenue;
    epoch: bigint;
    slice: number;
    /** SOL the swap used. */
    lamportsIn: bigint;
    tokensBought: bigint;
    tokensBurned: bigint;
    minAmountOut: bigint;
    /** The pool's output for `lamportsIn` before fees, at execution: the floor's reference. */
    feeFreeOut: bigint;
    escrowBalance: bigint;
  };
  RevenueTokenRedeemed: {
    vote: PublicKey;
    mint: PublicKey;
    holder: PublicKey;
    tokensBurned: bigint;
    lamportsOut: bigint;
    circulatingSupply: bigint;
    epoch: bigint;
  };
  RevenueTokenConfigured: {
    vote: PublicKey;
    slicesPerEpoch: number;
    windowSlots: number;
    maxSlippageBps: number;
    maxImpactBps: number;
    flags: number;
  };
  RevenueTokenClosed: {
    vote: PublicKey;
    mint: PublicKey;
    totalEscrowed: bigint;
    totalSpent: bigint;
    totalBurned: bigint;
    totalRedeemed: bigint;
    /** Escrow left unclaimed after the redemption grace period, booked as pool income (0 when spent). */
    lamportsToPool: bigint;
  };
  /** The partner treasury claimed from Meteora: SOL to the pool as income, tokens burned. */
  TreasuryClaimed: {
    pool: PublicKey;
    kind: TreasuryClaimKind;
    /** The token (DBC base mint / DAMM v2 token A). */
    mint: PublicKey;
    /** The DBC pool, or the DAMM v2 pool for `lpFee`. */
    source: PublicKey;
    /** The DAMM v2 position for `lpFee`; `PublicKey.default` (`1111…1111`) otherwise. */
    position: PublicKey;
    cranker: PublicKey;
    lamportsClaimed: bigint;
    lamportsToPool: bigint;
    tokensClaimed: bigint;
    tokensBurned: bigint;
    poolCash: bigint;
    incomeUnallocated: bigint;
  };
  HistoryInitialized: { vote: PublicKey; history: PublicKey; payer: PublicKey; epoch: bigint };
  VoteAccountCopied: {
    vote: PublicKey;
    epoch: bigint;
    slot: bigint;
    /** Credits earned so far in `epoch`. */
    epochCredits: bigint;
    epochsBackfilled: number;
    /** `null` for an empty tower. */
    lastVotedSlot: bigint | null;
    inflationCommissionBps: number;
    blockCommissionBps: number;
    voteLamports: bigint;
    revenueLamports: bigint;
  };
  TipDistributionCopied: {
    vote: PublicKey;
    epoch: bigint;
    /** False when the account does not exist (no Jito, or not created yet). */
    found: boolean;
    mevCommissionBps: number | null;
    /** `max_total_claim` once the merkle root is uploaded. */
    mevEarnedLamports: bigint | null;
  };
  PriorityFeeDistributionCopied: {
    vote: PublicKey;
    epoch: bigint;
    found: boolean;
    priorityFeeCommissionBps: number | null;
    priorityFeesLamports: bigint | null;
  };
  StakeInfoUpdated: {
    vote: PublicKey;
    epoch: bigint;
    activatedStakeLamports: bigint;
    rank: number;
    superminority: boolean;
  };
  ScoreRefreshed: {
    pool: PublicKey;
    vote: PublicKey;
    epoch: bigint;
    score: number;
    creditsRatioBps: number;
    creditsRatioRawBps: number;
    commissionBps: number;
    epochsActive: number;
    delinquent: boolean;
    superminority: boolean;
    hedged: boolean;
    hedgeRequiredNotional: bigint;
  };
  ScoringConfigured: {
    pool: PublicKey;
    marketMaker: PublicKey;
    creditsWindowEpochs: number;
    countBlockCommission: boolean;
    creditsReferenceBps: number;
    maxCopyAgeSlots: number;
  };
  /** `withdraw_quote` closed the quote; `lamports` (collateral left plus rent) went back to the maker. */
  QuoteWithdrawn: { quote: PublicKey; maker: PublicKey; epoch: bigint; lamports: bigint };
}

/** One member per event, discriminated by `name`. */
export type EpochEvent = { [K in EventName]: { name: K; data: EpochEventMap[K] } }[EventName];

/** A JSON-safe scalar in `eventToJson`'s output. */
export type EventJsonScalar = string | number | boolean;

/**
 * One field of `eventToJson`'s output: a scalar, or a list of flat records for an event's `Vec<struct>` field
 * (`IndexBallotOpened.operators` → `[{ key: base58, weight: number }]`).
 */
export type EventJsonValue = EventJsonScalar | Record<string, EventJsonScalar>[];

/** The JSON-safe form from `eventToJson`. */
export interface EpochEventJson {
  name: EventName;
  /** A `None` Option field is left out. */
  data: Record<string, EventJsonValue>;
}

const DECODERS: { [K in EventName]: (r: BorshReader) => EpochEventMap[K] } = {
  PoolInitialized: (r) => ({ pool: r.pubkey(), admin: r.pubkey(), treasury: r.pubkey(), scorer: r.pubkey() }),
  ParamsUpdated: (r) => ({ pool: r.pubkey() }),
  PauseToggled: (r) => ({ pool: r.pubkey(), paused: r.bool('paused') }),
  Deposited: (r) => ({
    pool: r.pubkey(),
    owner: r.pubkey(),
    tranche: r.variant(TRANCHES, 'tranche'),
    assets: r.u64(),
    shares: r.u64(),
    sharePriceE9: r.u64(),
  }),
  WithdrawRequested: (r) => ({
    pool: r.pubkey(),
    owner: r.pubkey(),
    tranche: r.variant(TRANCHES, 'tranche'),
    shares: r.u64(),
    seq: r.u64(),
  }),
  WithdrawCancelled: (r) => ({ pool: r.pubkey(), owner: r.pubkey(), seq: r.u64(), reason: r.u8() }),
  WithdrawProcessed: (r) => ({
    pool: r.pubkey(),
    owner: r.pubkey(),
    tranche: r.variant(TRANCHES, 'tranche'),
    shares: r.u64(),
    assets: r.u64(),
    seq: r.u64(),
  }),
  Accrued: (r) => ({
    pool: r.pubkey(),
    epoch: r.u64(),
    income: r.u64(),
    protocolFee: r.u64(),
    seniorGain: r.u64(),
    juniorGain: r.u64(),
    seniorPriceE9: r.u64(),
    juniorPriceE9: r.u64(),
  }),
  ValidatorOnboarded: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    identity: r.pubkey(),
    operator: r.pubkey(),
    originalWithdrawer: r.pubkey(),
    epoch: r.u64(),
  }),
  CollectorsSet: (r) => ({ vote: r.pubkey(), collector: r.pubkey() }),
  ScoreUpdated: (r) => ({ vote: r.pubkey(), epoch: r.u64(), score: r.u16(), hedged: r.bool('hedged') }),
  BondPosted: (r) => ({ vote: r.pubkey(), lamports: r.u64(), bondTotal: r.u64() }),
  BondWithdrawn: (r) => ({ vote: r.pubkey(), lamports: r.u64(), bondTotal: r.u64() }),
  AdvanceOpened: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    advance: r.pubkey(),
    seq: r.u64(),
    principal: r.u64(),
    fee: r.u64(),
    remitBps: r.u16(),
    epoch: r.u64(),
  }),
  Swept: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    epoch: r.u64(),
    fromVote: r.u64(),
    gross: r.u64(),
    remitted: r.u64(),
    toOperator: r.u64(),
  }),
  AdvanceRepaid: (r) => ({ vote: r.pubkey(), advance: r.pubkey(), epoch: r.u64() }),
  AdvanceDefaulted: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    advance: r.pubkey(),
    principalLost: r.u64(),
    bondApplied: r.u64(),
    epoch: r.u64(),
  }),
  CommissionUpdated: (r) => ({ vote: r.pubkey(), kind: r.u8(), commissionBps: r.u16() }),
  IdentityUpdated: (r) => ({ vote: r.pubkey(), newIdentity: r.pubkey() }),
  ValidatorReleased: (r) => ({ pool: r.pubkey(), vote: r.pubkey(), newWithdrawer: r.pubkey(), epoch: r.u64() }),
  IndexProposed: (r) => ({ epoch: r.u64(), value: r.u64(), inputsHash: r.bytes(32), slot: r.u64() }),
  IndexFinalized: (r) => ({ epoch: r.u64(), value: r.u64(), inputsHash: r.bytes(32), slot: r.u64() }),
  IndexVetoed: (r) => ({ epoch: r.u64(), value: r.u64() }),
  IndexOperatorsInitialized: (r) => ({
    feeIndex: r.pubkey(),
    indexOperators: r.pubkey(),
    thresholdBps: r.u16('thresholdBps'),
    toleranceBps: r.u16('toleranceBps'),
  }),
  IndexOperatorAdded: (r) => ({
    feeIndex: r.pubkey(),
    operator: r.pubkey(),
    weight: r.u32('weight'),
    totalWeight: r.u64('totalWeight'),
    operatorCount: r.u8('operatorCount'),
  }),
  IndexOperatorRemoved: (r) => ({
    feeIndex: r.pubkey(),
    operator: r.pubkey(),
    weight: r.u32('weight'),
    totalWeight: r.u64('totalWeight'),
    operatorCount: r.u8('operatorCount'),
  }),
  IndexOperatorWeightSet: (r) => ({
    feeIndex: r.pubkey(),
    operator: r.pubkey(),
    oldWeight: r.u32('oldWeight'),
    weight: r.u32('weight'),
    totalWeight: r.u64('totalWeight'),
  }),
  IndexConsensusSet: (r) => ({
    feeIndex: r.pubkey(),
    thresholdBps: r.u16('thresholdBps'),
    toleranceBps: r.u16('toleranceBps'),
  }),
  IndexBallotOpened: (r) => ({
    feeIndex: r.pubkey(),
    ballot: r.pubkey(),
    epoch: r.u64('epoch'),
    round: r.u8('round'),
    operators: Array.from({ length: r.u32('operators.length') }, () => ({
      key: r.pubkey('operators.key'),
      weight: r.u32('operators.weight'),
    })),
    totalWeight: r.u64('totalWeight'),
    thresholdBps: r.u16('thresholdBps'),
    toleranceBps: r.u16('toleranceBps'),
    reset: r.bool('reset'),
    slot: r.u64('slot'),
  }),
  IndexVoteCast: (r) => ({
    feeIndex: r.pubkey(),
    epoch: r.u64('epoch'),
    round: r.u8('round'),
    operator: r.pubkey(),
    weight: r.u32('weight'),
    value: r.u64('value'),
    inputsHash: r.bytes(32, 'inputsHash'),
    deviationBps: r.u32('deviationBps'),
    agrees: r.bool('agrees'),
    changed: r.bool('changed'),
    late: r.bool('late'),
    medianValue: r.u64('medianValue'),
    agreeingWeight: r.u64('agreeingWeight'),
    totalWeight: r.u64('totalWeight'),
    votesCast: r.u8('votesCast'),
    slot: r.u64('slot'),
  }),
  IndexConsensusReached: (r) => ({
    feeIndex: r.pubkey(),
    epoch: r.u64('epoch'),
    round: r.u8('round'),
    value: r.u64('value'),
    inputsHash: r.bytes(32, 'inputsHash'),
    agreeingWeight: r.u64('agreeingWeight'),
    totalWeight: r.u64('totalWeight'),
    thresholdBps: r.u16('thresholdBps'),
    votesCast: r.u8('votesCast'),
    proposed: r.bool('proposed'),
    slot: r.u64('slot'),
  }),
  IndexBallotSubmitted: (r) => ({
    feeIndex: r.pubkey(),
    epoch: r.u64('epoch'),
    round: r.u8('round'),
    value: r.u64('value'),
    slot: r.u64('slot'),
  }),
  IndexBallotClosed: (r) => ({
    feeIndex: r.pubkey(),
    epoch: r.u64('epoch'),
    round: r.u8('round'),
    payer: r.pubkey(),
    lamports: r.u64('lamports'),
  }),
  QuotePosted: (r) => ({
    quote: r.pubkey(),
    maker: r.pubkey(),
    epoch: r.u64(),
    fixedRate: r.u64(),
    maxNotional: r.u64(),
    maxMoveBps: r.u16(),
  }),
  SwapOpened: (r) => ({
    quote: r.pubkey(),
    swap: r.pubkey(),
    taker: r.pubkey(),
    epoch: r.u64(),
    side: r.variant(SIDES, 'side'),
    notional: r.u64(),
    fixedRate: r.u64(),
    collateral: r.u64(),
  }),
  SwapSettled: (r) => ({ swap: r.pubkey(), epoch: r.u64(), indexValue: r.u64(), takerPnl: r.i64() }),
  RevenueTokenRegistered: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    revenueToken: r.pubkey(),
    mint: r.pubkey(),
    dbcPool: r.pubkey(),
    shareBps: r.u16(),
    termEpochs: r.u16(),
    startEpoch: r.u64(),
    termEndEpoch: r.u64(),
    inflationCommissionBps: r.u16(),
    blockCommissionBps: r.u16(),
  }),
  RevenueShareSwept: (r) => ({
    vote: r.pubkey(),
    mint: r.pubkey(),
    epoch: r.u64(),
    gross: r.u64(),
    share: r.u64(),
    afterSeniorAdvance: r.bool('afterSeniorAdvance'),
    escrowBalance: r.u64(),
  }),
  RevenueTokenPoolSynced: (r) => ({
    vote: r.pubkey(),
    mint: r.pubkey(),
    dbcPool: r.pubkey(),
    dammPool: r.pubkey(),
    dammConfig: r.pubkey(),
  }),
  BuybackExecuted: (r) => ({
    vote: r.pubkey(),
    mint: r.pubkey(),
    venue: r.variant(BUYBACK_VENUES, 'venue'),
    epoch: r.u64(),
    slice: r.u8(),
    lamportsIn: r.u64(),
    tokensBought: r.u64(),
    tokensBurned: r.u64(),
    minAmountOut: r.u64(),
    feeFreeOut: r.u64(),
    escrowBalance: r.u64(),
  }),
  RevenueTokenRedeemed: (r) => ({
    vote: r.pubkey(),
    mint: r.pubkey(),
    holder: r.pubkey(),
    tokensBurned: r.u64(),
    lamportsOut: r.u64(),
    circulatingSupply: r.u64(),
    epoch: r.u64(),
  }),
  RevenueTokenConfigured: (r) => ({
    vote: r.pubkey(),
    slicesPerEpoch: r.u8(),
    windowSlots: r.u32(),
    maxSlippageBps: r.u16(),
    maxImpactBps: r.u16(),
    flags: r.u8(),
  }),
  RevenueTokenClosed: (r) => ({
    vote: r.pubkey(),
    mint: r.pubkey(),
    totalEscrowed: r.u64(),
    totalSpent: r.u64(),
    totalBurned: r.u64(),
    totalRedeemed: r.u64(),
    lamportsToPool: r.u64(),
  }),
  TreasuryClaimed: (r) => ({
    pool: r.pubkey(),
    kind: r.variant(TREASURY_CLAIM_KINDS, 'kind'),
    mint: r.pubkey(),
    source: r.pubkey(),
    position: r.pubkey(),
    cranker: r.pubkey(),
    lamportsClaimed: r.u64(),
    lamportsToPool: r.u64(),
    tokensClaimed: r.u64(),
    tokensBurned: r.u64(),
    poolCash: r.u64(),
    incomeUnallocated: r.u64(),
  }),
  HistoryInitialized: (r) => ({ vote: r.pubkey(), history: r.pubkey(), payer: r.pubkey(), epoch: r.u64() }),
  VoteAccountCopied: (r) => ({
    vote: r.pubkey(),
    epoch: r.u64(),
    slot: r.u64(),
    epochCredits: r.u64(),
    epochsBackfilled: r.u8(),
    lastVotedSlot: r.option(() => r.u64(), 'lastVotedSlot'),
    inflationCommissionBps: r.u16(),
    blockCommissionBps: r.u16(),
    voteLamports: r.u64(),
    revenueLamports: r.u64(),
  }),
  TipDistributionCopied: (r) => ({
    vote: r.pubkey(),
    epoch: r.u64(),
    found: r.bool('found'),
    mevCommissionBps: r.option(() => r.u16(), 'mevCommissionBps'),
    mevEarnedLamports: r.option(() => r.u64(), 'mevEarnedLamports'),
  }),
  PriorityFeeDistributionCopied: (r) => ({
    vote: r.pubkey(),
    epoch: r.u64(),
    found: r.bool('found'),
    priorityFeeCommissionBps: r.option(() => r.u16(), 'priorityFeeCommissionBps'),
    priorityFeesLamports: r.option(() => r.u64(), 'priorityFeesLamports'),
  }),
  StakeInfoUpdated: (r) => ({
    vote: r.pubkey(),
    epoch: r.u64(),
    activatedStakeLamports: r.u64(),
    rank: r.u32(),
    superminority: r.bool('superminority'),
  }),
  ScoreRefreshed: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    epoch: r.u64(),
    score: r.u16(),
    creditsRatioBps: r.u16(),
    creditsRatioRawBps: r.u16(),
    commissionBps: r.u16(),
    epochsActive: r.u16(),
    delinquent: r.bool('delinquent'),
    superminority: r.bool('superminority'),
    hedged: r.bool('hedged'),
    hedgeRequiredNotional: r.u64(),
  }),
  ScoringConfigured: (r) => ({
    pool: r.pubkey(),
    marketMaker: r.pubkey(),
    creditsWindowEpochs: r.u8(),
    countBlockCommission: r.bool('countBlockCommission'),
    creditsReferenceBps: r.u16(),
    maxCopyAgeSlots: r.u32(),
  }),
  QuoteWithdrawn: (r) => ({ quote: r.pubkey(), maker: r.pubkey(), epoch: r.u64(), lamports: r.u64() }),
};

/**
 * Decode `discriminator ++ borsh(event)` (the bytes inside a `Program data:` line). Returns null for an unknown
 * discriminator; throws if a known event's bytes are malformed. Trailing bytes are ignored.
 */
export function decodeEvent(data: Uint8Array): EpochEvent | null {
  const name = eventNameOf(data);
  if (name === null) return null;
  const reader = new BorshReader(data, 8);
  return { name, data: DECODERS[name](reader) } as EpochEvent;
}

// Program ids are base58, so `Program log: …` / `Program data: …` lines can never match these.
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success$|failed)/;
const DATA_PREFIX = 'Program data: ';

/**
 * Epoch events in a transaction's log messages, in log order. Only `Program data:` lines written while `programId`
 * is the innermost executing program count: the invocation stack is tracked from `Program X invoke [n]` and
 * `Program X success` / `Program X failed: …` lines (`Program X consumed …` and `Program log:` lines leave it
 * unchanged), so data logged by other programs — including programs this one calls — is ignored.
 */
export function parseEventsFromLogs(logs: readonly string[], programId: PublicKey): EpochEvent[] {
  const target = programId.toBase58();
  const stack: string[] = [];
  const events: EpochEvent[] = [];
  for (const line of logs) {
    if (line.startsWith(DATA_PREFIX)) {
      if (stack.length === 0 || stack[stack.length - 1] !== target) continue;
      const payload = line.slice(DATA_PREFIX.length).trim();
      // `emit!` logs one base64 field; several space-separated fields are a raw `sol_log_data`, not an event.
      if (payload.length === 0 || payload.includes(' ')) continue;
      const event = decodeEvent(base64Decode(payload));
      if (event) events.push(event);
      continue;
    }
    const invoke = INVOKE.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth >= 1 && depth - 1 < stack.length) stack.length = depth - 1;
      stack.push(invoke[1]);
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      const at = stack.lastIndexOf(exit[1]);
      if (at >= 0) stack.length = at;
    }
  }
  return events;
}

function isPublicKeyLike(value: unknown): value is PublicKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toBase58?: unknown }).toBase58 === 'function' &&
    typeof (value as { toBytes?: unknown }).toBytes === 'function'
  );
}

function scalarToJson(value: unknown, where: string): EventJsonScalar {
  if (isPublicKeyLike(value)) return value.toBase58();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  throw new TypeError(`eventToJson: unsupported value for ${where}`);
}

/**
 * JSON-safe copy: pubkeys → base58, bigints → decimal strings, byte arrays → hex; numbers, booleans, enums as-is;
 * a `None` Option is left out. A list of structs (`IndexBallotOpened.operators`) becomes a list of flat records
 * converted the same way.
 */
export function eventToJson(event: EpochEvent): EpochEventJson {
  const data: Record<string, EventJsonValue> = {};
  for (const [key, value] of Object.entries(event.data) as [string, unknown][]) {
    if (value === null) continue; // a `None` Option: left out
    if (Array.isArray(value)) {
      data[key] = value.map((item: unknown, i) => {
        if (typeof item !== 'object' || item === null || isPublicKeyLike(item)) {
          throw new TypeError(`eventToJson: unsupported value for ${event.name}.${key}[${i}]`);
        }
        const record: Record<string, EventJsonScalar> = {};
        for (const [field, v] of Object.entries(item) as [string, unknown][]) {
          record[field] = scalarToJson(v, `${event.name}.${key}[${i}].${field}`);
        }
        return record;
      });
    } else {
      data[key] = scalarToJson(value, `${event.name}.${key}`);
    }
  }
  return { name: event.name, data };
}
