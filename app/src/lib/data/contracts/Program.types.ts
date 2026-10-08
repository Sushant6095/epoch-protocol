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
}

/** API: the endpoint answers one position with the usual payload fields. */
export interface OperatorPositionSnapshot extends OperatorPosition, Meta {}

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
