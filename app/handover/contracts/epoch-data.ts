// Epoch UI data contracts, schemaVersion 1.
// Copy to app/src/lib/data/types.ts. Every hook in src/lib/data returns one of these types, and every
// fixture in handover/fixtures matches its type exactly (checked by tsc in the kit's dry run).
// Units live in the field name: …Sol (SOL, not lamports), …Pct (0–100), …Share (0–1), …Epoch.
// The backend proposal for each endpoint is in handover/07-DATA-CONTRACTS.md and BACKEND-REQUESTS.md.
// `null` means "not known yet" and renders as "—", never 0. The fields marked nullable below are the ones the
// live API (built 1 Oct for the branch feat/api-network-validators-delegators) can send as null.

/** Every api_app response is wrapped: `{ ok: true, data }` or `{ ok: false, error, traceId }`. `apiGet` unwraps it. */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown }; traceId?: string };

export type DataKind = "real" | "sample" | "demo";

/** Every payload says where it came from. `sample` and `demo` data always render a Sample badge. */
export interface Meta {
  schemaVersion: 1;
  kind: DataKind;
  /** ISO 8601 with offset, or null for sample data. Shown in every number's timestamp tooltip. */
  asOf: string | null;
  source: string;
  note?: string;
}

// ── Network ─────────────────────────────────────────── GET /v1/network · fixtures/network.real.json
export interface NetworkSnapshot extends Meta {
  epoch: {
    number: number;
    slotsInEpoch: number;
    slotIndex: number;
    startSlot: number;
    secondsPerSlot: number;
    hoursPerEpoch: number;
    epochsPerYear: number;
  };
  validators: {
    total: number;
    /** Stopped voting recently: delinquent now but earned vote credits in this or the last epoch. */
    delinquent: number;
    belowBreakEven: number;
    /** null until the delegator scan has finished (a few minutes after the API starts). */
    dependOnOneDelegator: number | null;
    /** null until the API knows the Foundation's withdraw authorities (`FOUNDATION_AUTHORITIES`). */
    dependOnFoundation: number | null;
    /** How many of the largest validators together hold one third of stake (halt risk). */
    superminorityCount: number;
  };
  stake: {
    totalSol: number;
    activatingThisEpochSol: number;
    deactivatingThisEpochSol: number;
    medianApyPct: number;
    topApyPct: number;
  };
  /** null until the delegator scan has finished (a few minutes after the API starts). */
  delegators: {
    wallets: number;
    stakeAccounts: number;
    medianWalletSol: number;
    retail: { wallets: number; sharePct: number };
    midSize: { wallets: number; sharePct: number };
    allocators: { holders: number; sharePct: number };
  } | null;
  blocks: { perDay: number; skipRatePct: number };
  tps: { total: number; user: number; vote: number };
  finalitySeconds: number;
  clients: { agavePct: number; firedancerPct: number; validatorsWithVersion: number };
  breakEvenStakeSol: number;
  voteFeesPerEpochSol: number;
  /** null when the price or FX source is down. */
  price: { solUsd: number | null; usdInr: number | null };
  validatorCountHistory: { date: string; count: number; source: string }[];
}

// ── Stake history ────────────────────── GET /v1/network/stake-history?epochs=64 · stake-history-64.real.json
export interface StakeHistoryRow {
  epoch: number;
  totalActiveSol: number;
  activatingSol: number;
  deactivatingSol: number;
}
export interface StakeHistory extends Omit<Meta, "note"> {
  unit: "SOL";
  rows: StakeHistoryRow[];
}

// ── Validators ──────────────────────────────── GET /v1/validators · validators.real.json (26 of 683 rows)
export interface ValidatorRow {
  name: string;
  vote: string;
  identity: string;
  voteShort: string;
  /** Client family: "Agave" (Jito, BAM and Harmonic builds included), "Firedancer" (Frankendancer included) or "Unknown". */
  client: string;
  country: string;
  /** null when Stakewiz has no row for this validator. */
  apyPct: number | null;
  stakingApyPct: number | null;
  tipsApyPct: number | null;
  commissionPct: number;
  stakeSol: number;
  /** Distinct wallets delegating here; null until the delegator scan has finished. */
  delegators: number | null;
  /** Share of this validator's stake held by its single biggest delegator. Orange over 50. null until the scan has finished. */
  biggestDelegatorSharePct: number | null;
  blocksPerDay: number;
  /** SOL kept per epoch after vote fees (commission + tips + block fees − ≈2.2 SOL). Negative = losing money. */
  healthPerEpochSol: number;
  uptimePct: number | null;
  /** One of the smallest set of validators that together hold one third of stake. */
  top18: boolean;
  /** 0–100: vote credits up to 60, commission up to 25, tenure up to 15; 0 when delinquent; capped at 50 for top-18. */
  epochScore: number;
  /** Active stake for the last 64 epochs, oldest first — for the sparkline column. Not in the fixtures yet (request #5b). */
  stakeHistorySol?: number[];
  /** MEV (Jito tip) commission in %. The score counts the higher of this and commissionPct (request #5b). null: not running Jito. */
  mevCommissionPct?: number | null;
  /** Not voting right now: Offline badge, score 0 (request #5b). */
  delinquent?: boolean;
  /** Commission for the last 10 epochs, oldest first; a raise puts the validator on Watch (request #5b). */
  commissionHistory?: { epoch: number; commissionPct: number }[];
  /** Share of this validator's stake delegated by the Solana Foundation, for a Foundation-backed filter (request #5b). */
  foundationSharePct?: number | null;
  /** The client exactly as gossip reports it (`AgaveBam`, `JitoLabs`, `Frankendancer`…). Sent by the API, not in the fixtures. */
  clientId?: string | null;
  /** ISO 3166 code for the country flag and the country filter (`DE`, `US`). Sent by the API, not in the fixtures. */
  countryCode?: string;
  /**
   * Health computed by the API with the same rules as `src/lib/health.ts`, so the Healthy and Watch tabs filter on the
   * server. Use it when present; compute it with lib/health.ts for fixture rows. Sent by the API, not in the fixtures.
   */
  health?: Health;
  healthReasons?: string[];
}
export interface ValidatorList extends Meta {
  rows: ValidatorRow[];
  /** Rows matching the query ("Showing N of M") and the cursor for "Load 50 more" (request #5b). */
  total?: number;
  nextCursor?: string | null;
  /** Counts for the Filters popover, for the current tab and chips (request #5b). */
  facets?: { client: Record<string, number>; country: Record<string, number> };
}

// ── Top validators ──────────────────────────────────────────── (Terminal tab) top-validators.real.json
export interface TopValidatorRow {
  name: string;
  vote: string;
  stakeSol: number;
  apyPct: number;
  commissionPct: number;
  blocksPerDay: number;
  delegators: number;
  epochScore: number;
}
export interface TopValidators extends Omit<Meta, "note"> {
  rows: TopValidatorRow[];
}

// ── Biggest delegators and retail magnets ─────────── biggest-delegators.real.json · retail-magnets.real.json
export interface BiggestDelegators extends Omit<Meta, "note"> {
  /** `address`: the entity's wallet when it is known, for the Orb link; unlabelled entities stay unclickable (request #6b). */
  rows: { name: string; stakeSol: number; validators: number; kind: string; address?: string | null }[];
}
export interface RetailMagnets extends Meta {
  /** `vote`: the validator's vote account, for the row link (request #6b). */
  rows: { name: string; wallets: number; vote?: string }[];
}

// ── One validator ──────────────────────────────── GET /v1/validators/:vote · validator-ntt-docomo.real.json
export interface StakeMove {
  epoch: number;
  direction: "in" | "out";
  sol: number;
  /** Where the stake came from: a pool, the Foundation, an exchange or "Wallet". */
  from: string;
  wallet: string;
  stakeAccountShort: string;
  stakeAccount: string;
  orb: string;
}
export interface ValidatorProfile extends Omit<Meta, "note"> {
  name: string;
  vote: string;
  identity: string;
  tags: string[];
  gauges: { epochScore: number; voteCreditsPct: number; skippedBlocksPct: number; uptime30dPct: number };
  tiles: {
    activeStakeSol: number;
    stakeChangeThisEpochSol: number;
    apyPct: number;
    stakingApyPct: number;
    tipsApyPct: number;
    delegators: number;
    biggestDelegatorSharePct: number;
    blocksPerDay: number;
  };
  commission: { inflationPct: number; jitoTipsPct: number; unchangedEpochs: number };
  /** [epoch, SOL] */
  stakeByEpoch: [number, number][];
  voteCreditsByEpoch: { max: number; rows: [number, number][] };
  /** [epoch, SOL] */
  jitoTipsTotalByEpochSol: [number, number][];
  revenueEpoch1043Sol: {
    inflationCommission: number;
    tipsCommission: number;
    blockFeesEstimate: number;
    voteFees: number;
    netEstimate: number;
  };
  delegatorSplit: { source: string; pct: number; sol: number }[];
  ifBiggestDelegatorLeftSol: number;
  medianWalletSol: number;
  thisEpoch: { arrivingSol: number; leavingSol: number; netSol: number };
  creditEstimate: {
    sweepablePerEpochSol: number;
    sweepableLast10EpochsSol: number;
    limitUnhedgedSol: number;
    limitHedgedSol: number;
    note: string;
  };
  stakeMoves: StakeMove[];
}

// ── Fee Index ─────────────────────────────── GET /v1/index (EXISTS in packages/api_app) · fee-index.sample.json
/** The live endpoint returns FeeIndexPoint without `status`, newest first; `status` is requested. */
export interface FeeIndexPoint {
  epoch: number;
  /** Stake-weighted median priority fee, micro-lamports per compute unit (µL/CU). */
  value: number;
  /** "vetoed": the admin dropped the proposal inside its dispute window; the epoch waits for a new one (request #3). */
  status?: "final" | "proposed" | "vetoed";
}
export interface FeeIndexSeries extends Meta {
  unit: "µL/CU";
  unitLong: string;
  points: FeeIndexPoint[];
}

// ── Activity feed ─────────────────────────────────────── WS /v1/stream "activity" · activity.sample.json
/** "swap": a Fee Market swap opened or settled (request #19). "buyback": one revenue-token buyback slice (request #22). */
export type ActivityKind = "sweep" | "deposit" | "predict" | "advance" | "index" | "withdraw" | "swap" | "buyback";
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  text: string;
  amountSol: number | null;
  value: number | null;
  /** "points": a Predict call (value = points, amountSol null, no signature: a call is not a transaction). */
  unit: "SOL" | "µL/CU" | "points";
  /** Transaction signature for the explorer link; null in samples. */
  signature: string | null;
}
export interface ActivityFeed extends Meta {
  events: ActivityEvent[];
}

// ── Vault ─────────────────────────────────────────────────── GET /v1/vault · vault.sample.json
export type Tranche = "senior" | "junior";
export interface Advance {
  validator: string;
  /** The validator's vote account, for links to its profile (request #8c). */
  vote?: string;
  hedged: boolean;
  /** 25 unhedged or 40 hedged: the share of 10 epochs' swept revenue the limit allows. */
  limitRatePct: number;
  score: number;
  borrowedSol: number;
  /** Borrowed plus the 2% flat fee. */
  owesSol: number;
  repaidSol: number;
  bondSol: number;
  epochsOpen: number;
  status: "active" | "late" | "repaid" | "recovered" | "defaulted";
  lateEpochs: number | null;
  note: string | null;
}
export interface VaultSnapshot extends Meta {
  pool: {
    tvlSol: number;
    lenders: number;
    liveSinceEpoch: number;
    outstandingPrincipalSol: number;
    utilizationPct: number;
    utilizationCapPct: number;
    lostByLendersSol: number;
    defaults: number;
  };
  tranches: {
    senior: {
      assetsSol: number;
      sharePrice: number;
      /** The senior rate is a TARGET, paid only from real fees. Say "target" in every label. */
      targetBpsPerEpoch: number;
      apyPct: number;
      roomBeforeJuniorMustGrowSol: number;
      couponMetEpochs: number;
      couponEpochsSinceLaunch: number;
    };
    junior: {
      assetsSol: number;
      sharePrice: number;
      apySinceLaunchPct: number;
      sharePctOfVault: number;
      minSharePct: number;
      lockEpochs: number;
      bondsUnderOpenAdvancesSol: number;
    };
  };
  series: {
    epochs: number[];
    seniorSharePrice: number[];
    juniorSharePrice: number[];
    juniorYieldPctPerYear: number[];
    lentOutPct: number[];
  };
  advances: Advance[];
  openAdvancesForStressTest: { validator: string; outstandingPrincipalSol: number; bondSol: number }[];
  withdrawQueue: {
    id: number;
    tranche: Tranche;
    sol: number;
    askedEpoch: number;
    status: "queued" | "paid";
    paidEpoch: number | null;
    /** The request transaction, for the explorer link (Solana Explorer, devnet; decision 24), and whether it belongs to the signed-in wallet (request #8c). */
    signature?: string | null;
    isMine?: boolean;
  }[];
  lenders: {
    label: string | null;
    walletShort: string | null;
    tranche: Tranche;
    sol: number;
    shareOfTranchePct: number;
    sinceEpoch: number;
    untilEpoch: number | null;
  }[];
  /** This epoch's crank cycle for the Terminal's "Epoch cycle" card (request #8c). */
  cycle?: { steps: { key: string; label: string; status: "done" | "running" | "next" }[] };
  /** Read every parameter from the Pool account; never hard-code 20%, 60% or 10 epochs in a component. */
  params: { name: string; display: string; field: string; value: number | null }[];
}

// ── My Stake ────────────────────────────── GET /v1/wallets/:address/stake · my-stake.demo.json
export type Health = "healthy" | "watch" | "offline";
export interface MyStakeAccount {
  validator: string;
  initials: string;
  vote: string;
  stakeAccountShort: string;
  /** The full stake-account pubkey, for the Orb link (request #10b). */
  stakeAccount?: string;
  sinceEpoch: number;
  sol: number;
  apyPct: number;
  stakingApyPct: number;
  tipsApyPct: number;
  commissionPct: number;
  health: Health;
  /** Words, always: a badge never relies on colour alone. */
  healthReasons: string[];
}
export interface MyStake extends Meta {
  wallet: string;
  idleSol: number;
  stakeAccounts: MyStakeAccount[];
  perEpochSol: number;
  monthSol: number;
  yearSol: number;
  lifetimeSol: number;
  blendedApyPct: number;
  suggestions: {
    name: string;
    vote: string | null;
    city: string;
    country: string;
    epochsActive: number;
    apyPct: number;
    delegators: number;
    biggestDelegatorSharePct: number;
    healthPerEpochSol: number;
  }[];
  alerts: { key: string; title: string; description: string }[];
}

// ── Predict ─── points mode (decisions 2 and 3, 1 Oct) · api_app: GET /v1/predict/markets,
//               GET /v1/predict/leaderboard, POST /v1/predict/calls · predict.sample.json
// v1 is points only: Fee Index markets, no SOL, no fee, no wallet transaction (a call needs the sign-in session).
// The Panta / real-SOL path stays behind PREDICT_REAL_SOL (off) until there is legal advice; its SOL fields are
// optional below and never rendered while that flag is off.
export type CallSide = "yes" | "no";
/** A call puts one of these on YES or NO. */
export type CallPoints = 10 | 25 | 50 | 100;
export interface PredictMarket {
  id: string;
  question: string;
  /** 0–1 share of the pool on YES. */
  yesShare: number;
  /** Points on both sides together. */
  poolPoints: number;
  /** Real-SOL path only (PREDICT_REAL_SOL, off). */
  poolSol?: number;
  players: number;
  closesAtEpoch: number;
  status: "open" | "closed" | "settled";
  nowNote: string | null;
  answerSource: string;
}
export interface PredictSnapshot extends Meta {
  rules: {
    /** "points" in v1. "sol" only behind PREDICT_REAL_SOL, after legal advice. */
    mode: "points" | "sol";
    /** Points every signed-in wallet gets each epoch to call with; unused points do not carry over. */
    pointsPerEpoch: number;
    /** 10, 25, 50, 100. */
    callSizesPoints: CallPoints[];
    /** The signed-in wallet's points left this epoch; null when signed out or read-only. */
    pointsLeftThisEpoch: number | null;
    /** 0 in points mode: the losing side's points are shared among the winners, no fee. Real-SOL path: Panta's fee, null until known. */
    feeBps: number | null;
    /** The leaderboard ranks net points won over this many epochs (30). */
    leaderboardEpochs: number;
    ageGate: "18+";
    regions: string;
    /** Real-SOL path only (PREDICT_REAL_SOL, off). */
    capPerCallSol?: number;
    amountChipsSol?: number[];
  };
  payoutFormula: string;
  markets: PredictMarket[];
  myCalls: {
    label: string;
    side: CallSide;
    points: CallPoints;
    /** "refunded": nobody called the winning side, so every call in the market came back (decision 23). */
    status: "open" | "settling" | "won" | "lost" | "refunded";
    /** Open or settling: what the call returns if right, at the current pool. */
    estPayoutPoints: number | null;
    /** Won, lost or refunded: points back minus points called (0 when refunded). Leaderboard only: points won never add
     * to the next epoch's 100 (decision 23). */
    netPoints: number | null;
    /** Real-SOL path only (PREDICT_REAL_SOL, off). */
    amountSol?: number;
    estPayoutSol?: number | null;
    pnlSol?: number | null;
  }[];
  /** GET /v1/predict/leaderboard: net points won over the last `rules.leaderboardEpochs` epochs. */
  leaderboard: { rank: number; walletShort: string; netPoints: number; hitPct: number; calls: number; profitSol?: number }[];
}
/** POST /v1/predict/calls, sent with the sign-in session cookie. No wallet transaction. */
export interface PredictCallRequest {
  marketId: string;
  side: CallSide;
  points: CallPoints;
}

/**
 * Parimutuel payout preview: a = points called, P = pool in points, s = chosen side's share (0–1).
 * No fee in points mode: the losing side's points are shared among the winners in proportion to their calls.
 * 100 points on YES at 62% of a 31,800-point pool → ≈ 161 points (net +61).
 */
export const parimutuelPayout = (a: number, P: number, s: number): number => (a * (P + a)) / (s * P + a);

// ── Operator position (Manage tab) ─────── GET /v1/validators/:vote/position · operator-position.sample.json
export interface OperatorPosition {
  vote: string | null;
  name: string;
  state: "not_onboarded" | "onboarded" | "advance_open" | "defaulted";
  score: number;
  /** Epochs of revenue the escrow has swept so far; credit starts after `creditStartsAfterEpochs`. */
  sweptEpochs: number;
  bondSol: number;
  limit: {
    unhedgedSol: number;
    hedgedSol: number;
    /** Bond needed to unlock the full limit (limit ≤ 4 × bond). */
    bondForFullUnhedgedSol: number;
    bondForFullHedgedSol: number;
    sweepablePerEpochSol: number;
  };
  onboardingSteps: { key: string; title: string; detail: string }[];
  creditStartsAfterEpochs: number;
  advance: null | {
    openedEpoch: number;
    hedged: boolean;
    limitRatePct: number;
    borrowedSol: number;
    feeSol: number;
    owesSol: number;
    repaidSol: number;
    remainingSol: number;
    remitPct: number;
    status: "active" | "late" | "repaid" | "recovered" | "defaulted";
    epochsLeft: number;
    schedule: { epoch: number; remitSol: number; endingSol: number; status: "due" | "upcoming" | "paid" | "late" }[];
    activity: { epoch: number; kind: "advance" | "sweep" | "late" | "repaid"; text: string; amountSol: number; signature: string | null }[];
  };
  covenants: string[];
}
export interface OperatorPositions extends Meta {
  positions: OperatorPosition[];
}

// ── Lender position ───────────── request #8d · GET /v1/wallets/:address/lender (or RPC reads with the IDL)
export interface LenderPosition {
  owner: string;
  tranches: {
    tranche: Tranche;
    shares: number;
    /** shares × share price */
    valueSol: number;
    depositEpoch: number | null;
    /** Junior only: shares can't be withdrawn before this epoch. */
    lockedUntilEpoch: number | null;
  }[];
  withdrawRequests: {
    id: number;
    tranche: Tranche;
    shares: number;
    sol: number;
    askedEpoch: number;
    signature: string | null;
    /**
     * "bounced": the crank cancelled the request at the head of the queue because it would take Junior under
     * `min_junior_bps` (`WithdrawCancelled`, reason 1); the shares are back. Card: "Bounced: Junior floor. Your
     * shares are back." (decision 20, request #8d). Absent = queued.
     */
    status?: "queued" | "bounced";
  }[];
}

// ── Watchlist and alerts (signed in) ───────── requests #14 and #15 · /v1/me/watchlist · /v1/me/alerts
export interface Watchlist {
  /** Vote accounts, at most 200. Signed out, the same list lives in local storage (`epoch.watchlist`). */
  votes: string[];
}
export interface AlertPrefs {
  rules: { offline: boolean; feeUp: boolean; losingMoney: boolean; rewardsLanded: boolean };
  channels: { email?: string | null; telegram?: string | null };
  /** e.g. the step-2 reminder after the first half of a stake move. */
  reminders: { kind: "move-step-2"; epoch: number; stakeAccount: string }[];
}

// ── Fee Market ─── Terminal → Fee Market tab (`/terminal?tab=market`) · request #19 · GET /v1/market
//                  · fee-market.sample.json
// v1 trades against Epoch's seeded market maker at a posted fixed rate per epoch, no order book (ADR 0004).
// The program runs on devnet for now (decision 6). Every rate is a Fee Index level in µL/CU.
/** payFixed: you pay the fixed rate and receive the index, so you gain if fees rise. receiveFixed: the reverse, the
 * validator's hedge (you gain if fees fall). Program enum `Side::PayFixed` / `Side::ReceiveFixed`. */
export type SwapSide = "payFixed" | "receiveFixed";
/** A Fee Index value for one epoch with its status. */
export interface EpochIndexValue {
  value: number;
  status: "proposed" | "final" | "vetoed";
}
export interface FeeQuote {
  /** FeeQuote account, PDA ["quote", maker, epoch le-bytes]. null in samples. */
  address: string | null;
  /** `post_quote` is open to any key; the API lists only Epoch's maker (request #19). */
  maker: string | null;
  /** "Epoch market maker (seeded)" in v1: we disclose that we seed the other side (ADR 0004). */
  makerLabel: string;
  /** The epoch whose final Fee Index settles every swap on this quote. */
  epoch: number;
  /** Fixed index level the maker settles against, µL/CU. */
  fixedRate: number;
  maxNotionalSol: number;
  filledNotionalSol: number;
  /** Payoff clip and collateral rate in bps of notional: 2,000 → both sides post 20% of notional, the most either can lose. */
  maxMoveBps: number;
  /** Trading closes at the first slot of `epoch` or at `expirySlot`, whichever comes first (open_swap checks both). */
  expirySlot: number;
  epochStartSlot: number;
  makerCollateralSol: number;
  lockedCollateralSol: number;
  openSwaps: number;
  /** Every swap opened on this quote, settled ones included. */
  swaps: number;
  /** open: still trading · live: its epoch is running · settling: the epoch is over and some swaps are not settled yet
   * (Settle now works once `index.status` is "final") · settled: every swap settled. */
  status: "open" | "live" | "settling" | "settled";
  /** The quote epoch's Fee Index once proposed; null before. */
  index: EpochIndexValue | null;
  /** Sum of the takers' payoffs once settled, SOL (from SwapSettled events: the maker may close the account). */
  netToTakersSol: number | null;
}
export interface SwapPosition {
  /** SwapPosition account, PDA ["swap", quote, taker]: one per quote per wallet. Closed at settlement. null in samples. */
  address: string | null;
  quote: string | null;
  epoch: number;
  side: SwapSide;
  notionalSol: number;
  fixedRate: number;
  maxMoveBps: number;
  /** Locked on the position until settlement = notional × maxMoveBps ÷ 10,000. */
  collateralSol: number;
  status: FeeQuote["status"];
  /** Its epoch's Fee Index: proposed while settling (payoff is an estimate), final when it can settle. */
  index: EpochIndexValue | null;
  /** Your profit (+) or loss (−) in SOL: final when settled, an estimate from the proposed value while settling. */
  pnlSol: number | null;
  openedSignature: string | null;
  settledSignature: string | null;
}
export interface FeeMarketSnapshot extends Meta {
  network: "devnet" | "mainnet";
  currentEpoch: number;
  index: {
    finalEpoch: number;
    finalValue: number;
    /** The pending proposal and the slot its dispute window ends (then anyone can finalize it). */
    proposed: { epoch: number; value: number; disputeEndsSlot: number } | null;
    /** Average of the last 8 final values, for the "vs average" line. */
    avg8: number;
  };
  /** Newest epoch last: settled and settling quotes, the live one, then the open ones. */
  quotes: FeeQuote[];
  stats: {
    openInterestSol: number;
    openSwaps: number;
    /** Validators the scorer marks hedged this epoch (their limit uses the hedged rate). */
    hedgedValidators: number;
    lastSettled: { epoch: number; swaps: number; notionalSol: number; netToTakersSol: number } | null;
  };
  /** The scorer's rule for the hedged flag (plan F7; request #21). */
  hedgeRule: { epochsAhead: number; minNotionalShareOfRevenuePct: number; text: string };
  /**
   * For a signed-in operator: what the five-epoch hedge needs (FM17). null for everyone else. `minNotionalSol` = half the
   * validator's average revenue per epoch; `epochsToHedge` = open epochs where the wallet holds no swap yet.
   */
  myHedge: {
    vote: string | null;
    name: string;
    averageRevenuePerEpochSol: number;
    minNotionalSol: number;
    hedgedEpochs: number[];
    epochsToHedge: number[];
  } | null;
  /** The signed-in wallet's swaps, open and settled (settled ones come from SwapSettled events). Empty when signed out. */
  myPositions: SwapPosition[];
  recentSwaps: {
    epoch: number;
    side: SwapSide;
    notionalSol: number;
    fixedRate: number;
    /** A validator's name when the taker is a known operator wallet, "You", or a short wallet. */
    who: string;
    /** The validator's vote account when `who` is a validator, for the profile link (FM25). */
    vote: string | null;
    status: FeeQuote["status"];
    pnlSol: number | null;
    signature: string | null;
  }[];
}
/** What the ticket hands to epoch-sdk `openSwap` (instruction `open_swap(notional, side)` on the chosen quote). */
export interface OpenSwapRequest {
  quote: string;
  side: SwapSide;
  notionalSol: number;
}
/** Collateral each side locks: notional × maxMoveBps ÷ 10,000 (also the most you can lose or win). */
export const swapCollateralSol = (notionalSol: number, maxMoveBps: number): number => (notionalSol * maxMoveBps) / 10_000;
/**
 * Your profit or loss in SOL at a final index, the program's formula (`taker_pnl` in instructions/market/swap.rs):
 * notional × (index − fixed) ÷ fixed, sign flipped for receiveFixed, clipped to ± the collateral.
 * 10 SOL receiveFixed at 1,300 with a 20% clip: index 1,170 → +1.0 SOL; 1,430 → −1.0 SOL; 1,000 → +2.0 SOL (clipped).
 */
export const swapPnlSol = (
  side: SwapSide,
  notionalSol: number,
  fixedRate: number,
  indexValue: number,
  maxMoveBps: number,
): number => {
  const raw = (notionalSol * (indexValue - fixedRate)) / fixedRate;
  const signed = side === "payFixed" ? raw : -raw;
  const cap = swapCollateralSol(notionalSol, maxMoveBps);
  return Math.max(-cap, Math.min(cap, signed));
};

// ── Launch ─── `/launch` and `/launch/[mint]` · request #22 · GET /v1/launches, GET /v1/launches/:mint
//              · launches.sample.json, launch-rkest.sample.json
// Validator revenue tokens: a fixed share of a validator's commission for a fixed term, launched on a Meteora
// Dynamic Bonding Curve (Epoch is the partner), graduating to a DAMM v2 pool, bought back at source every epoch
// and burned (ADR 0006, plan F13). Devnet for now (decision 6). Not an offer of anything (decision 22).
export type LaunchStatus = "upcoming" | "curve" | "graduated" | "ended";
export interface LaunchSummary {
  /** The token mint; the page route is /launch/[mint]. null in samples (the sample route uses the symbol). */
  mint: string | null;
  symbol: string;
  name: string;
  validator: { name: string; vote: string | null };
  /** Share of the validator's commission sold, bps. Immutable once registered. */
  shareBps: number;
  termEpochs: number;
  startEpoch: number;
  /** Last epoch whose revenue share is bought back. The validator can't leave Epoch or lower its commission before it. */
  endEpoch: number;
  status: LaunchStatus;
  /** upcoming: the epoch the curve opens. */
  opensAtEpoch: number | null;
  /** The raise on the curve: graduation happens at `targetSol` (DBC migrationQuoteThreshold). */
  raise: { targetSol: number; raisedSol: number; progressPct: number; buyers: number };
  /** null while upcoming. */
  priceSol: number | null;
  /** The curve's price band per token: 60% and 95% of the share's value (shown instead of a price while upcoming). */
  bandLowSol: number;
  bandHighSol: number;
  /** Fully diluted: price × (supply − burned); most of the supply sits in the curve until bought, then in the DAMM v2
   * pool. null while upcoming. */
  marketCapSol: number | null;
  /** 10-epoch average of swept revenue × share: what the buyback gets each epoch, SOL. */
  shareRevenuePerEpochSol: number;
  /** shareRevenuePerEpochSol ÷ marketCapSol, % PER EPOCH. Never annualise it: the cashflow stops at endEpoch. */
  impliedYieldPctPerEpoch: number | null;
  /** Expected buybacks left in the term (share revenue × epochs left) ÷ market cap. */
  backingRatio: number | null;
}
export interface LaunchList extends Meta {
  network: "devnet" | "mainnet";
  launches: LaunchSummary[];
}
export interface LaunchDetail extends Meta {
  network: "devnet" | "mainnet";
  launch: LaunchSummary;
  token: {
    supply: number;
    burned: number;
    holders: number;
    decimals: number;
    /** Fixed supply: no mint authority, immutable metadata (plan F13). */
    mintAuthority: null;
    metadataImmutable: boolean;
  };
  curve: {
    dbcPool: string | null;
    config: string | null;
    /** The curve runs inside 60–95% of the share's value (10-epoch average × share × term ÷ supply), per token. */
    bandLowSol: number;
    bandHighSol: number;
    valuePerTokenSol: number;
    migrationThresholdSol: number;
    /** 70: at graduation the validator gets 70% of the raise as SOL; the rest seeds DAMM v2 with LP locked forever. */
    creatorMigrationFeePct: number;
    lockedLiquidityPct: number;
    dammPool: string | null;
    graduatedEpoch: number | null;
  };
  escrow: {
    address: string | null;
    balanceSol: number;
    /** 12 slices across the first hour of each epoch, each with a min-out (BuybackJob in cranks_app). */
    slicesPerEpoch: number;
    /** "redeem": the fallback when the DAMM v2 buyback isn't ready; holders can also burn tokens for a pro-rata share of
     * the escrow, and trading on the pools goes on (plan F13). */
    mode: "buyback" | "redeem";
  };
  /** DBC partner trading fees claimed by Epoch's treasury PDA for the Senior tranche. */
  partnerFeesToSeniorSol: number;
  /** 70% of the raise, paid at graduation; null before. */
  upfrontToValidatorSol: number | null;
  /** Oldest first. */
  priceSeries: { t: string; epoch: number; priceSol: number }[];
  /** Newest first. */
  buybacks: {
    epoch: number;
    slice: number;
    slices: number;
    solIn: number;
    tokensBurned: number;
    priceSol: number;
    venue: "dbc" | "damm-v2";
    signature: string | null;
  }[];
  risks: string[];
}
/** A buy or sell preview from @epoch/meteora (DBC `swapQuote2` on the curve, the DAMM v2 quote after graduation). */
export interface LaunchTradeQuote {
  side: "buy" | "sell";
  /** SOL in for a buy, tokens in for a sell. */
  amountIn: number;
  amountOut: number;
  /** amountOut after the slippage the ticket allows (default 1%). */
  minimumOut: number;
  priceImpactPct: number;
  tradingFeeSol: number;
  venue: "dbc" | "damm-v2";
}
