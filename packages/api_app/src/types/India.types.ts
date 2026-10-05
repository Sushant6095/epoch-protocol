// Response shapes for the India page (Superteam India track), mounted at /v1/india. The page contract with example
// responses and states is docs/pages/india.md. Rupee amounts come as `Rupees`: the number and its Indian-format
// strings. Dates are IST. `null` means "not known"; the page shows "—", never 0.

import { type HealthStatus, type Meta } from './Api.types';

/** A rupee amount: `{ inr: 12345678.9, formatted: '₹1,23,45,678.90', compact: '₹1.23 Cr' }`. */
export interface Rupees {
  /** Rounded to paise; null when unknown (no price for that day). */
  inr: number | null;
  /** Indian grouping, two decimals: `₹1,23,45,678.90`; `—` when unknown. */
  formatted: string;
  /** Headline form: `₹1.23 Cr` from a crore, `₹45.60 L` from a lakh, else whole rupees; `—` when unknown. */
  compact: string;
}

/** The live price as other India payloads quote it. */
export interface IndiaPriceBrief {
  inr: number;
  formatted: string;
  change24hPct: number | null;
  source: string;
  /** When the source set the price (IST). */
  asOf: string;
  stale: boolean;
  staleReason: string | null;
}

// ── GET /v1/india/price ───────────────────────────────────────────────────────────────────────────
export interface IndiaPrice extends Meta {
  pair: 'SOL/INR';
  /** Rupees per SOL. */
  inr: number;
  formatted: string;
  usd: number | null;
  /** Rupees per dollar behind the quote. */
  usdInr: number | null;
  change24hPct: number | null;
  /** When the source set the price (IST); same as `asOf`. */
  observedAt: string;
  /** When Epoch read it (IST). */
  fetchedAt: string;
  ageSeconds: number;
  /** True when this is the last known price, not a live one (sources down or standing still). */
  stale: boolean;
  staleReason: string | null;
  /** The price is re-read at most this often. */
  refreshSeconds: number;
  /** `?days=N`: CoinGecko's daily price (00:00 UTC = 05:30 IST), oldest first; empty without `days`. */
  history: { date: string; at: string; inr: number }[];
}

// ── Financial year ─────────────────────────────────────────────────────────────────────────────────
export interface IndiaFinancialYear {
  /** `2026-27` (the `?fy=` value). */
  label: string;
  /** `FY 2026-27` */
  name: string;
  /** `AY 2027-28`: the assessment year that taxes it. */
  assessmentYear: string;
  /** `2026-04-01T00:00:00+05:30` */
  startsAt: string;
  /** `2027-03-31T23:59:59+05:30` */
  endsAt: string;
  current: boolean;
}

// ── Validators hosted in India ─────────────────────────────────────────────────────────────────────
export type IndiaCountryData = 'available' | 'unknown';

export interface IndiaValidatorRevenue {
  /** The last finished epoch. */
  epoch: number;
  /** When it ended (IST); null when the epoch calendar is unavailable. */
  endedAt: string | null;
  /** `validator-profile`: the profile's figures (vote-account rewards, Jito Kobe); `table-estimate`: from rates. */
  basis: 'validator-profile' | 'table-estimate';
  sol: {
    inflationCommission: number;
    tipsCommission: number;
    blockFeesEstimate: number;
    /** Negative. */
    voteFees: number;
    net: number;
  };
  netInr: Rupees;
  /** The SOL/INR price used: the day the epoch ended, else the live price. */
  priceInr: number | null;
  priceSource: string | null;
}

export interface IndiaCreditEstimate {
  /** Always an estimate: the planned Pool parameters on revenue the escrow would sweep; not an offer. */
  estimate: true;
  basis: 'validator-profile' | 'table-estimate';
  sweepablePerEpochSol: number;
  sweepableLast10EpochsSol: number;
  limitUnhedgedSol: number;
  limitHedgedSol: number;
  /** At the live price. */
  limitUnhedgedInr: Rupees;
  limitHedgedInr: Rupees;
  note: string;
}

export interface IndiaValidatorRow {
  name: string;
  vote: string;
  identity: string;
  voteShort: string;
  /** `ip-geolocation`: Stakewiz places its node in India; `listed`: operator-declared (INDIA_VALIDATOR_VOTES). */
  inIndiaBy: 'ip-geolocation' | 'listed';
  /** Stakewiz IP geolocation; `Unknown` when it has none. */
  city: string;
  country: string;
  countryCode: string;
  /** The hosting organisation (Stakewiz `ip_org`). */
  hostingOrg: string | null;
  client: 'Agave' | 'Firedancer' | 'Unknown';
  stakeSol: number;
  stakeValueInr: Rupees;
  commissionPct: number;
  mevCommissionPct: number | null;
  apyPct: number | null;
  stakingApyPct: number | null;
  tipsApyPct: number | null;
  epochScore: number;
  health: HealthStatus;
  healthReasons: string[];
  delinquent: boolean;
  uptimePct: number | null;
  delegators: number | null;
  top18: boolean;
  revenue: IndiaValidatorRevenue;
  credit: IndiaCreditEstimate;
}

export interface IndiaShare {
  /** `unknown`: Stakewiz has no country data right now, so India's figures are null (not zero). */
  countryData: IndiaCountryData;
  /** Validators placed in India (geolocated or listed); null when unknown. */
  validators: number | null;
  /** Of those, validators only on the operator-declared list. */
  listed: number;
  stakeSol: number | null;
  stakeValueInr: Rupees;
  /** Share of all active stake, %. */
  stakeSharePct: number | null;
  /** Share of all validators with stake, %. */
  validatorSharePct: number | null;
  /** India's rank by stake among countries hosting validators; null when it hosts none (or unknown). */
  rank: number | null;
  countriesWithValidators: number;
}

export interface IndiaCity {
  city: string;
  validators: number;
  stakeSol: number;
  /** Share of India's stake, %. */
  sharePct: number;
}

export interface CountryShare {
  countryCode: string;
  country: string;
  validators: number;
  stakeSol: number;
  stakeSharePct: number;
  validatorSharePct: number;
  /** By stake among countries with known location; null for India with no validators. */
  rank: number | null;
}

export interface IndiaComparison {
  /** The ten countries with the most stake. */
  top: CountryShare[];
  india: CountryShare;
  /** Hubs near India: Singapore, the UAE, Hong Kong, Japan. */
  peers: CountryShare[];
  /** Validators Stakewiz could not place. */
  unknown: { validators: number; stakeSol: number };
}

/** What a new validator hosted in India could earn and borrow, at today's network rates. An estimate. */
export interface IndiaProspect {
  note: string;
  assumptions: {
    commissionPct: number;
    mevCommissionPct: number;
    /** Median Jito tips APY of voting validators. */
    tipsApyPct: number;
    epochsPerMonth: number;
    advanceBpsUnhedged: number;
    advanceBpsHedged: number;
    revenueWindowEpochs: number;
  };
  /** Stake at which a validator charging the median commission covers its vote fees. */
  breakEvenStakeSol: number;
  tiers: {
    stakeSol: number;
    /** Net of vote fees. */
    revenuePerEpochSol: number;
    revenuePerMonthSol: number;
    revenuePerMonthInr: Rupees;
    creditLimitUnhedgedSol: number;
    creditLimitHedgedSol: number;
    creditLimitUnhedgedInr: Rupees;
    creditLimitHedgedInr: Rupees;
  }[];
}

/** `ok`: at least one Indian validator; `empty`: none hosted in India; `unknown`: no country data right now. */
export type IndiaValidatorsStatus = 'ok' | 'empty' | 'unknown';

// ── GET /v1/india/validators ──────────────────────────────────────────────────────────────────────
export interface IndiaValidatorList extends Meta {
  status: IndiaValidatorsStatus;
  rows: IndiaValidatorRow[];
  /** Rows matching the query, before paging. */
  total: number;
  nextCursor: string | null;
  facets: { client: Record<string, number>; country: Record<string, number> };
  india: IndiaShare;
  cities: IndiaCity[];
  price: IndiaPriceBrief | null;
}

// ── GET /v1/india/summary ─────────────────────────────────────────────────────────────────────────
export interface IndiaSummary extends Meta {
  price: IndiaPriceBrief | null;
  fy: IndiaFinancialYear;
  network: { epoch: number; validators: number; stakeSol: number; stakeValueInr: Rupees } | null;
  validators: {
    status: IndiaValidatorsStatus;
    india: IndiaShare;
    cities: IndiaCity[];
    /** The five largest Indian validators. */
    top: IndiaValidatorRow[];
    comparison: IndiaComparison;
  } | null;
  prospect: IndiaProspect | null;
  /** What failed, by section, when a section is null. */
  errors: { price?: string; validators?: string };
  disclaimer: string;
}

// ── GET /v1/india/wallets/:address/rewards ────────────────────────────────────────────────────────
/** `loading`: nothing read yet · `partial`: still reading · `complete` · `incomplete`: done, some epochs unreadable. */
export type IndiaRewardsStatus = 'loading' | 'partial' | 'complete' | 'incomplete';
/** `accounts`: finding the wallet's stake accounts and the year's epochs · `rewards`: reading epochs · `done`. */
export type IndiaRewardsStage = 'accounts' | 'rewards' | 'done';

export interface IndiaRewardEpoch {
  epoch: number;
  /** When the epoch ended and its reward was credited (IST ISO). */
  endedAt: string;
  /** `2026-10-02` (IST) */
  date: string;
  rewardSol: number;
  /** SOL/INR used: the daily price nearest the epoch's end. */
  priceInr: number | null;
  /** `2026-10-02` (IST) of that daily price. */
  priceDate: string | null;
  priceSource: string | null;
  rewardInr: Rupees;
}

export interface IndiaRewardMonth {
  /** `2026-04` (IST) */
  month: string;
  /** `Apr 2026` */
  label: string;
  rewardSol: number;
  rewardInr: Rupees;
  epochs: number;
}

export interface IndiaWalletRewards extends Meta {
  wallet: string;
  fy: IndiaFinancialYear;
  /** The `?fy=` values accepted, newest first: the current year back to 2020-21. */
  availableFys: string[];
  status: IndiaRewardsStatus;
  stage: IndiaRewardsStage;
  /** Poll again after this many seconds while `loading` or `partial`; null when done. */
  retryAfterSeconds: number | null;
  coverage: {
    /** Finished epochs that ended in the year (so far, for the current year). */
    epochsInYear: number;
    epochsRead: number;
    epochsPending: number;
    epochsFailed: number;
    failedEpochs: number[];
    firstEpoch: number | null;
    lastEpoch: number | null;
    /** Stake accounts read (the 100 largest delegated ones of the wallet, as staker or withdrawer). */
    stakeAccounts: number;
  };
  totals: {
    rewardSol: number;
    /** Each epoch at its own day's price; null when no epoch had a price. */
    rewardInr: Rupees;
    /** The same SOL at today's live price. */
    valueTodayInr: Rupees;
    epochsWithRewards: number;
    epochsWithoutPrice: number;
  };
  /** The year's twelve months (IST), April first; months not reached yet are left out. */
  months: IndiaRewardMonth[];
  /** Epochs with a reward, oldest first. */
  epochs: IndiaRewardEpoch[];
  livePrice: IndiaPriceBrief | null;
  /** The CSV of this year: same rows, UTF-8 with a BOM. */
  csvPath: string;
  disclaimer: string;
}
