// Mirrored from packages/api_app/src/types/LaunchPage.types.ts (the API's response types; docs/pages/*.md are the contract).
// Keep in sync when the API changes. Units live in field names; null means "not known yet" and renders as "—".

import type { Meta } from './meta';
import type { LaunchDetail, LaunchNetwork, LaunchSummary } from './launch';

/** @epoch/meteora `LaunchTradeQuote` (packages/meteora/src/trade.ts). */
export interface LaunchTradeQuote {
  side: 'buy' | 'sell';
  /** SOL in for a buy, tokens in for a sell. */
  amountIn: number;
  amountOut: number;
  /** amountOut after the slippage the ticket allows (default 1%). */
  minimumOut: number;
  priceImpactPct: number;
  tradingFeeSol: number;
  venue: 'dbc' | 'damm-v2';
}

// The Launch page's live data (plan F13, docs/pages/launch.md): market stats, the trade feed, candles, holders, fees,
// the buy/sell ticket and the first-paint bundle. Every block says when it was read (`asOf`, IST) and whether that is
// older than LAUNCH_STALE_SECONDS (`stale`); nothing cached is presented as live. Words: revenue token, share, term,
// curve, raise, graduate, buyback, burn, backing — never investment, dividend, APY or profit. Implied yield is per
// epoch, never annualised; market cap is fully diluted.


/** When a block was read and whether that is too old to show as live. */
export interface Freshness {
  /** ISO 8601, IST; null when never read. */
  asOf: string | null;
  ageSeconds: number | null;
  stale: boolean;
}

export type LaunchVenue = 'dbc' | 'damm-v2';

/** Where the token trades and what it is worth now. */
export interface LaunchMarket {
  status: LaunchSummary['status'];
  /** dbc on the curve, damm-v2 after graduation, null before the pool exists or while the curve waits to graduate. */
  venue: LaunchVenue | null;
  priceSol: number | null;
  /** priceSol × SOL/USD (Jupiter); null when either is unknown. */
  priceUsd: number | null;
  solUsd: number | null;
  /** Fully diluted: price × (supply − burned). */
  marketCapSol: number | null;
  marketCapUsd: number | null;
  /** The curve's raise: quote reserve vs DBC migrationQuoteThreshold. */
  raise: { targetSol: number; raisedSol: number; progressPct: number; complete: boolean };
  /** SOL in the pool now: the curve's quote reserve, or the DAMM v2 pool's SOL. */
  liquiditySol: number | null;
  /** The live estimate of what the buyback gets each epoch (as `GET /v1/launches`: the mainnet validator table). */
  shareRevenuePerEpochSol: number;
  /** What the curve was priced at: the launch record's 10-epoch average revenue × share (null when not recorded). */
  pricedAtShareRevenuePerEpochSol: number | null;
  /** shareRevenuePerEpochSol ÷ marketCapSol, % PER EPOCH. Never annualised. */
  impliedYieldPctPerEpoch: number | null;
  graduation: {
    /** curve: trading on the curve · complete: the raise is in, migration pending · migrated: DAMM v2 pool live. */
    state: 'upcoming' | 'curve' | 'complete' | 'migrated';
    dammPool: string | null;
    /** Explorer link of the DAMM v2 pool. */
    dammPoolUrl: string | null;
    /** Meteora's page for the pool (mainnet only). */
    meteoraUrl: string | null;
    graduatedEpoch: number | null;
    /** When the curve completed, IST; null before. */
    curveCompletedAt: string | null;
  };
  /** Last 24 hours, from the trade feed. */
  day: { volumeSol: number; trades: number; buys: number; sells: number; priceChangePct: number | null };
  /**
   * Meteora's indexed view of the graduated pool (DAMM v2 data API), in USD: null before graduation, off mainnet or
   * when the API does not answer. Optional here: it lands with the round-3 Meteora branch (feat/r3-meteora).
   */
  indexed?: LaunchIndexedSummary | null;
  freshness: Freshness;
}

/** The graduated pool as Meteora's DAMM v2 data API indexes it (USD values are Meteora's). Round-3 Meteora branch. */
export interface LaunchIndexedSummary {
  source: string;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  /** Liquidity that can never be withdrawn, USD (all of it for an Epoch launch). */
  lockedLiquidityUsd: number;
  /** The indexed pool price, SOL per token (compare `priceSol`, read from the chain). */
  priceSol: number;
  freshness: Freshness;
}

/** One buy or sell, decoded from a DBC or DAMM v2 swap event. */
export interface LaunchTrade {
  /** `<signature>:<ix>` */
  id: string;
  signature: string;
  /** Block time, IST. */
  t: string;
  slot: number;
  venue: LaunchVenue;
  side: 'buy' | 'sell';
  /** The swap's payer: the trader (Epoch's escrow for buybacks). */
  trader: string | null;
  /** SOL paid (buy, fees included) or received (sell, after fees). */
  solAmount: number;
  tokenAmount: number;
  /** Execution price before fees, SOL per token. */
  priceSol: number;
  /** The pool's price after the trade. */
  postPriceSol: number;
  /** Every fee of the swap, in SOL (a fee charged in the token is valued at the trade's price). */
  feeSol: number;
  explorerUrl: string;
}

export interface LaunchTradeList extends Meta {
  network: LaunchNetwork;
  mint: string;
  /** Newest first. */
  trades: LaunchTrade[];
  /** Pass as `before` for the next (older) page; null at the end. */
  nextCursor: string | null;
  ingest: LaunchIngestStatus;
}

export interface LaunchIngestStatus {
  /** The ingester runs in this process (LAUNCH_TRADES_INGEST) — when false, `launch_trades` is filled elsewhere. */
  running: boolean;
  /** The last successful poll of this launch's pools, IST. */
  lastPollAt: string | null;
  stale: boolean;
  /** Pools watched: the curve, and the DAMM v2 pool once graduated. */
  pools: { address: string; venue: LaunchVenue }[];
  /**
   * How new transactions reach the feed: `grpc` (Yellowstone, pushed), `websocket` (the RPC's logsSubscribe, pushed)
   * or `polling` (no realtime source, or it is down). Polling always runs as the backstop.
   */
  mode: 'grpc' | 'websocket' | 'polling';
  /** From the block time of the newest stored trade or fee event to when the API stored it, seconds; null before any. */
  lagSeconds: number | null;
  /** How often the pools are polled now: slower while a realtime source is healthy. Null without an ingester. */
  pollSeconds: number | null;
}

export type LaunchCandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface LaunchCandle {
  /** Bucket start, IST. */
  t: string;
  /** Bucket start, unix seconds (for charting libraries). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  trades: number;
}

export interface LaunchCandles extends Meta {
  network: LaunchNetwork;
  mint: string;
  interval: LaunchCandleInterval;
  /** Oldest first; empty buckets carry the previous close with no volume. */
  candles: LaunchCandle[];
  /** `trades` (decoded swaps), or `samples` (launch_price_samples) when the range has no trades. */
  basis: 'trades' | 'samples' | 'none';
}

export interface LaunchHolder {
  owner: string | null;
  tokenAccount: string;
  amount: number;
  /** Share of the supply now (supply − burned), %. */
  sharePct: number;
  /** "Curve vault", "DAMM v2 pool", "Buyback escrow", "Epoch treasury"…, null for an ordinary holder. */
  label: string | null;
}

export interface LaunchHolders extends Meta {
  network: LaunchNetwork;
  mint: string;
  /** Token accounts with a balance (every account), and without pool vaults, the escrow and the leftover receiver. */
  count: { all: number | null; buyers: number | null };
  /** The 20 largest accounts (getTokenLargestAccounts), largest first. */
  top: LaunchHolder[];
  freshness: Freshness;
}

/** A claim, withdrawal or graduation event from the pools' transactions. */
export interface LaunchFeeEventRow {
  id: string;
  signature: string;
  t: string;
  kind: string;
  owner: string | null;
  solAmount: number;
  tokenAmount: number;
  explorerUrl: string;
}

/** Fees and payouts of a launch, from the pools' on-chain state (exact) and the claim events. */
export interface LaunchFees extends Meta {
  network: LaunchNetwork;
  mint: string;
  /** DBC partner, the fee claimer (Epoch's treasury PDA `["treasury", pool]`): trading fees, surplus, migration fee. */
  partner: {
    address: string | null;
    tradingFeesSol: { accrued: number; claimed: number; unclaimed: number };
    surplusSol: number;
    surplusWithdrawn: boolean;
    migrationFeeSol: number;
    migrationFeeWithdrawn: boolean;
  };
  /** The pool creator (the validator): the 70% migration fee is its upfront SOL. */
  creator: {
    address: string | null;
    migrationFeeSol: number;
    migrationFeeWithdrawn: boolean;
    surplusSol: number;
    surplusWithdrawn: boolean;
    tradingFeesSol: { accrued: number; claimed: number; unclaimed: number };
  };
  /** DAMM v2 positions after graduation: the partner's is 100% permanently locked. */
  lp: {
    positions: {
      position: string;
      owner: string | null;
      role: 'partner' | 'creator' | 'other';
      lockedPct: number;
      claimedSol: number;
      unclaimedSol: number;
      claimedTokens: number;
      unclaimedTokens: number;
    }[];
    claimedSol: number;
    unclaimedSol: number;
  };
  /** The unsold supply after graduation, withdrawable by the leftover receiver (the treasury PDA, which burns it). */
  leftover: {
    receiver: string | null;
    /** The unsold supply DBC holds for the receiver (0 once withdrawn). */
    tokens: number;
    withdrawn: boolean;
    /** The treasury burned it (`burn_leftover`). */
    burned: boolean;
    /** Tokens the treasury burned as leftover (UI units): `/buybacks` `treasury.byKind.leftover.tokensBurned`. */
    burnedTokens: number;
  };
  /**
   * Epoch's partner fees (curve trading fees + surplus + migration fee + the locked LP's fees). The program's
   * permissionless treasury claims move the SOL into the lending pool as income and burn any tokens among them.
   */
  toLenders: {
    /**
     * SOL the treasury claims put in the lending pool: `/buybacks` `treasury.totals.toLendersSol`. For a launch whose
     * fee claimer is a plain wallet (not the treasury PDA), what that wallet claimed.
     */
    claimedSol: number;
    /** Still on Meteora: unclaimed partner trading fees, surplus, migration fee and LP fees. */
    pendingSol: number;
    /** The lending pool's vault `["vault", pool]` where claimed SOL goes (the wallet, for a plain-wallet claimer). */
    holder: string | null;
    note: string;
  };
  /** Claims and withdrawals seen in the pools' transactions, newest first (at most 50). */
  history: LaunchFeeEventRow[];
  freshness: Freshness;
}

/** POST /v1/launches/:mint/quote */
export interface LaunchQuoteResponse extends Meta {
  network: LaunchNetwork;
  mint: string;
  quote: LaunchTradeQuote;
  /** Re-quote after this many seconds: the pool moves. */
  validForSeconds: number;
  warnings: string[];
}

/** POST /v1/launches/:mint/build */
export interface LaunchBuildResponse extends LaunchQuoteResponse {
  /** The unsigned transaction, base64 (legacy wire format): the wallet signs it as fee payer and sends it. */
  transaction: string;
  /** The wallet that must sign: the owner in the request. */
  feePayer: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** For explorer links: `devnet`, or null for mainnet. */
  explorerCluster: string | null;
  /**
   * The most the transaction's priority fee can cost, SOL; the wallet adds the signature fee. Optional here: it lands
   * with the round-3 Meteora branch (feat/r3-meteora).
   */
  priorityFeeSol?: number;
}

/**
 * The revenue token's terms and buyback state: the program's `RevenueToken` (`source: 'program'`) once the validator's
 * operator registered it (`register_revenue_token`), read on the program's cluster with `@epoch/epoch-sdk`; else the
 * launch record's terms (`source: 'registry'`), and the program-only fields are null.
 */
export interface RevenueTokenInfo {
  source: 'program' | 'registry';
  /** The RevenueToken PDA ["revenue_token", vote]; null without a vote account or program id. */
  address: string | null;
  /** The buyback escrow PDA ["buyback", vote]: every sweep's share lands here. */
  buybackEscrow: string | null;
  /** Epoch's treasury PDA ["treasury", pool]: the DBC fee claimer and leftover receiver. */
  treasury: string | null;
  /** true: registered with this mint · false: not registered (or another mint) · null: unknown (no program, read failed). */
  registeredOnChain: boolean | null;
  shareBps: number;
  termEpochs: number;
  /** The first epoch whose sweep pays the share (the epoch after registration). */
  startEpoch: number;
  /** The last epoch whose share is bought back. */
  endEpoch: number;
  registeredEpoch: number | null;
  /** Where buybacks trade: `curve` (DBC) until the program synced the graduation, then `graduated` (DAMM v2). */
  status: 'curve' | 'graduated' | null;
  dammPool: string | null;
  /** The validator's operator, who registered the token. */
  operator: string | null;
  /** Neither commission can go below these during the term (the program's snapshot at registration). */
  commissionFloorBps: { inflation: number; blockRevenue: number } | null;
  /** SOL in the buyback escrow above its rent: waiting for this epoch's buyback slices (or redemptions). */
  escrow: { balanceSol: number; asOf: string } | null;
  buybacks: {
    slicesPerEpoch: number;
    /** Slices run inside the first `windowSlots` slots of each epoch. */
    windowSlots: number;
    maxSlippageBps: number;
    maxImpactBps: number;
    paused: boolean;
    /** Holders can burn tokens for their share of the escrow (after the term, or when the admin allows it). */
    redeemOpen: boolean;
  } | null;
  /** Lifetime totals from the account (tokens in UI units). */
  totals: {
    escrowedSol: number;
    spentSol: number;
    boughtTokens: number;
    burnedTokens: number;
    redeemedTokens: number;
    redeemedSol: number;
    buybacks: number;
  } | null;
  /** Why the program's record is not shown, when it is not. */
  note: string | null;
}

/** GET /v1/launches/:mint/page — everything the page needs for its first paint, in one response. */
export interface LaunchPage extends Meta {
  network: LaunchNetwork;
  launch: LaunchSummary;
  detail: Omit<LaunchDetail, keyof Meta | 'network' | 'launch'>;
  market: LaunchMarket;
  revenueToken: RevenueTokenInfo;
  /** The newest 50 trades. */
  trades: LaunchTrade[];
  /** 15-minute candles over the last 24 hours (fetch /candles for other ranges). */
  candles: { interval: LaunchCandleInterval; basis: LaunchCandles['basis']; candles: LaunchCandle[] };
  holders: Omit<LaunchHolders, keyof Meta | 'network' | 'mint'> | null;
  fees: Omit<LaunchFees, keyof Meta | 'network' | 'mint'> | null;
  ingest: LaunchIngestStatus;
  /** Live updates: subscribe to this WS /v1/stream channel. */
  stream: { channel: string };
  /** Buybacks: GET /v1/launches/:mint/buybacks (docs/pages/launch.md, "Buybacks and burns"). */
  links: { buybacks: string; trades: string; candles: string; holders: string; fees: string };
  /** Parts that could not be read this time (the page shows those blocks as unavailable, not empty). */
  unavailable: string[];
}

/** WS `launch:<mint>` data frames. */
export type LaunchStreamMessage =
  | { type: 'snapshot'; market: LaunchMarket; trades: LaunchTrade[] }
  | { type: 'trade'; trade: LaunchTrade }
  | { type: 'market'; market: LaunchMarket }
  | { type: 'fee'; event: LaunchFeeEventRow };
