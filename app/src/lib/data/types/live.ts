// Mirrored from packages/api_app/src/types/Live.types.ts (the API's response types; docs/pages/*.md are the contract).
// Keep in sync when the API changes. Units live in field names; null means "not known yet" and renders as "—".

import type { Meta } from './meta';
// /v1/live and the WS `slots` / `index:live` channels: the Solana Fee Index computed live from mainnet blocks streamed
// through Solami (the Terminal's Live page). Prices are µL/CU (micro-lamports per compute unit). Times are IST.
// `live: false` means the indexer has not processed a slot within LIVE_STALE_AFTER_SECONDS: the data is the last
// known state (see `asOf`), never to be shown as live.


export type LiveSource = 'grpc' | 'hybrid' | 'rpc';
export type LiveStreamStatus = 'streaming' | 'connecting' | 'reconnecting' | 'polling' | 'stopped' | 'offline';

/** One block (GET /v1/live/slots, WS `slots`). */
export interface LiveSlot {
  slot: number;
  epoch: number;
  /** The slot leader's identity. */
  leader: string;
  leaderName: string | null;
  /** Median over priced, non-leader-paid transactions (the slot's Fee Index input); null when there were none. */
  medianCuPrice: number | null;
  p25CuPrice: number | null;
  p75CuPrice: number | null;
  p90CuPrice: number | null;
  /** Transactions in the median. */
  pricedTxs: number;
  /** Non-vote transactions that set no priority fee (left out). */
  unpricedTxs: number;
  /** Paid by the leader itself (always left out). */
  leaderPaidTxs: number;
  /** Failed on chain, among the priced ones (they paid, so they count). */
  failedTxs: number;
  /** Block time, ISO 8601 IST; null when the block had none. */
  time: string | null;
  /** grpc | hybrid | rpc | gap-fill */
  source: string;
}

/** The running Fee Index of the epoch in progress (summary.estimate, WS `index:live`). */
export interface LiveEstimate {
  epoch: number;
  /** Stake-weighted median of per-leader medians so far; null before the first priced slot of a staked leader. */
  value: number | null;
  /** Staked leaders with at least one priced slot. */
  leaders: number;
  slotsWithFees: number;
  pricedTxs: number;
  /** First slot of the epoch the estimate covers (later than the epoch start when indexing began mid-epoch). */
  coverageFromSlot: number | null;
  /** Share of the epoch's slots so far that the estimate covers, 0–100. */
  coveragePct: number | null;
  /** The epoch whose stake snapshot weights it. */
  stakeEpoch: number | null;
  /** True in RPC sampling mode (one slot in N): a demo figure, never a final value. */
  sampled: boolean;
}

export interface LiveStream {
  source: LiveSource | null;
  /** solami | rpc-fast | an RPC host */
  endpoint: string | null;
  /** `offline` when the indexer has not written anything for LIVE_STALE_AFTER_SECONDS. */
  status: LiveStreamStatus;
  lastSlotAt: string | null;
  secondsSinceLastSlot: number | null;
  /** The indexer's last heartbeat. */
  indexerSeenAt: string | null;
  /** Slots processed live but not yet contiguous (gap fill or backfill in progress). */
  gapSlots: number;
  catchingUp: boolean;
}

/** GET /v1/live/summary */
export interface LiveSummary extends Meta {
  live: boolean;
  /** Human label for the data path, e.g. "Solami gRPC (Yellowstone)". */
  dataSource: string;
  stream: LiveStream;
  /** Mainnet tip: the indexer's stream (when live) or the API's own RPC read, whichever is newer. */
  tipSlot: number | null;
  /** Newest slot the indexer processed from its live source. */
  processedSlot: number | null;
  lagSlots: number | null;
  /** lagSlots × 0.4 s. */
  lagSeconds: number | null;
  epoch: { number: number; firstSlot: number; slotIndex: number; slotsInEpoch: number; progressPct: number } | null;
  estimate: LiveEstimate | null;
  /** The newest finished epoch with a computed value (epoch_index). */
  lastFinal: { epoch: number; value: number; postedSignature: string | null; computedAt: string } | null;
  unit: 'µL/CU';
}

/** GET /v1/live/slots */
export interface LiveSlots extends Meta {
  live: boolean;
  /** Newest first. */
  slots: LiveSlot[];
}

export interface LiveLeader {
  /** By stake, 1 = most. */
  rank: number;
  identity: string;
  name: string | null;
  /** Slots with priced transactions this epoch. */
  slots: number;
  /** Median of the leader's slot medians. */
  medianCuPrice: number;
  pricedTxs: number;
  /** Null when the leader is not in the stake snapshot (it then weighs nothing). */
  stakeSol: number | null;
  /** Share of the listed leaders' stake, 0–100. */
  weightPct: number;
  /** This leader's median is the index (the stake-weighted median). */
  setsIndex: boolean;
}

/** GET /v1/live/leaders?epoch= */
export interface LiveLeaders extends Meta {
  live: boolean;
  epoch: number;
  /** epoch_index holds this epoch's value (it is finished and was fully indexed). */
  final: boolean;
  /** The final value, else the stake-weighted median of what is indexed so far. */
  value: number | null;
  setter: string | null;
  stakeEpoch: number | null;
  totalStakeSol: number;
  /** By stake, largest first (at most `limit`). */
  leaders: LiveLeader[];
  /** Leaders with priced slots in the epoch (before `limit`). */
  leaderCount: number;
  unit: 'µL/CU';
}

/** GET /v1/live/epochs/:epoch/distribution */
export interface FeeDistribution extends Meta {
  live: boolean;
  epoch: number;
  final: boolean;
  /** Slots with priced transactions. */
  slots: number;
  /** Slot medians in log-spaced buckets, 4 per decade: [fromCuPrice, toCuPrice). Empty buckets inside the range are kept. */
  buckets: { fromCuPrice: number; toCuPrice: number; slots: number }[];
  /** Percentiles of the slot medians (nearest rank). */
  percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number } | null;
  /** The epoch's index for the marker: final value, else the live estimate (current epoch), else null. */
  indexValue: number | null;
  unit: 'µL/CU';
}

// ── GET /v1/live/solami: what Epoch uses of Solami, per component, for judges ─────────────────────────

/** A component's gRPC stream (indexer_app: the firehose or block meta; api_app: slots and program transactions). */
export interface SolamiGrpcUsage {
  component: string;
  /** firehose | meta | slots | slots+program */
  subscription: string | null;
  /** solami | rpc-fast */
  endpoint: string | null;
  /** connecting | streaming | reconnecting | stopped | off (no key: RPC polling) | offline (the component is not reporting) */
  status: string;
  compression: string | null;
  /** Protobuf bytes received (after any decompression). */
  bytes: number;
  updates: number;
  reconnects: number;
  /** ISO 8601 IST. */
  lastUpdateAt: string | null;
  /** Slots behind the tip (indexer_app). */
  lagSlots: number | null;
}

export interface SolamiRpcMethod {
  method: string;
  calls: number;
  errors: number;
  rateLimited: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** A component's RPC calls to one host (a key in the URL is never kept). */
export interface SolamiRpcUsage {
  component: string;
  host: string;
  /** A *.solami.dev host. Others (public RPC fallbacks) are listed for honesty. */
  solami: boolean;
  calls: number;
  errors: number;
  rateLimited: number;
  p50Ms: number | null;
  p95Ms: number | null;
  methods: SolamiRpcMethod[];
}

/** A sender's Beam use (publisher_app post_index, cranks_app sends). */
export interface SolamiBeamUsage {
  component: string;
  sends: number;
  /** Confirmed without an error. */
  landed: number;
  failed: number;
  /** Sent the normal way because no tip address could be read. */
  fallbacks: number;
  tipLamports: number | null;
  /** Tips of landed transactions. */
  tipsSpentLamports: number;
  tipsSpentSol: number;
  /** api (live list) | pinned (Solami SDK's list, during an API outage) */
  tipSource: string | null;
  lastSignature: string | null;
  /** ISO 8601 IST. */
  lastLandedAt: string | null;
}

export interface SolamiComponent {
  /** indexer | api | publisher | cranks */
  name: string;
  /** When its counters were last written (api: now). ISO 8601 IST. */
  updatedAt: string;
  /** Counters older than SOLAMI_USAGE_STALE_SECONDS: the component is not running (or not reporting). */
  stale: boolean;
  /** When the process started. ISO 8601 IST. */
  startedAt: string;
}

/** GET /v1/live/solami. Counters are since each process started. */
export interface SolamiUsageResponse extends Meta {
  /** Solami products in use right now (fresh components only): grpc, rpc, beam. */
  inUse: string[];
  components: SolamiComponent[];
  grpc: SolamiGrpcUsage[];
  rpc: SolamiRpcUsage[];
  beam: SolamiBeamUsage[];
  /** Sums over every component's Beam use. */
  beamTotals: { sends: number; landed: number; failed: number; tipsSpentLamports: number; tipsSpentSol: number };
  lastError: { component: string; product: string; message: string; at: string } | null;
}
