// Response shapes for one validator (GET /v1/validators/:vote) and one wallet's stake (GET /v1/wallets/:address/stake),
// from the handover kit's contracts/epoch-data.ts (`ValidatorProfile`, `StakeMove`, `MyStake`, `MyStakeAccount`).
// Differences from the kit, each marked "(API)" below: `revenueEpoch1043Sol` is `revenueLastEpochSol` + `revenueEpoch`;
// figures a third party may not have are nullable; `note`, `MyStakeAccount.status` and `MyStake.rewardsByEpoch` are
// added.

import { type HealthStatus, type Meta } from './Api.types';

// ── GET /v1/validators/:vote ──────────────────────────────────────────────────────────────────────
export interface StakeMove {
  epoch: number;
  direction: 'in' | 'out';
  sol: number;
  /** Where the stake came from: a pool, the Foundation, an exchange or "Wallet". */
  from: string;
  /** The withdraw authority, short (`4ZJh…kbPY`). */
  wallet: string;
  stakeAccountShort: string;
  stakeAccount: string;
  /** `https://orbmarkets.io/address/<stake account>` */
  orb: string;
}

export interface ValidatorRevenue {
  /** The vote account's inflation reward for the epoch (`getInflationReward`): its commission share. */
  inflationCommission: number;
  /** Jito tips × MEV commission (Jito Kobe); 0 when not running Jito. */
  tipsCommission: number;
  /** Blocks per epoch at this epoch's rate × the average fee per block from recent blocks. */
  blockFeesEstimate: number;
  /** Negative: slots per epoch × 5,000 lamports. */
  voteFees: number;
  netEstimate: number;
}

/**
 * The validator's commission node in an epoch's Jito tip distribution: `claimed` (ClaimStatus on mainnet), `pending`
 * (commission > 0, not claimed yet: claims land a few hours after the epoch ends), `none` (0 % commission: the node is 0
 * and is never claimed; about half of Jito validators, 317 of 635 in epoch 1050), `expired` (closed unclaimed).
 */
export type MevClaimStatus = 'claimed' | 'pending' | 'none' | 'expired';

/** One epoch of a validator's Jito MEV (GET /v1/validators/:vote `mevHistory`). */
export interface MevHistoryRow {
  epoch: number;
  /** `chain`: indexer_app's scan of the mainnet TipDistributionAccount; `kobe`: Jito Kobe (older epochs, no claims). */
  source: 'chain' | 'kobe';
  /** MEV commission in bps (0–10,000); null for a chain row with only a priority-fee distribution account. */
  commissionBps: number | null;
  /**
   * SOL: the epoch's tips from its merkle root when `final`; before the root is uploaded, the tips so far (the TDA's
   * balance less its rent-exempt minimum as read from the RPC: 1,503,680 lamports in Oct 2026, never hardcoded).
   */
  tipsSol: number | null;
  /** The merkle root is uploaded: `tipsSol` is the epoch's total. */
  final: boolean;
  /** The validator's commission, SOL: the claimed amount, else ⌊tips × bps ÷ 10,000⌋ with `estimated: true`. */
  validatorShareSol: number | null;
  estimated: boolean | null;
  claimStatus: MevClaimStatus | null;
  /** Slot of the claim (chain rows). */
  claimedSlot: number | null;
  /** Priority-fee distribution (Jito's block-reward sharing) where the validator has one; null for almost everyone. */
  pfCommissionBps: number | null;
  pfTransferredSol: number | null;
  /** The priority-fee distribution's validator node: claimed | pending | none (a 0 node); null without one. */
  pfClaimStatus: MevClaimStatus | null;
}

export interface ValidatorProfile extends Meta {
  name: string;
  vote: string;
  identity: string;
  /** Client and version, city and country, host, Jito fee, Foundation-backed, epochs active, Top-18. */
  tags: string[];
  gauges: {
    epochScore: number;
    /** Credits in the last finished epoch ÷ `voteCreditsByEpoch.max` × 100; (API) null before a first finished epoch. */
    voteCreditsPct: number | null;
    /** (API) null when the validator had no leader slot this epoch and Stakewiz has no figure. */
    skippedBlocksPct: number | null;
    /** (API) null when Stakewiz has no row for this validator. */
    uptime30dPct: number | null;
  };
  tiles: {
    activeStakeSol: number;
    /** Arriving minus leaving this epoch (stake accounts activating / deactivating now). */
    stakeChangeThisEpochSol: number;
    /** (API) null when Stakewiz has no row for this validator. */
    apyPct: number | null;
    stakingApyPct: number | null;
    tipsApyPct: number | null;
    /** Distinct withdraw authorities delegating here, from this validator's stake accounts (read per request). */
    delegators: number;
    biggestDelegatorSharePct: number;
    blocksPerDay: number;
  };
  commission: {
    inflationPct: number;
    /** (API) null when the validator does not run Jito. */
    jitoTipsPct: number | null;
    /** Epochs since the inflation or MEV commission last changed; null when no history answered. */
    unchangedEpochs: number | null;
  };
  /** [epoch, SOL], oldest first, ending with the current epoch; up to 64 epochs. */
  stakeByEpoch: [number, number][];
  /** Finished epochs, oldest first; `max` = slots in an epoch × 16 (timely vote credits). */
  voteCreditsByEpoch: { max: number; rows: [number, number][] };
  /** [epoch, SOL] Jito tips the validator's stake earned per finished epoch, oldest first; up to 64 epochs. */
  jitoTipsTotalByEpochSol: [number, number][];
  /** Jito MEV per epoch, oldest first: mainnet TDAs and claims (last 20 epochs), Jito Kobe before that. */
  mevHistory: MevHistoryRow[];
  /** (API) the last finished epoch (the kit's fixture called this `revenueEpoch1043Sol`). */
  revenueEpoch: number;
  revenueLastEpochSol: ValidatorRevenue;
  /** Foundation, liquid-staking pools, other named wallets, then "N other wallets". */
  delegatorSplit: { source: string; pct: number; sol: number }[];
  ifBiggestDelegatorLeftSol: number;
  medianWalletSol: number;
  /** Stake accounts activating (arriving) and deactivating (leaving) this epoch. */
  thisEpoch: { arrivingSol: number; leavingSol: number; netSol: number };
  creditEstimate: {
    /** Inflation commission + tips commission in the last finished epoch. */
    sweepablePerEpochSol: number;
    /** The same summed over the last 10 finished epochs. */
    sweepableLast10EpochsSol: number;
    limitUnhedgedSol: number;
    limitHedgedSol: number;
    note: string;
  };
  /** Stake accounts that started or stopped delegating in this or the last epoch, newest first, at most 50. */
  stakeMoves: StakeMove[];
}

// ── GET /v1/wallets/:address/stake ────────────────────────────────────────────────────────────────
/**
 * (API) activating: delegated this epoch, earns from the next · active · deactivating: still earns this epoch,
 * withdrawable from the next · inactive: cooled down, earns nothing until delegated again or withdrawn.
 */
export type StakeAccountStatus = 'activating' | 'active' | 'deactivating' | 'inactive';

export interface MyStakeAccount {
  validator: string;
  initials: string;
  vote: string;
  stakeAccountShort: string;
  /** The full stake-account pubkey, for the Orb link (request #10b). */
  stakeAccount: string;
  status: StakeAccountStatus;
  /** Activation epoch (0 for genesis stake). */
  sinceEpoch: number;
  /** Delegated stake; for an inactive account, its whole balance (what a withdrawal returns). */
  sol: number;
  /** (API) null when Stakewiz has no row for the validator. */
  apyPct: number | null;
  stakingApyPct: number | null;
  tipsApyPct: number | null;
  /** (API) null when the vote account is not in getVoteAccounts any more. */
  commissionPct: number | null;
  health: HealthStatus;
  /** Words, always: a badge never relies on colour alone. */
  healthReasons: string[];
}

export interface MyStakeSuggestion {
  name: string;
  vote: string | null;
  /** Stakewiz IP geolocation; '' when unknown. */
  city: string;
  /** ISO 3166 code; '' when unknown. */
  country: string;
  /** (API) null when Stakewiz has no first epoch with stake. */
  epochsActive: number | null;
  apyPct: number;
  /** (API) null until the delegator scan has finished (the delegator checks are then skipped). */
  delegators: number | null;
  biggestDelegatorSharePct: number | null;
  healthPerEpochSol: number;
}

export interface MyStake extends Meta {
  wallet: string;
  /** The wallet's own SOL plus undelegated stake accounts: SOL that is not staked. */
  idleSol: number;
  stakeAccounts: MyStakeAccount[];
  /** (API) the reward fields are null when getInflationReward did not answer. */
  perEpochSol: number | null;
  monthSol: number | null;
  yearSol: number | null;
  /** Sum of the epochs in `rewardsByEpoch` only (see `note`). */
  lifetimeSol: number | null;
  /** Stake-weighted APY of the active and activating accounts; null without stake. */
  blendedApyPct: number | null;
  /** (API) rewards per finished epoch, oldest first: the rewards chart. */
  rewardsByEpoch: { epoch: number; sol: number }[];
  suggestions: MyStakeSuggestion[];
  alerts: { key: string; title: string; description: string }[];
}
