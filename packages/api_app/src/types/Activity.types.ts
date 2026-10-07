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
/** "vetoed": the admin dropped the proposal inside its dispute window; it stays visible until a new one is posted. */
export type FeeIndexStatus = 'final' | 'proposed' | 'vetoed';

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

/** `feeIndex` channel data. */
export interface FeeIndexStreamData extends FeeIndexLatest {
  /** The 16 newest points, newest first, as `GET /v1/index?limit=16` returns them. */
  points: FeeIndexPoint[];
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
