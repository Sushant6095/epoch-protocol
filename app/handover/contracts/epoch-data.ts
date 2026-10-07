// Epoch UI data contracts, schemaVersion 1.
// Copy to app/src/lib/data/types.ts. Every hook in src/lib/data returns one of these types, and every
// fixture in handover/fixtures matches its type exactly (checked by tsc in the kit's dry run).
// Units live in the field name: …Sol (SOL, not lamports), …Pct (0–100), …Share (0–1), …Epoch.
// The backend proposal for each endpoint is in handover/07-DATA-CONTRACTS.md and BACKEND-REQUESTS.md.

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
    delinquent: number;
    belowBreakEven: number;
    dependOnOneDelegator: number;
    dependOnFoundation: number;
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
  delegators: {
    wallets: number;
    stakeAccounts: number;
    medianWalletSol: number;
    retail: { wallets: number; sharePct: number };
    midSize: { wallets: number; sharePct: number };
    allocators: { holders: number; sharePct: number };
  };
  blocks: { perDay: number; skipRatePct: number };
  tps: { total: number; user: number; vote: number };
  finalitySeconds: number;
  clients: { agavePct: number; firedancerPct: number; validatorsWithVersion: number };
  breakEvenStakeSol: number;
  voteFeesPerEpochSol: number;
  price: { solUsd: number; usdInr: number };
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
  client: string;
  country: string;
  apyPct: number;
  stakingApyPct: number;
  tipsApyPct: number;
  commissionPct: number;
  stakeSol: number;
  delegators: number;
  /** Share of this validator's stake held by its single biggest delegator. Orange over 50. */
  biggestDelegatorSharePct: number;
  blocksPerDay: number;
  /** SOL kept per epoch after vote fees (commission + tips + block fees − ≈2.2 SOL). Negative = losing money. */
  healthPerEpochSol: number;
  uptimePct: number;
  /** One of the smallest set of validators that together hold one third of stake. */
  top18: boolean;
  /** 0–100: vote credits up to 60, commission up to 25, tenure up to 15; 0 when delinquent; capped at 50 for top-18. */
  epochScore: number;
  /** Active stake for the last 64 epochs, oldest first — for the sparkline column. Not in the fixtures yet (request #5b). */
  stakeHistorySol?: number[];
  /** MEV (Jito tip) commission in %. The score counts the higher of this and commissionPct (request #5b). */
  mevCommissionPct?: number;
  /** Not voting right now: Offline badge, score 0 (request #5b). */
  delinquent?: boolean;
  /** Commission for the last 10 epochs, oldest first; a raise puts the validator on Watch (request #5b). */
  commissionHistory?: { epoch: number; commissionPct: number }[];
  /** Share of this validator's stake delegated by the Solana Foundation, for a Foundation-backed filter (request #5b). */
  foundationSharePct?: number;
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
  status?: "final" | "proposed";
}
export interface FeeIndexSeries extends Meta {
  unit: "µL/CU";
  unitLong: string;
  points: FeeIndexPoint[];
}

// ── Activity feed ─────────────────────────────────────── WS /v1/stream "activity" · activity.sample.json
export type ActivityKind = "sweep" | "deposit" | "predict" | "advance" | "index" | "withdraw";
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  text: string;
  amountSol: number | null;
  value: number | null;
  unit: "SOL" | "µL/CU";
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
    /** The request transaction, for the Orb link, and whether it belongs to the signed-in wallet (request #8c). */
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

// ── Predict ──────────────────────────────── GET /v1/predict/markets (Panta) · predict.sample.json
export type CallSide = "yes" | "no";
export interface PredictMarket {
  id: string;
  question: string;
  /** 0–1 share of the pool on YES. */
  yesShare: number;
  poolSol: number;
  players: number;
  closesAtEpoch: number;
  status: "open" | "closed" | "settled";
  nowNote: string | null;
  answerSource: string;
}
export interface PredictSnapshot extends Meta {
  rules: {
    capPerCallSol: number;
    amountChipsSol: number[];
    /** null until Panta publishes its fee: show "Fee TBD". */
    feeBps: number | null;
    ageGate: "18+";
    regions: string;
  };
  payoutFormula: string;
  markets: PredictMarket[];
  myCalls: {
    label: string;
    side: CallSide;
    amountSol: number;
    status: "open" | "settling" | "won" | "lost";
    estPayoutSol: number | null;
    pnlSol: number | null;
  }[];
  leaderboard: { rank: number; walletShort: string; profitSol: number; hitPct: number; calls: number }[];
}

/**
 * Parimutuel payout preview before fees: a = amount, P = pool, s = chosen side's share (0–1).
 * 1 SOL on YES at 62% of 318 SOL → ≈ 1.61 SOL.
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
  withdrawRequests: { id: number; tranche: Tranche; shares: number; sol: number; askedEpoch: number; signature: string | null }[];
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
