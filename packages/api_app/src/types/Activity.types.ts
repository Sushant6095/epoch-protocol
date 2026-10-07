// Response shapes for the activity feed, the Fee Index status and WS /v1/stream (requests #3 and #4). They mirror
// the frontend contract (handover contracts/epoch-data.ts: ActivityEvent, ActivityFeed, FeeIndexPoint) and
// 07-DATA-CONTRACTS.md (the stream's channels). Units live in field names; `null` means "not known yet".

import type { FeeIndexPoint as ComputedFeeIndexPoint, Meta } from './Api.types';

// ── GET /v1/activity · WS /v1/stream channel `activity` ─────────────────────────────────────────────
/**
 * "swap": a Fee Market swap opened or settled (request #19). "buyback": a revenue-token buyback slice (request #22).
 * "score": the on-chain score (P1): a validator history opened or copied, the scorer's stake post, a refresh, the
 * scoring settings.
 */
export type ActivityKind =
  'sweep' | 'deposit' | 'predict' | 'advance' | 'index' | 'withdraw' | 'swap' | 'buyback' | 'score';

export interface ActivityEvent {
  /** `<signature>:<ix>` for a program event (ix = its position among the transaction's events), `predict:<id>` for a call. */
  id: string;
  kind: ActivityKind;
  text: string;
  amountSol: number | null;
  value: number | null;
  /** "points": a Predict call (value = points, amountSol null, no signature: a call is not a transaction). */
  unit: 'SOL' | 'µL/CU' | 'points';
  /** Transaction signature for the explorer link (on the program's cluster, devnet for now); null for a Predict call. */
  signature: string | null;
  /**
   * Kind `buyback` only (request #29): the revenue token's mint the event names (buybacks, redemptions, treasury
   * claims…), so a token page can react to its own events; null when the event names none. Absent on other kinds.
   */
  mint?: string | null;
}

export interface ActivityFeed extends Meta {
  /** Newest first. */
  events: ActivityEvent[];
}

// ── GET /v1/index · WS /v1/stream channel `feeIndex` ────────────────────────────────────────────────
/**
 * "vetoed": the admin dropped the proposal inside its dispute window; it stays visible until a new one is posted.
 * "voting": operator consensus is open for the epoch (no agreed value yet, or an agreed value queued until the
 * FeeIndex can take it); the value is the current weighted median of the votes (the agreed value once queued).
 */
export type FeeIndexStatus = 'final' | 'proposed' | 'vetoed' | 'voting';

/** One operator's slot in a Fee Index ballot round. */
export interface FeeIndexBallotVote {
  operator: string;
  /** Registry weight in the round's snapshot. */
  weight: number;
  voted: boolean;
  /** µL/CU; null when not voted. */
  value: number | null;
  /** Hex sha256 of the operator's inputs (publisher_app Index/InputsHash.ts); null when not voted. */
  inputsHash: string | null;
  /** From the weighted median before consensus, from the agreed value after it, in bps rounded up; null when not voted. */
  deviationBps: number | null;
  /** Within the tolerance of the median (of the agreed value after consensus); null when not voted. */
  agrees: boolean | null;
  /** Cast after consensus: on the record, never counted. */
  late: boolean;
  /** Program-cluster slot of the vote; null when not voted. */
  slot: number | null;
}

/**
 * A Fee Index ballot (operator consensus, docs/FEE_INDEX_METHODOLOGY.md): the current round's operators, weights,
 * values and deviations, and whether the agreeing weight reached the threshold.
 */
export interface FeeIndexBallotView {
  /** IndexBallot account, PDA ["index_ballot", fee_index, epoch le-bytes]. */
  address: string;
  /** Program epoch voted on. */
  programEpoch: number;
  /** 0 for the first round; +1 each time a vetoed or stuck ballot reopens. */
  round: number;
  /** voting · queued (agreed, waiting for the FeeIndex) · proposed (in the dispute window) · vetoed · settled. */
  status: 'voting' | 'queued' | 'proposed' | 'vetoed' | 'settled';
  /** Agreeing weight needed, bps of the total registered weight (two thirds = 6,667). */
  thresholdBps: number;
  /** A vote agrees when within this many bps of the weighted median. */
  toleranceBps: number;
  totalWeight: number;
  agreeingWeight: number;
  /** agreeingWeight as bps of totalWeight, rounded up as the program compares it. */
  agreeingBps: number;
  votesCast: number;
  operatorCount: number;
  /** Weighted median of the votes cast (µL/CU); null before the first vote of the round. */
  medianValue: number | null;
  consensus: boolean;
  /** The agreed value; null before consensus. */
  consensusValue: number | null;
  consensusSlot: number | null;
  votes: FeeIndexBallotVote[];
  /** `account`: the live IndexBallot; `events`: rebuilt from the indexed events once the account is closed. */
  source: 'account' | 'events';
}

/** The contract's FeeIndexPoint: the computed point plus the program's status (request #3). */
export interface FeeIndexPoint extends ComputedFeeIndexPoint {
  /** Set when the value comes from the program; absent for epochs only the indexer computed (epoch_index). */
  status?: FeeIndexStatus;
}

/** The newest program values: what the Fee Market KPIs and `FeeMarketSnapshot.index` need. */
export interface FeeIndexLatest {
  /** The last finalized value. */
  final: { epoch: number; value: number } | null;
  /**
   * The pending proposal. `disputeEndsSlot`: the program cluster's slot after which anyone can finalize it
   * (proposal slot + dispute window); null when the FeeIndex account could not be read.
   */
  proposed: { epoch: number; value: number; disputeEndsSlot: number | null } | null;
  /** Mean of the last 8 final values (µL/CU, rounded); null before the first final value. */
  avg8: number | null;
}

// ── GET /v1/index/latest-final ──────────────────────────────────────────────────────────────────────
/**
 * The newest FINAL Solana Fee Index value, read from the FeeIndex account: the same fields another program trusts on
 * chain (docs/FEE_INDEX_METHODOLOGY.md, "Reading the index"). A pending proposal never shows here.
 */
export interface FeeIndexLatestFinal extends Meta {
  /** The program epoch of the value (the mainnet epoch when the program runs on mainnet). */
  epoch: number;
  /** µL/CU. */
  value: number;
  unit: 'µL/CU';
  /** The program cluster's slot `finalize_index` ran in. */
  finalizedSlot: number;
  /** Hex sha256 of the value's inputs (publisher_app Index/InputsHash.ts). */
  inputsHash: string;
  cluster: string;
  programId: string;
  feeIndexAccount: string;
  methodology: string;
}

/** `feeIndex` channel data. */
export interface FeeIndexStreamData extends FeeIndexLatest {
  /** The 16 newest points, newest first, as `GET /v1/index?limit=16` returns them. */
  points: FeeIndexPoint[];
  /**
   * Operator consensus progress: the newest ballot that is not settled (voting, queued, proposed or vetoed); null
   * when none is open or consensus is off. Pushed on every vote.
   */
  ballot: FeeIndexBallotView | null;
}

// ── WS /v1/stream ───────────────────────────────────────────────────────────────────────────────────
/**
 * `slots` and `index:live`: the live Fee Index from the indexer (Solami track, types/Live.types.ts).
 * `predict:panta`: Epoch's Panta markets' prices (types/Panta.types.ts PantaStreamData), polled while subscribed.
 */
export type StreamChannel = 'slot' | 'activity' | 'vault' | 'feeIndex' | 'slots' | 'index:live' | 'predict:panta';
/** A channel with a key, `<topic>:<key>`: `launch:<mint>` (the Launch page's trades and market, plan F13). */
export type StreamTopicChannel = `launch:${string}`;

/** `slot` channel data: MAINNET (the app header, the slot ruler). */
export interface SlotUpdate {
  slot: number;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  /** The slot leader's identity key; null when the leader schedule could not be read. */
  leader: string | null;
  /** The leader's validator name from the validator table; null when unknown (the UI shows the short key). */
  leaderName: string | null;
  /** Pushed by Solami Yellowstone gRPC (`grpc`, each confirmed slot) or read by polling RPC (`rpc`, the fallback). */
  source?: 'grpc' | 'rpc';
}

/** Control messages from the server. */
export type StreamServerMessage =
  | { type: 'hello'; channels: (StreamChannel | string)[] }
  | { type: 'subscribed'; channels: (StreamChannel | StreamTopicChannel)[] }
  | { type: 'pong' }
  | { type: 'error'; message: string; channel?: StreamChannel | StreamTopicChannel };

/** A data frame. `at` is when the server sent it, ISO 8601 in IST. */
export interface StreamFrame<T = unknown> {
  channel: StreamChannel | StreamTopicChannel;
  data: T;
  at: string;
}
