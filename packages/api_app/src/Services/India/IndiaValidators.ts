import { Logger } from '@epoch/logger';

import { mapLimit } from '../../Lib/Async';
import { rupees } from '../../Lib/Inr';
import { SnapshotCache } from '../../Lib/SnapshotCache';
import { isoIst, median, round } from '../../Lib/Stats';
import { type StakewizValidator } from '../../Sources/ExternalSources';
import { type ValidatorRow } from '../../types/Api.types';
import {
  type CountryShare,
  type IndiaCity,
  type IndiaComparison,
  type IndiaCreditEstimate,
  type IndiaPriceBrief,
  type IndiaProspect,
  type IndiaShare,
  type IndiaValidatorRevenue,
  type IndiaValidatorRow,
  type IndiaValidatorsStatus,
  type Rupees,
} from '../../types/India.types';
import { type ValidatorProfile } from '../../types/Wallet.types';
import { CREDIT_PARAMS, creditEstimate } from '../Validator/ValidatorProfileBuilder';
import { type ValidatorTableData } from '../ValidatorTable';
import { type EpochCalendar } from './EpochCalendar';
import { type InrPriceService, type LivePrice } from './InrPriceService';

const logger = Logger.create('IndiaValidators');

export const INDIA = 'IN';
/** Hosting hubs near India, for the comparison. */
export const PEER_COUNTRIES = ['SG', 'AE', 'HK', 'JP'] as const;
/** "Start a validator in India" stake sizes: below, near and well above break-even (about 100,000 SOL, Oct 2026). */
export const PROSPECT_STAKES_SOL = [50_000, 150_000, 500_000] as const;
/** The prospect's fees: 5% keeps the Epoch Score's full commission points. */
const PROSPECT_COMMISSION_PCT = 5;
const PROSPECT_MEV_COMMISSION_PCT = 5;
const UNKNOWN_CITY = 'Unknown';
const MINUTE = 60_000;

type TableFigures = Pick<
  ValidatorTableData,
  | 'grossYieldPerEpoch'
  | 'epochsPerYear'
  | 'hoursPerEpoch'
  | 'feePerBlockSol'
  | 'voteFeesPerEpochSol'
  | 'totalStakeSol'
  | 'medianCommissionBps'
  | 'epoch'
  | 'blocks'
  | 'rows'
>;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
/** Shorter than the runtime's names (`Hong Kong SAR China`). */
const SHORT_NAMES: Record<string, string> = { HK: 'Hong Kong', MO: 'Macao' };

/** `India` for `IN`; the Stakewiz spelling when the runtime has no name; `Unknown` for `XX`. */
export function countryName(code: string, fallback: string): string {
  if (code === 'XX') return 'Unknown';
  if (SHORT_NAMES[code]) return SHORT_NAMES[code];
  try {
    const name = regionNames.of(code);
    return name && name !== code ? name : fallback;
  } catch {
    return fallback;
  }
}

const pct = (part: number, whole: number, decimals = 2): number =>
  whole > 0 ? round((part / whole) * 100, decimals) : 0;

/** Every country hosting validators with stake, by stake (ranked), and the validators Stakewiz could not place. */
export function countryShares(rows: readonly ValidatorRow[]): {
  shares: CountryShare[];
  unknown: { validators: number; stakeSol: number };
} {
  const totalStake = rows.reduce((s, r) => s + r.stakeSol, 0);
  const groups = new Map<string, { name: string; validators: number; stakeSol: number }>();
  let unknownValidators = 0;
  let unknownStake = 0;
  for (const row of rows) {
    if (row.countryCode === 'XX') {
      unknownValidators += 1;
      unknownStake += row.stakeSol;
      continue;
    }
    const group = groups.get(row.countryCode) ?? { name: row.country, validators: 0, stakeSol: 0 };
    group.validators += 1;
    group.stakeSol += row.stakeSol;
    groups.set(row.countryCode, group);
  }
  const shares = [...groups.entries()]
    .sort((a, b) => b[1].stakeSol - a[1].stakeSol)
    .map(([code, g], index) => ({
      countryCode: code,
      country: countryName(code, g.name),
      validators: g.validators,
      stakeSol: Math.round(g.stakeSol),
      stakeSharePct: pct(g.stakeSol, totalStake, 3),
      validatorSharePct: pct(g.validators, rows.length),
      rank: index + 1,
    }));
  return { shares, unknown: { validators: unknownValidators, stakeSol: Math.round(unknownStake) } };
}

/** The top ten, India (rank null when it hosts none) and the nearby hubs. */
export function comparison(rows: readonly ValidatorRow[]): IndiaComparison {
  const { shares, unknown } = countryShares(rows);
  const byCode = new Map(shares.map((s) => [s.countryCode, s]));
  const empty = (code: string): CountryShare => ({
    countryCode: code,
    country: countryName(code, code),
    validators: 0,
    stakeSol: 0,
    stakeSharePct: 0,
    validatorSharePct: 0,
    rank: null,
  });
  return {
    top: shares.slice(0, 10),
    india: byCode.get(INDIA) ?? empty(INDIA),
    peers: PEER_COUNTRIES.map((code) => byCode.get(code) ?? empty(code)),
    unknown,
  };
}

/** Validators on the India page: hosted in India by Stakewiz's IP geolocation, then operator-declared ones. */
export function indianRows(
  rows: readonly ValidatorRow[],
  listed: ReadonlySet<string>,
): { row: ValidatorRow; by: IndiaValidatorRow['inIndiaBy'] }[] {
  const out: { row: ValidatorRow; by: IndiaValidatorRow['inIndiaBy'] }[] = [];
  for (const row of rows) {
    if (row.countryCode === INDIA) out.push({ row, by: 'ip-geolocation' });
    else if (listed.has(row.vote)) out.push({ row, by: 'listed' });
  }
  return out;
}

/** India's validators and stake by hosting city (geolocated ones only), largest first. */
export function cityBreakdown(
  rows: readonly ValidatorRow[],
  stakewiz: ReadonlyMap<string, StakewizValidator>,
): IndiaCity[] {
  const total = rows.reduce((s, r) => s + r.stakeSol, 0);
  const cities = new Map<string, { validators: number; stakeSol: number }>();
  for (const row of rows) {
    const city = stakewiz.get(row.vote)?.ip_city?.trim() || UNKNOWN_CITY;
    const entry = cities.get(city) ?? { validators: 0, stakeSol: 0 };
    entry.validators += 1;
    entry.stakeSol += row.stakeSol;
    cities.set(city, entry);
  }
  return [...cities.entries()]
    .map(([city, c]) => ({
      city,
      validators: c.validators,
      stakeSol: Math.round(c.stakeSol),
      sharePct: pct(c.stakeSol, total, 1),
    }))
    .sort((a, b) => b.stakeSol - a.stakeSol || a.city.localeCompare(b.city));
}

/** India's share of validators and stake by IP geolocation; nulls when the table has no country data. */
export function indiaShare(
  rows: readonly ValidatorRow[],
  countryData: IndiaShare['countryData'],
  listedOnly: number,
  priceInr: number | null,
): IndiaShare {
  const { shares } = countryShares(rows);
  if (countryData === 'unknown') {
    return {
      countryData,
      validators: null,
      listed: listedOnly,
      stakeSol: null,
      stakeValueInr: rupees(null),
      stakeSharePct: null,
      validatorSharePct: null,
      rank: null,
      countriesWithValidators: 0,
    };
  }
  const india = shares.find((s) => s.countryCode === INDIA);
  const stakeSol = india?.stakeSol ?? 0;
  return {
    countryData,
    validators: india?.validators ?? 0,
    listed: listedOnly,
    stakeSol,
    stakeValueInr: rupees(priceInr === null ? null : stakeSol * priceInr),
    stakeSharePct: india?.stakeSharePct ?? 0,
    validatorSharePct: india?.validatorSharePct ?? 0,
    rank: india?.rank ?? null,
    countriesWithValidators: shares.length,
  };
}

/** The rates behind a row's revenue, as ValidatorTable computes "SOL kept per epoch". */
function tableRates(row: ValidatorRow, t: TableFigures): { inflation: number; tips: number; blockFees: number } {
  const inflation = row.stakeSol * t.grossYieldPerEpoch * (row.commissionPct / 100);
  const mevBps = row.mevCommissionPct === null ? null : row.mevCommissionPct * 100;
  const tipsToStakers = t.epochsPerYear > 0 ? (row.stakeSol * ((row.tipsApyPct ?? 0) / 100)) / t.epochsPerYear : 0;
  const tips = mevBps !== null && mevBps < 10_000 ? (tipsToStakers * mevBps) / (10_000 - mevBps) : 0;
  const blockFees = row.blocksPerDay * (t.hoursPerEpoch / 24) * t.feePerBlockSol;
  return { inflation, tips, blockFees };
}

const fromRevenue = (r: ValidatorProfile['revenueLastEpochSol']): IndiaValidatorRevenue['sol'] => ({
  inflationCommission: r.inflationCommission,
  tipsCommission: r.tipsCommission,
  blockFeesEstimate: r.blockFeesEstimate,
  voteFees: r.voteFees,
  net: r.netEstimate,
});

/**
 * Revenue in the last finished epoch and the credit estimate: the validator profile's figures when it answered (vote
 * account rewards, Jito Kobe tips; the same numbers as the profile page), else estimated from the table's rates.
 */
export function revenueAndCredit(input: {
  row: ValidatorRow;
  table: TableFigures;
  profile: ValidatorProfile | null;
  endedAtMs: number | null;
  /** SOL/INR on the day the epoch ended, else null. */
  epochPrice: { inr: number; source: string } | null;
  live: LivePrice | null;
}): { revenue: IndiaValidatorRevenue; credit: IndiaCreditEstimate } {
  const { row, table: t, profile, live } = input;
  const lastEpoch = t.epoch.epoch - 1;
  let sol: IndiaValidatorRevenue['sol'];
  let credit: ValidatorProfile['creditEstimate'];
  let epoch = lastEpoch;
  const basis = profile ? 'validator-profile' : 'table-estimate';
  if (profile) {
    sol = fromRevenue(profile.revenueLastEpochSol);
    credit = profile.creditEstimate;
    epoch = profile.revenueEpoch;
  } else {
    const r = tableRates(row, t);
    sol = {
      inflationCommission: round(r.inflation, 4),
      tipsCommission: round(r.tips, 4),
      blockFeesEstimate: round(r.blockFees, 4),
      voteFees: -round(t.voteFeesPerEpochSol, 4),
      net: round(r.inflation + r.tips + r.blockFees - t.voteFeesPerEpochSol, 4),
    };
    const window = Array.from({ length: CREDIT_PARAMS.revenueWindowEpochs }, (_, i) => ({
      epoch: lastEpoch - CREDIT_PARAMS.revenueWindowEpochs + 1 + i,
      inflationSol: r.inflation,
      tipsSol: r.tips,
    }));
    credit = creditEstimate(window, lastEpoch);
    credit = { ...credit, note: `${credit.note}; estimated from today's stake, commission and APY` };
  }
  const price = input.epochPrice ?? (live ? { inr: live.inr, source: `${live.source} (live)` } : null);
  const liveInr = live?.inr ?? null;
  const at = (solAmount: number, inr: number | null): Rupees => rupees(inr === null ? null : solAmount * inr);
  return {
    revenue: {
      epoch,
      endedAt: input.endedAtMs === null ? null : isoIst(new Date(input.endedAtMs)),
      basis,
      sol,
      netInr: at(sol.net, price?.inr ?? null),
      priceInr: price?.inr ?? null,
      priceSource: price?.source ?? null,
    },
    credit: {
      estimate: true,
      basis,
      sweepablePerEpochSol: credit.sweepablePerEpochSol,
      sweepableLast10EpochsSol: credit.sweepableLast10EpochsSol,
      limitUnhedgedSol: credit.limitUnhedgedSol,
      limitHedgedSol: credit.limitHedgedSol,
      limitUnhedgedInr: at(credit.limitUnhedgedSol, liveInr),
      limitHedgedInr: at(credit.limitHedgedSol, liveInr),
      note: credit.note,
    },
  };
}

/** One row of the India table. */
export function indiaRow(input: {
  row: ValidatorRow;
  by: IndiaValidatorRow['inIndiaBy'];
  stakewiz: StakewizValidator | undefined;
  liveInr: number | null;
  money: { revenue: IndiaValidatorRevenue; credit: IndiaCreditEstimate };
}): IndiaValidatorRow {
  const { row, stakewiz } = input;
  return {
    name: row.name,
    vote: row.vote,
    identity: row.identity,
    voteShort: row.voteShort,
    inIndiaBy: input.by,
    city: stakewiz?.ip_city?.trim() || UNKNOWN_CITY,
    country: countryName(row.countryCode, row.country),
    countryCode: row.countryCode,
    hostingOrg: stakewiz?.ip_org ?? null,
    client: row.client,
    stakeSol: row.stakeSol,
    stakeValueInr: rupees(input.liveInr === null ? null : row.stakeSol * input.liveInr),
    commissionPct: row.commissionPct,
    mevCommissionPct: row.mevCommissionPct,
    apyPct: row.apyPct,
    stakingApyPct: row.stakingApyPct,
    tipsApyPct: row.tipsApyPct,
    epochScore: row.epochScore,
    health: row.health,
    healthReasons: row.healthReasons,
    delinquent: row.delinquent,
    uptimePct: row.uptimePct,
    delegators: row.delegators,
    top18: row.top18,
    revenue: input.money.revenue,
    credit: input.money.credit,
  };
}

/**
 * What a new validator hosted in India could keep per epoch and borrow from Epoch after a full revenue window, at
 * today's network rates: 5% commission and 5% MEV commission, the median tips APY, blocks in proportion to stake.
 */
export function prospect(t: TableFigures, liveInr: number | null): IndiaProspect {
  const voting = t.rows.filter((r) => !r.delinquent);
  const tipsApyPct = round(median(voting.map((r) => r.tipsApyPct).filter((x): x is number => x !== null)), 3);
  const commission = PROSPECT_COMMISSION_PCT / 100;
  const mevBps = PROSPECT_MEV_COMMISSION_PCT * 100;
  const epochsPerMonth = t.hoursPerEpoch > 0 ? (30 * 24) / t.hoursPerEpoch : 0;
  const produced = 1 - t.blocks.skipRatePct / 100;
  const { advanceBpsUnhedged, advanceBpsHedged, revenueWindowEpochs } = CREDIT_PARAMS;

  // Break-even, as /v1/network computes it: median commission, block fees by stake share.
  const perSolPerEpoch =
    t.grossYieldPerEpoch * (t.medianCommissionBps / 10_000) +
    (t.totalStakeSol > 0 ? (t.epoch.slotsInEpoch * t.feePerBlockSol) / t.totalStakeSol : 0);
  const breakEvenStakeSol = perSolPerEpoch > 0 ? Math.round(t.voteFeesPerEpochSol / perSolPerEpoch / 1_000) * 1_000 : 0;

  const tiers = PROSPECT_STAKES_SOL.map((stakeSol) => {
    const inflation = stakeSol * t.grossYieldPerEpoch * commission;
    const tipsToStakers = t.epochsPerYear > 0 ? (stakeSol * (tipsApyPct / 100)) / t.epochsPerYear : 0;
    const tips = (tipsToStakers * mevBps) / (10_000 - mevBps);
    const blocks = t.totalStakeSol > 0 ? (stakeSol / t.totalStakeSol) * t.epoch.slotsInEpoch * produced : 0;
    const net = inflation + tips + blocks * t.feePerBlockSol - t.voteFeesPerEpochSol;
    const window = (inflation + tips) * revenueWindowEpochs;
    const unhedged = (window * advanceBpsUnhedged) / 10_000;
    const hedged = (window * advanceBpsHedged) / 10_000;
    const inr = (sol: number): Rupees => rupees(liveInr === null ? null : sol * liveInr);
    return {
      stakeSol,
      revenuePerEpochSol: round(net, 4),
      revenuePerMonthSol: round(net * epochsPerMonth, 2),
      revenuePerMonthInr: inr(net * epochsPerMonth),
      creditLimitUnhedgedSol: round(unhedged, 2),
      creditLimitHedgedSol: round(hedged, 2),
      creditLimitUnhedgedInr: inr(unhedged),
      creditLimitHedgedInr: inr(hedged),
    };
  });
  return {
    note:
      `Estimate for a new validator hosted in India at today's network rates (${PROSPECT_COMMISSION_PCT}% ` +
      `commission, ${PROSPECT_MEV_COMMISSION_PCT}% MEV commission, median tips APY). Credit limits apply after ` +
      `${revenueWindowEpochs} epochs of swept revenue, before the bond and cap rules; not an offer.`,
    assumptions: {
      commissionPct: PROSPECT_COMMISSION_PCT,
      mevCommissionPct: PROSPECT_MEV_COMMISSION_PCT,
      tipsApyPct,
      epochsPerMonth: round(epochsPerMonth, 1),
      advanceBpsUnhedged,
      advanceBpsHedged,
      revenueWindowEpochs,
    },
    breakEvenStakeSol,
    tiers,
  };
}

export const priceBrief = (price: LivePrice | null): IndiaPriceBrief | null =>
  price
    ? {
        inr: round(price.inr, 2),
        formatted: rupees(price.inr).formatted,
        change24hPct: price.change24hPct === null ? null : round(price.change24hPct, 2),
        source: price.source,
        asOf: isoIst(new Date(price.observedAtMs)),
        stale: price.stale,
        staleReason: price.staleReason,
      }
    : null;

// ── Service ──────────────────────────────────────────────────────────────────────────────────────

export interface IndiaValidatorsSnapshot {
  asOf: string;
  source: string;
  notes: string[];
  status: IndiaValidatorsStatus;
  /** The India list as validator-table rows, for `queryValidators` (sort, filter, page). */
  tableRows: ValidatorRow[];
  rows: Map<string, IndiaValidatorRow>;
  india: IndiaShare;
  cities: IndiaCity[];
  comparison: IndiaComparison;
  prospect: IndiaProspect;
  network: { epoch: number; validators: number; stakeSol: number; stakeValueInr: Rupees };
  price: IndiaPriceBrief | null;
}

export interface IndiaValidatorDeps {
  table: () => Promise<ValidatorTableData>;
  /** Stakewiz rows by vote account (city, hosting organisation); empty when Stakewiz is down. */
  stakewiz: () => Promise<ReadonlyMap<string, StakewizValidator>>;
  /** The validator profile (GET /v1/validators/:vote) behind the revenue and credit figures. */
  profile: (vote: string) => Promise<ValidatorProfile>;
  prices: Pick<InrPriceService, 'live' | 'history'>;
  calendar: Pick<EpochCalendar, 'spans'>;
  /** Operator-declared Indian validators (INDIA_VALIDATOR_VOTES). */
  listedVotes: ReadonlySet<string>;
  /** How long one build waits for a validator profile before using the table's estimate. */
  profileTimeoutMs?: number;
}

/** Resolves to null after `ms` (or on error); the timer does not keep the process alive. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Validators hosted in India (Stakewiz IP geolocation → `countryCode` IN, plus INDIA_VALIDATOR_VOTES), India's share
 * of the network, its cities, the country comparison and the "start a validator in India" estimate. Built from the
 * validator table and kept for two minutes; each Indian validator's revenue and credit come from its profile when it
 * answers within the timeout (8 s), else from the table's rates.
 */
export class IndiaValidatorService {
  private readonly cache: SnapshotCache<IndiaValidatorsSnapshot>;

  constructor(private readonly deps: IndiaValidatorDeps) {
    this.cache = new SnapshotCache('indiaValidators', 2 * MINUTE, () => this.build(), 30 * MINUTE);
  }

  snapshot(): Promise<IndiaValidatorsSnapshot> {
    return this.cache.get();
  }

  private async build(): Promise<IndiaValidatorsSnapshot> {
    const { deps } = this;
    const t = await deps.table();
    const [stakewiz, live] = await Promise.all([
      deps.stakewiz().catch(() => new Map<string, StakewizValidator>()),
      deps.prices.live().catch((error: unknown) => {
        logger.warn('no SOL/INR price for the India validators', { error: String(error) });
        return null;
      }),
    ]);
    const notes: string[] = [];
    const countryData: IndiaShare['countryData'] = t.sources.includes('Stakewiz') ? 'available' : 'unknown';
    if (countryData === 'unknown') notes.push('Stakewiz has no country data right now: India cannot be told apart');
    const listed = indianRows(t.rows, deps.listedVotes);
    const geolocated = listed.filter((x) => x.by === 'ip-geolocation').map((x) => x.row);

    // Revenue epoch: when it ended and the day's price.
    const lastEpoch = t.epoch.epoch - 1;
    let endedAtMs: number | null = null;
    let epochPrice: { inr: number; source: string } | null = null;
    if (listed.length > 0) {
      try {
        endedAtMs = (await deps.calendar.spans()).get(lastEpoch)?.endMs ?? null;
        if (endedAtMs !== null) {
          const point = (await deps.prices.history(endedAtMs, endedAtMs)).book.at(endedAtMs);
          if (point) epochPrice = { inr: point.inr, source: point.source };
        }
      } catch (error) {
        notes.push(`epoch ${lastEpoch}'s end time unavailable (${String(error)}); revenue priced live`);
      }
    }
    const timeout = deps.profileTimeoutMs ?? 8_000;
    const profiles = await mapLimit(listed, 2, ({ row }) => within(deps.profile(row.vote), timeout));
    const estimated = listed.filter((_, i) => profiles[i] === null).map((x) => x.row.name);
    if (estimated.length > 0) {
      notes.push(`revenue and credit estimated from the table's rates for ${estimated.join(', ')} (profile not ready)`);
    }
    const liveInr = live?.inr ?? null;
    const rows = new Map<string, IndiaValidatorRow>();
    listed.forEach(({ row, by }, i) => {
      const money = revenueAndCredit({ row, table: t, profile: profiles[i], endedAtMs, epochPrice, live });
      rows.set(row.vote, indiaRow({ row, by, stakewiz: stakewiz.get(row.vote), liveInr, money }));
    });

    const status: IndiaValidatorsStatus = listed.length > 0 ? 'ok' : countryData === 'unknown' ? 'unknown' : 'empty';
    const listedOnly = listed.length - geolocated.length;
    const sources = [...t.sources];
    if (live) sources.push(live.source);
    return {
      asOf: isoIst(),
      source: sources.join(', '),
      notes,
      status,
      tableRows: listed.map((x) => x.row),
      rows,
      india: indiaShare(t.rows, countryData, listedOnly, liveInr),
      cities: cityBreakdown(geolocated, stakewiz),
      comparison: comparison(t.rows),
      prospect: prospect(t, liveInr),
      network: {
        epoch: t.epoch.epoch,
        validators: t.rows.length,
        stakeSol: Math.round(t.totalStakeSol),
        stakeValueInr: rupees(liveInr === null ? null : t.totalStakeSol * liveInr),
      },
      price: priceBrief(live),
    };
  }
}
