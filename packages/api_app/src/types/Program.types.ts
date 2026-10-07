// Response shapes for the endpoints that read the Epoch program (devnet for now): the Vault, a validator's operator
// position, a wallet's lender position and the Fee Market. Copied from the handover kit's contracts/epoch-data.ts;
// every difference from it is marked "API:" below. Units live in field names: …Sol (SOL, not lamports), …Pct (0–100),
// …Epoch (the PROGRAM cluster's epoch). `null` means "not known yet"; the UI renders it as "—", never as 0.

import { type Meta } from './Api.types';

export type Tranche = 'senior' | 'junior';

/** active/late: open · repaid · recovered: repaid in full after a default · defaulted: written off, being recovered. */
export type AdvanceStatus = 'active' | 'late' | 'repaid' | 'recovered' | 'defaulted';

// ── GET /v1/vault ─────────────────────────────────────────────────────────────────────────────────
export interface Advance {
  validator: string;
  /** The validator's vote account, for links to its profile (request #8c). */
  vote?: string;
  hedged: boolean;
  /** 25 unhedged or 40 hedged: the share of 10 epochs' swept revenue the limit allows. */
  limitRatePct: number;
  score: number;
  borrowedSol: number;
  /** Borrowed plus the flat fee. */
  owesSol: number;
  repaidSol: number;
  bondSol: number;
  epochsOpen: number;
  status: AdvanceStatus;
  lateEpochs: number | null;
  note: string | null;
}

export interface VaultParam {
  name: string;
  display: string;
  /** The PoolParams field in the program (`advance_bps_unhedged / _hedged` for the one pair). */
  field: string;
  /** API: the raw on-chain value, lamports for the `…_lamports` fields and `max_pool_assets` (0 = uncapped); null for the pair. */
  value: number | null;
}

export type CycleStepKey = 'collecting' | 'rewards' | 'sweeps' | 'accrue' | 'withdrawals' | 'index';

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
      /** API: null when the junior floor is off (`min_junior_bps` = 0): senior never waits for junior then. */
      roomBeforeJuniorMustGrowSol: number | null;
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
  /** Oldest first; every array has the same length. */
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
    status: 'queued' | 'paid';
    paidEpoch: number | null;
    /** The request transaction, for the explorer link (Solana Explorer, devnet; decision 24) (request #8c). */
    signature?: string | null;
    /** The request belongs to the signed-in wallet (request #8c). */
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
  cycle?: { steps: { key: CycleStepKey; label: string; status: 'done' | 'running' | 'next' }[] };
  /** Every parameter from the Pool account; never hard-code 20%, 60% or 10 epochs in a component. */
  params: VaultParam[];
}

// ── GET /v1/validators/:vote/position ─────────────────────────────────────────────────────────────
/**
 * The validator's Jito MEV commission per mainnet epoch (GET /v1/validators/:vote/position `mev`), from indexer_app's
 * scan of the mainnet TipDistributionAccounts and claims. Its share reaches the vote account when Jito claims it, a few
 * hours into the next epoch; cranks_app holds that epoch's sweep until the claim lands (ClaimMevJob), so the commission
 * of epoch X is normally swept at epoch X + 1.
 */
export interface PositionMev {
  /** The newest TDA's MEV commission, bps; null when the validator has no TDA in the window. */
  commissionBps: number | null;
  /** The newest mainnet epoch listed. */
  lastEpoch: number | null;
  /**
   * Oldest first: epochs since onboarding when the program runs on mainnet; the last 10 mainnet epochs otherwise
   * (devnet epochs are not mainnet's).
   */
  epochs: {
    epoch: number;
    /** The epoch's tips (root uploaded: `final`), else the tips so far. */
    tipsSol: number | null;
    final: boolean;
    /** The validator's commission: claimed amount, else ⌊tips × bps ÷ 10,000⌋ (`estimated`). */
    validatorShareSol: number | null;
    estimated: boolean | null;
    /** claimed | pending | none (0 % commission, never claimed) | expired */
    claimStatus: 'claimed' | 'pending' | 'none' | 'expired' | null;
    /** The program epoch whose sweep took it in; null when not swept yet or when the program is not on mainnet. */
    sweptIn: number | null;
  }[];
  /**
   * SOL of commission not in the vote account yet (claims still pending), plus, on a mainnet program, commission claimed
   * but not swept yet.
   */
  pendingSol: number;
}

export interface OperatorPosition {
  vote: string | null;
  name: string;
  state: 'not_onboarded' | 'onboarded' | 'advance_open' | 'defaulted';
  score: number;
  /** Epochs of revenue the escrow has swept so far; credit starts after `creditStartsAfterEpochs`. */
  sweptEpochs: number;
  bondSol: number;
  limit: {
    unhedgedSol: number;
    hedgedSol: number;
    /** Bond needed to unlock the full limit (limit ≤ bond_multiplier × bond). */
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
    status: AdvanceStatus;
    epochsLeft: number;
    schedule: { epoch: number; remitSol: number; endingSol: number; status: 'due' | 'upcoming' | 'paid' | 'late' }[];
    activity: {
      epoch: number;
      kind: 'advance' | 'sweep' | 'late' | 'repaid';
      text: string;
      amountSol: number;
      signature: string | null;
    }[];
  };
  covenants: string[];
  /** Jito MEV commission per mainnet epoch (request #5b); null without the MEV scan (no Postgres) or a TDA. */
  mev: PositionMev | null;
  /** Where `score` comes from and what went into it (P1, validator history); null when not onboarded. */
  scoreBreakdown: OperatorScoreBreakdown | null;
}

/** API: the endpoint answers one position with the usual payload fields. */
export interface OperatorPositionSnapshot extends OperatorPosition, Meta {}

/**
 * "history": `refresh_score` computed the score on chain from the validator's ValidatorHistory (permissionless).
 * "scorer": the Pool's scorer key posted it with `update_score`, the fallback without fresh history (its inputs are
 * not on chain, so `inputs` is null).
 */
export interface OperatorScoreBreakdown {
  source: 'history' | 'scorer';
  /** The epoch the score was last written. */
  epoch: number;
  inputs: ScoreBreakdown | null;
  /** The validator's ValidatorHistory; null before `init_validator_history`. Entries: GET /v1/validators/:vote/history. */
  history: { address: string; freshness: HistoryFreshness; lastVoteCopyEpoch: number | null } | null;
}

// ── GET /v1/validators/:vote/history ──────────────────────────────────────────────────────────────
/**
 * "fresh": the history holds a vote-account copy from the current epoch (`update_score` refuses it and the keepers
 * score with `refresh_score`); "stale": the newest copy is from an earlier epoch; "empty": never copied.
 */
export type HistoryFreshness = 'fresh' | 'stale' | 'empty';

/**
 * What filled an entry: "vote" this epoch's vote-account copy (commissions, lamports, revenue, newest vote),
 * "credits" the vote account's 64-epoch credit list, "tip" / "priorityFee" Jito's distribution accounts, "stake" the
 * scorer's `update_stake_info`.
 */
export type HistorySource = 'vote' | 'credits' | 'tip' | 'priorityFee' | 'stake';

/** One epoch of the on-chain history. `null`: the chain has not reported it (the program's all-ones sentinel). */
export interface OnChainHistoryEntry {
  epoch: number;
  /** Vote credits earned in the epoch (so far, for the current one). */
  credits: number | null;
  /** Slots in the epoch × 16: the timely-vote-credit maximum (EpochSchedule). */
  maxCredits: number | null;
  /** credits ÷ maxCredits, %, 2 decimals. */
  creditsOfMaxPct: number | null;
  inflationCommissionPct: number | null;
  /** Block-revenue commission (vote state V4; 100% before V4). */
  blockCommissionPct: number | null;
  /** Jito tip-distribution `validator_commission_bps`. */
  mevCommissionPct: number | null;
  /** Jito priority-fee-distribution `validator_commission_bps` (shown, not scored). */
  priorityFeeCommissionPct: number | null;
  /** The epoch's whole MEV tip pot: tip-distribution `merkle_root.max_total_claim` (set once the root is uploaded). */
  mevEarnedSol: number | null;
  /** Lamports sent to Jito's priority-fee distribution account (a running total until the epoch ends). */
  priorityFeesSol: number | null;
  /** Vote-account balance at the epoch's last copy. */
  voteAccountSol: number | null;
  /** The sweep's rule: the most seen above rent + pending delegator rewards, plus the escrow above rent. */
  revenueSol: number | null;
  /** Oracle (the Pool's scorer). */
  activatedStakeSol: number | null;
  /** Oracle: 1 = the largest stake. */
  stakeRank: number | null;
  /** Oracle. */
  superminority: boolean | null;
  /** The newest vote in the tower at the last copy. */
  lastVotedSlot: number | null;
  /** The slot of the last write from any source. */
  updatedSlot: number | null;
  sources: HistorySource[];
}

/** The inputs and result of one `refresh_score`. Percentages are the program's bps ÷ 100. */
export interface ScoreBreakdown {
  /** 0–100, as `OperatorPosition.score`. */
  score: number;
  /** Credits over the finished-epoch window as a share of the TVC maximum. */
  creditsOfMaxPct: number;
  /** The same against the cluster reference (the formula's input: 100 = the cluster average; may exceed 100). */
  creditsVsClusterPct: number;
  /** The highest of the inflation, MEV and (when counted) block commission over the window and the current epoch. */
  commissionPct: number;
  epochsActive: number;
  /** The newest vote was more than 128 slots behind the copy (or the tower was empty). */
  delinquent: boolean;
  superminority: boolean;
  hedged: boolean;
  /** The receive-fixed notional each of the next 5 epochs needed: 50% of the larger revenue average. */
  hedgeRequiredSol: number;
}

export interface OnChainHistory {
  vote: string;
  name: string;
  /** The ValidatorHistory account, PDA `["history", vote]`. */
  address: string;
  createdEpoch: number;
  /** The program cluster's epoch and slot when read. */
  currentEpoch: number;
  currentSlot: number;
  freshness: {
    status: HistoryFreshness;
    /** The epoch and slot of the newest vote-account copy; null before the first. */
    lastVoteCopyEpoch: number | null;
    lastVoteCopySlot: number | null;
    slotsSinceVoteCopy: number | null;
    /** `refresh_score` accepts a vote copy at most this old (ScoreConfig); null before `configure_scoring`. */
    maxCopyAgeSlots: number | null;
    /** The scorer has posted this epoch's stake, rank and superminority bit. */
    stakeInfoPosted: boolean;
    /** `refresh_score` would accept the history now: fresh, the copy young enough, stake info posted, scoring set. */
    refreshReady: boolean;
  };
  /** The last `refresh_score`; null before the first. */
  lastRefresh: (ScoreBreakdown & { epoch: number; slot: number }) | null;
  /** The Pool's ScoreConfig; null before `configure_scoring`. */
  scoring: {
    creditsWindowEpochs: number;
    /** Share of the TVC maximum that counts as the cluster average. */
    creditsReferencePct: number;
    countBlockCommission: boolean;
    maxCopyAgeSlots: number;
    /** The quotes a hedge must be on; null = nobody counts as hedged. */
    marketMaker: string | null;
  } | null;
  /** Filled epochs, oldest first (at most 64). */
  entries: OnChainHistoryEntry[];
}

/** API: the history with the usual payload fields. */
export interface OnChainHistorySnapshot extends OnChainHistory, Meta {}

// ── GET /v1/wallets/:address/lender ───────────────────────────────────────────────────────────────
export interface LenderPosition {
  owner: string;
  tranches: {
    tranche: Tranche;
    /** UI shares the wallet can still request to withdraw (shares already queued are in `withdrawRequests`). */
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
     * `min_junior_bps` (`WithdrawCancelled`, reason 1); the shares are back (decision 20, request #8d).
     */
    status?: 'queued' | 'bounced';
  }[];
}

/** API: the lender position with the usual payload fields. */
export interface LenderPositionSnapshot extends LenderPosition, Meta {}

// ── GET /v1/market ────────────────────────────────────────────────────────────────────────────────
/** payFixed gains if fees rise; receiveFixed (the validator's hedge) gains if fees fall. */
export type SwapSide = 'payFixed' | 'receiveFixed';
export type QuoteStatus = 'open' | 'live' | 'settling' | 'settled';

/** A Fee Index value for one epoch with its status. */
export interface EpochIndexValue {
  value: number;
  status: 'proposed' | 'final' | 'vetoed';
}

export interface FeeQuote {
  /** FeeQuote account, PDA ["quote", maker, epoch le-bytes]. */
  address: string | null;
  maker: string | null;
  /** "Epoch market maker (seeded)": we disclose that we seed the other side (ADR 0004). */
  makerLabel: string;
  /** The epoch whose final Fee Index settles every swap on this quote. */
  epoch: number;
  /** Fixed index level the maker settles against, µL/CU. */
  fixedRate: number;
  maxNotionalSol: number;
  filledNotionalSol: number;
  /** Payoff clip and collateral rate in bps of notional. */
  maxMoveBps: number;
  /** Trading closes at the first slot of `epoch` or at `expirySlot`, whichever comes first. API: a quote the maker
   * already closed is rebuilt from its events, and `QuotePosted` carries no expiry: it reads `epochStartSlot` then. */
  expirySlot: number;
  epochStartSlot: number;
  makerCollateralSol: number;
  lockedCollateralSol: number;
  openSwaps: number;
  /** Every swap opened on this quote, settled ones included. */
  swaps: number;
  status: QuoteStatus;
  /** The quote epoch's Fee Index once proposed; null before. */
  index: EpochIndexValue | null;
  /** Sum of the takers' payoffs once any swap settled, SOL (from SwapSettled events). */
  netToTakersSol: number | null;
}

export interface SwapPosition {
  /** SwapPosition account, PDA ["swap", quote, taker]: one per quote per wallet. Closed at settlement. */
  address: string | null;
  quote: string | null;
  epoch: number;
  side: SwapSide;
  notionalSol: number;
  fixedRate: number;
  maxMoveBps: number;
  /** Locked on the position until settlement = notional × maxMoveBps ÷ 10,000. */
  collateralSol: number;
  status: QuoteStatus;
  /** Its epoch's Fee Index: proposed while settling (payoff is an estimate), final when it can settle. */
  index: EpochIndexValue | null;
  /** Profit (+) or loss (−) in SOL: final when settled, an estimate from the proposed value while settling. */
  pnlSol: number | null;
  openedSignature: string | null;
  settledSignature: string | null;
}

export interface FeeMarketSnapshot extends Meta {
  /** API: the program cluster as configured (`EPOCH_CLUSTER`); the contract lists devnet and mainnet. */
  network: 'devnet' | 'mainnet' | 'testnet' | 'localnet';
  currentEpoch: number;
  index: {
    /** API: null until the first value is final. */
    finalEpoch: number | null;
    finalValue: number | null;
    /** The pending proposal and the slot its dispute window ends (then anyone can finalize it). */
    proposed: { epoch: number; value: number; disputeEndsSlot: number } | null;
    /** Average of the last 8 final values. API: null until the first value is final. */
    avg8: number | null;
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
  hedgeRule: { epochsAhead: number; minNotionalShareOfRevenuePct: number; text: string };
  /** For a signed-in operator: what the five-epoch hedge needs. null for everyone else. */
  myHedge: {
    vote: string | null;
    name: string;
    averageRevenuePerEpochSol: number;
    minNotionalSol: number;
    hedgedEpochs: number[];
    epochsToHedge: number[];
  } | null;
  /** The signed-in wallet's swaps, open and settled. Empty when signed out. */
  myPositions: SwapPosition[];
  recentSwaps: {
    epoch: number;
    side: SwapSide;
    notionalSol: number;
    fixedRate: number;
    /** A validator's name when the taker is an operator wallet, "You", or a short wallet. */
    who: string;
    /** The validator's vote account when `who` is a validator, for the profile link. */
    vote: string | null;
    status: QuoteStatus;
    pnlSol: number | null;
    signature: string | null;
  }[];
}
