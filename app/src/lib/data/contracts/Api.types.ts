// Response shapes for the Epoch app. They mirror the frontend contract (app/src/lib/data/types.ts, from the
// handover kit's contracts/epoch-data.ts). Units live in field names: …Sol (SOL, not lamports), …Pct (0–100),
// …Epoch. `null` means "not known yet"; the UI renders it as "—", never as 0.

export interface FeeIndexPoint {
  epoch: number;
  /** Stake-weighted median priority fee, micro-lamports per compute unit. */
  value: number;
}

export type DataKind = 'real' | 'sample' | 'demo';

/** Every payload says where it came from and when. */
export interface Meta {
  schemaVersion: 1;
  kind: DataKind;
  /** ISO 8601 in IST, e.g. `2026-10-01T14:05:00+05:30`. */
  asOf: string;
  source: string;
  note?: string;
}

// ── GET /v1/network ───────────────────────────────────────────────────────────────────────────────
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
    /** Stopped voting recently: delinquent now but earned credits in this or the last epoch. */
    delinquent: number;
    belowBreakEven: number;
    /** Validators whose single biggest delegator holds over 50% of their stake (needs the delegator scan). */
    dependOnOneDelegator: number | null;
    /** Validators with over half their stake from Foundation authorities (needs FOUNDATION_AUTHORITIES). */
    dependOnFoundation: number | null;
    superminorityCount: number;
  };
  stake: {
    totalSol: number;
    activatingThisEpochSol: number;
    deactivatingThisEpochSol: number;
    medianApyPct: number;
    topApyPct: number;
  };
  /** Null until the first delegator scan finishes (a few minutes after the API starts). */
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
  price: { solUsd: number | null; usdInr: number | null };
  validatorCountHistory: { date: string; count: number; source: string }[];
}

// ── GET /v1/network/stake-history ─────────────────────────────────────────────────────────────────
export interface StakeHistoryRow {
  epoch: number;
  totalActiveSol: number;
  activatingSol: number;
  deactivatingSol: number;
}
export interface StakeHistory extends Omit<Meta, 'note'> {
  unit: 'SOL';
  /** Oldest first, ending with the last finished epoch. */
  rows: StakeHistoryRow[];
}

// ── GET /v1/validators ────────────────────────────────────────────────────────────────────────────
export type HealthStatus = 'healthy' | 'watch' | 'offline';

export interface ValidatorRow {
  name: string;
  vote: string;
  identity: string;
  voteShort: string;
  /** Client family: Agave (incl. Jito, BAM, Harmonic Agave…) or Firedancer (incl. Frankendancer…). */
  client: 'Agave' | 'Firedancer' | 'Unknown';
  /** The client as gossip reports it, e.g. `AgaveBam`, `JitoLabs`, `Frankendancer`. */
  clientId: string | null;
  country: string;
  countryCode: string;
  apyPct: number | null;
  stakingApyPct: number | null;
  tipsApyPct: number | null;
  commissionPct: number;
  stakeSol: number;
  /** Distinct wallets delegating here (null until the delegator scan finishes). */
  delegators: number | null;
  biggestDelegatorSharePct: number | null;
  blocksPerDay: number;
  /** SOL kept per epoch after vote fees: inflation commission + MEV commission + block fees − vote fees. */
  healthPerEpochSol: number;
  uptimePct: number | null;
  top18: boolean;
  /** 0–100, the program's formula. 0 when delinquent; at most 50 in the superminority. */
  epochScore: number;
  mevCommissionPct: number | null;
  delinquent: boolean;
  foundationSharePct: number | null;
  /** Server-side health, same rules as the app's lib/health.ts, so tabs filter on the server. */
  health: HealthStatus;
  healthReasons: string[];
  /** Inflation commission for the last 10 epochs, oldest first (validator history; absent without Postgres). */
  commissionHistory?: { epoch: number; commissionPct: number }[];
  /** Active stake for up to 64 epochs, oldest first (validator history; absent without Postgres). */
  stakeHistorySol?: number[];
}

export interface ValidatorList extends Meta {
  rows: ValidatorRow[];
  /** Rows matching the query, before paging. */
  total: number;
  nextCursor: string | null;
  /** Counts for the Filters popover: current tab, chips and search, before the popover's own filters. */
  facets: { client: Record<string, number>; country: Record<string, number> };
}

// ── GET /v1/delegators/biggest · GET /v1/delegators/retail-magnets ─────────────────────────────────
export interface BiggestDelegatorRow {
  name: string;
  stakeSol: number;
  validators: number;
  /** `Liquid staking`, `Foundation`, `Exchange`, `Wallet`… */
  kind: string;
  /** The wallet (withdraw authority) when the entity is one address; null for groups. */
  address: string | null;
}
export interface BiggestDelegators extends Omit<Meta, 'note'> {
  rows: BiggestDelegatorRow[];
}

export interface RetailMagnetRow {
  name: string;
  /** Wallets holding under 1,000 SOL in total that delegate to this validator. */
  wallets: number;
  vote: string;
}
export interface RetailMagnets extends Meta {
  rows: RetailMagnetRow[];
}
