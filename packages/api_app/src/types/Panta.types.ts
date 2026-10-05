// Response shapes for real-money Predict through Panta (USDC on Solana mainnet; decision of 3 Oct 2026) under
// /v1/predict/panta, the WS `predict:panta` channel, and the per-epoch Fee Index that Epoch's Panta markets resolve
// from (GET /v1/index/epochs/:epoch). The page contract is docs/pages/predict.md. Units live in field names; USDC
// amounts are decimal strings (never floats); prices and probabilities are 0–1 numbers.

import type { Meta } from './Api.types';

/**
 * Every Panta-derived payload says who powers it and how fresh it is (Panta Terms of Use §5, §6, §8): show
 * "Powered by Panta" (linked to `poweredByUrl`) wherever it appears, and label `stale` data "delayed", never "live".
 */
export interface PantaMeta extends Omit<Meta, 'note'> {
  poweredBy: 'Panta';
  poweredByUrl: 'https://panta.market';
  /** When Panta answered (IST). A cached answer keeps the time of its original read. */
  asOf: string;
  /** Seconds since `asOf`. */
  ageSeconds: number;
  /** True when served from cache past its freshness window because Panta could not be read. */
  stale: boolean;
  note?: string;
}

/** Can this visitor trade, and if not, why (the Real tab's banner). */
export interface PantaAccess {
  /** Trading routes answer: PANTA_TRADING_ENABLED and an API key on the server. */
  tradingEnabled: boolean;
  /** The visitor's country (from the trusted proxy header) is on PANTA_BLOCKED_COUNTRIES: browse only. */
  geoBlocked: boolean;
  /** ISO 3166-1 alpha-2, or null when the API is not behind a geo proxy. */
  country: string | null;
  /** Why trading is off (for the banner); null when it is on. */
  reason: string | null;
  minTradeUsdc: string;
  maxTradeUsdc: string;
  /** build, submit and claim need the SIWS sign-in session of the trading wallet. */
  signInRequired: true;
  network: 'solana-mainnet';
  currency: 'USDC';
}

export type PantaSide = 'yes' | 'no';

/** A Panta market as a card. Prices are 0–1 (USDC per share); null until a detail read has them. */
export interface PantaMarketCard {
  marketId: string;
  title: string;
  description: string | null;
  category: string | null;
  /** primary (bonding-curve buys) | secondary | resolved | cancelled. */
  phase: string;
  status: string | null;
  imageUrl: string | null;
  yesPrice: number | null;
  noPrice: number | null;
  volumeUsdc: string | null;
  /** ISO 8601 (IST). */
  startsAt: string | null;
  /** Trading closes. */
  endsAt: string | null;
  resolvesAt: string | null;
  resolved: boolean;
  /** One of Epoch's Fee Index markets. */
  ours: boolean;
  /** Buys are open: phase `primary` and before `endsAt`. */
  tradable: boolean;
}

/** Informational only: what the market implies next to what the index's own history says. Never advice. */
export interface FeeIndexIntelligence {
  label: 'informational';
  note: string;
  /** The market's YES price (0–1), when live. */
  impliedProbability: number | null;
  /** Share of the last `model.sample` finished epochs whose value was strictly above the threshold (0–1). */
  modelProbability: number | null;
  model: { method: string; lookbackEpochs: number; above: number; sample: number };
  /** (implied − model) × 100, percentage points; null when either side is missing. */
  gapPct: number | null;
  index: {
    unit: 'µL/CU';
    /** The newest final value (or computed value when the program has none). */
    last: { epoch: number; value: number; status: 'final' | 'computed' } | null;
    /** The running epoch so far: median of slot medians, unofficial (not the stake-weighted index). */
    running: { epoch: number; value: number; slots: number } | null;
  };
}

/** One of Epoch's Panta markets: "Will the Solana Fee Index for epoch N close above X µL/CU?". */
export interface PantaFeeIndexMarket extends PantaMarketCard {
  ours: true;
  /** Solana mainnet epoch. */
  epoch: number;
  thresholdMicroLamports: number;
  question: string;
  resolutionRule: string;
  sourcesOfTruth: string[];
  /** GET /v1/index/epochs/:epoch: where the market resolves from. */
  resolutionUrl: string;
  /** When the prices on this card were read (IST); null when Panta has not answered yet. */
  pricesAsOf: string | null;
  pricesStale: boolean;
  intelligence: FeeIndexIntelligence;
}

/** GET /v1/predict/panta/markets?category=&status=&q=&cursor=&limit= */
export interface PantaMarketsPage extends PantaMeta {
  access: PantaAccess;
  /** Epoch's Fee Index markets, newest epoch first. */
  ours: PantaFeeIndexMarket[];
  /** The rest of Panta's public catalog. `q` searches titles and descriptions of the first pages only. */
  discover: {
    items: PantaMarketCard[];
    nextCursor: string | null;
    category: string | null;
    q: string | null;
    /** With `q`: how many catalog markets were searched. */
    searched: number | null;
  };
}

/** One row of a market's public tape. */
export interface PantaTapeRow {
  walletShort: string;
  side: PantaSide | 'both';
  yesShares: string;
  noShares: string;
  feeUsdc: string;
  isPrimary: boolean;
  /** ISO 8601 (IST). */
  at: string | null;
  signature: string;
}

/** GET /v1/predict/panta/markets/:marketId */
export interface PantaMarketDetail extends PantaMeta {
  access: PantaAccess;
  market: PantaMarketCard | PantaFeeIndexMarket;
  /** Newest first, at most 50. */
  trades: PantaTapeRow[];
}

/** GET /v1/predict/panta/categories */
export interface PantaCategoriesView extends PantaMeta {
  categories: string[];
}

/** POST /v1/predict/panta/quote { wallet, marketId, side, amountUsdc } */
export interface PantaQuoteView extends PantaMeta {
  /** ~90 s: build before `expiresAt`. */
  quoteId: string;
  marketId: string;
  side: PantaSide;
  amountUsdc: string;
  feeUsdc: string;
  shares: string;
  avgPrice: string;
  expiresAt: string;
  /** What the shares pay if the side wins (1 USDC per share). */
  payoutIfWinUsdc: string;
  summary: string;
}

/** What the wallet is asked to sign, as words and fields (also stored as the consent record). */
export interface PantaReview {
  action: 'buy' | 'claim';
  marketId: string;
  market: string;
  side: PantaSide | null;
  amountUsdc: string | null;
  feeUsdc: string | null;
  expectedShares: string | null;
  maxSlippageBps: number | null;
  wallet: string;
  network: 'solana-mainnet';
}

/** POST /v1/predict/panta/build and POST /v1/predict/panta/claim/build */
export interface PantaBuildView extends PantaMeta {
  /** Epoch's handle for submit and status. */
  tradeId: string;
  action: 'buy' | 'claim';
  /** Base64 unsigned VersionedTransaction (v0): sign it with the wallet, unchanged. */
  transaction: string;
  recentBlockhash: string;
  /** The transaction cannot land after this block height (~60 s). */
  lastValidBlockHeight: number;
  /** Panta's order session (buys): submit within ~120 s. */
  orderId: string | null;
  expiresAt: string | null;
  summary: string;
  review: PantaReview;
}

export type PantaTradeState = 'built' | 'submitted' | 'confirmed' | 'failed' | 'expired';
export type PantaAttributionState = 'pending' | 'processed' | 'failed';

/** POST /v1/predict/panta/submit { tradeId, signedTransaction | signature } */
export interface PantaSubmitView extends PantaMeta {
  tradeId: string;
  signature: string;
  status: PantaTradeState;
  /** Who sent it to the network: Epoch's RPC (`signedTransaction`) or the wallet (`signature`). */
  broadcastBy: 'epoch' | 'wallet';
  explorerUrl: string;
}

/** GET /v1/predict/panta/status/:tradeId */
export interface PantaTradeStatusView extends PantaMeta {
  tradeId: string;
  action: 'buy' | 'claim';
  status: PantaTradeState;
  signature: string | null;
  explorerUrl: string | null;
  marketId: string;
  side: PantaSide | null;
  amountUsdc: string | null;
  /** Panta's order status for a buy (built | submitted | confirmed | failed | expired), when read. */
  orderStatus: string | null;
  /** Reported to Panta for attribution (POST /trades/): every confirmed trade through Epoch is. */
  attribution: PantaAttributionState;
}

export interface PantaPositionView {
  marketId: string;
  title: string | null;
  ours: boolean;
  side: PantaSide;
  shares: string;
  phase: string;
  claimable: boolean;
  claimed: boolean;
  outcome: PantaSide | null;
  /** Spot price of this side (0–1) while open; null otherwise or unknown. */
  price: number | null;
  /** shares × price while open; shares × 1 when won; 0 when lost. Display only. */
  estValueUsdc: string | null;
  state: 'open' | 'claimable' | 'won' | 'lost' | 'claimed' | 'cancelled';
}

/** GET /v1/predict/panta/positions?wallet= */
export interface PantaPositionsView extends PantaMeta {
  wallet: string;
  positions: PantaPositionView[];
  claimableCount: number;
}

/** GET /v1/predict/panta/stats: traction evidence. */
export interface PantaStatsView extends PantaMeta {
  /** From Epoch's own records (panta_trades, panta_markets). */
  epoch: {
    trades: number;
    buys: number;
    claims: number;
    uniqueWallets: number;
    volumeUsdc: string;
    /** Trades Panta has credited to Epoch (POST /trades/ processed). */
    attributedTrades: number;
    pendingAttribution: number;
    marketsCreated: number;
    marketsLive: number;
    creationFeesPaidUsdc: string;
    creatorFeesClaimedUsdc: string;
    firstTradeAt: string | null;
    lastTradeAt: string | null;
  };
  /** From Panta's account metrics; null when Panta could not be read. */
  panta: {
    attributedTrades: number;
    attributedVolumeUsdc: string;
    byKind: Record<string, number>;
    creates: { total: number; byStatus: Record<string, number> };
  } | null;
}

/** WS `predict:panta` channel data: Epoch's Fee Index markets' prices, pushed every 15 s or so while subscribed. */
export interface PantaStreamData {
  poweredBy: 'Panta';
  asOf: string;
  stale: boolean;
  markets: {
    marketId: string;
    epoch: number;
    thresholdMicroLamports: number;
    phase: string;
    yesPrice: number | null;
    noPrice: number | null;
    impliedProbability: number | null;
    modelProbability: number | null;
    volumeUsdc: string | null;
  }[];
}

// ── GET /v1/index/epochs/:epoch ─────────────────────────────────────────────────────────────────────

/**
 * pending: no value yet (the epoch is running, or the indexer has not computed it). computed: the indexer's value,
 * not posted on chain yet. proposed: posted, inside the on-chain dispute window. final: past the window without a
 * veto (what markets resolve from). vetoed: the posted value was vetoed; a corrected one may follow.
 */
export type FeeIndexEpochStatus = 'pending' | 'computed' | 'proposed' | 'final' | 'vetoed';

/** The Solana Fee Index of one MAINNET epoch and how settled it is: the resolution source of Epoch's Panta markets. */
export interface FeeIndexEpochView extends Meta {
  /** Solana mainnet epoch. */
  epoch: number;
  /** µL/CU: the program's value when posted (final, proposed or vetoed), else the computed one; null when pending. */
  value: number | null;
  status: FeeIndexEpochStatus;
  final: boolean;
  unit: 'µL/CU';
  /** The indexer's computed value (epoch_index), for comparison. */
  computedValue: number | null;
  /** Where the value lives on chain; null without the Epoch program. */
  onChain: {
    cluster: string;
    programId: string;
    feeIndexAccount: string;
    /** The program epoch the value was posted under (the mainnet epoch when the program runs on mainnet). */
    programEpoch: number | null;
    postSignature: string | null;
  } | null;
  methodology: string;
}
