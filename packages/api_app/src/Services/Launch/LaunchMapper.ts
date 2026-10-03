import {
  BAND_HIGH_PCT,
  backingRatio,
  BUYBACK_SLICES_PER_EPOCH,
  CREATOR_MIGRATION_FEE_SHARE_PCT,
  type CurveBand,
  endEpochOf,
  epochsLeft,
  impliedYieldPctPerEpoch,
  launchBand,
  type LaunchRegistryEntry,
  LOCKED_LIQUIDITY_PCT,
  marketCapSol,
  MIGRATION_FEE_PCT,
  shareRevenuePerEpochSol,
} from '@epoch/meteora';

import { round } from '../../Lib/Stats';
import { type LaunchDetail, type LaunchNetwork, type LaunchStatus, type LaunchSummary } from '../../types/Launch.types';
import { type LaunchChainSnapshot, type LaunchEpochInfo } from './LaunchChain';
import { type RevenueEstimate } from './LaunchRevenue';

/** Devnet and mainnet slot time, for estimating the epoch of a past timestamp. */
const SECONDS_PER_SLOT = 0.4;

/** The detail blocks one launch needs besides its summary, the meta fields and the price series. */
export type LaunchDetailBody = Pick<
  LaunchDetail,
  'token' | 'curve' | 'escrow' | 'partnerFeesToSeniorSol' | 'upfrontToValidatorSol' | 'buybacks' | 'risks'
>;

/** One launch, mapped: what the list and the detail serve, the notes behind it, and whether every read succeeded. */
export interface LaunchItem {
  entry: LaunchRegistryEntry;
  summary: LaunchSummary;
  detail: LaunchDetailBody;
  notes: string[];
  real: boolean;
}

export interface LaunchMapInput {
  entry: LaunchRegistryEntry;
  chain: LaunchChainSnapshot;
  /** The launch cluster's current epoch; null when it could not be read. */
  epoch: LaunchEpochInfo | null;
  revenue: RevenueEstimate;
  network: LaunchNetwork;
  now: Date;
}

/** Significant digits, for prices (they span many orders of magnitude). */
const sig = (value: number, digits = 6): number => (value === 0 ? 0 : Number(value.toPrecision(digits)));

/**
 * ended once the term is over; upcoming before `opensAtEpoch` or while there is no pool; graduated once the curve
 * migrated to DAMM v2; else on the curve.
 */
export function launchStatus(input: {
  currentEpoch: number | null;
  endEpoch: number;
  opensAtEpoch: number | null;
  live: boolean;
  graduated: boolean;
}): LaunchStatus {
  const { currentEpoch } = input;
  if (currentEpoch !== null && currentEpoch > input.endEpoch) return 'ended';
  const beforeOpen = input.opensAtEpoch !== null && currentEpoch !== null && currentEpoch < input.opensAtEpoch;
  if (beforeOpen || !input.live) return 'upcoming';
  return input.graduated ? 'graduated' : 'curve';
}

/** The epoch a past unix time fell in, from the current epoch's position (slots of 0.4 s). */
export function estimateEpochAt(unixSeconds: number, epoch: LaunchEpochInfo, now: Date): number {
  const slotsAgo = Math.max(0, (now.getTime() / 1000 - unixSeconds) / SECONDS_PER_SLOT);
  if (slotsAgo <= epoch.slotIndex) return epoch.epoch;
  return epoch.epoch - Math.ceil((slotsAgo - epoch.slotIndex) / epoch.slotsInEpoch);
}

/** "Kestrel Nodes'", "Aurora's". */
const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** The Launch page's four risk lines (handover launch-rkest.sample.json), for this launch. */
export function launchRisks(entry: LaunchRegistryEntry, network: LaunchNetwork): string[] {
  const name = entry.validator.name;
  const end = endEpochOf(entry.startEpoch, entry.termEpochs);
  return [
    network === 'devnet'
      ? 'Revenue tokens can count as securities in many countries. This is a devnet demo with no real value, and nothing here is an offer.'
      : 'Revenue tokens can count as securities in many countries, and nothing here is an offer.',
    `Buybacks follow ${possessive(name)} real commission revenue: if its stake or fees fall, so does the buyback.`,
    `${name} can't leave Epoch or lower its commission until its term ends, after epoch ${end}'s sweep: both need the withdraw authority the program holds.`,
    "If the DAMM v2 buyback isn't ready, holders can also redeem tokens for their share of the escrow (same backing, no market buy); trading on the pool goes on.",
  ];
}

/** Maps a registry entry and its chain reads to the Launch page's summary and detail blocks (pure). */
export function buildLaunchItem(input: LaunchMapInput): LaunchItem {
  const { entry, chain, epoch, revenue, network, now } = input;
  const notes: string[] = [];
  const { pool, damm } = chain;
  const endEpoch = endEpochOf(entry.startEpoch, entry.termEpochs);
  const currentEpoch = epoch?.epoch ?? null;

  // A failed read leaves the registry to tell what exists.
  const poolKnown = pool !== undefined || !entry.dbcPool;
  const dammKnown = damm !== undefined || !(entry.dammPool ?? pool?.dammPool);
  const live = !!pool || !!damm || (!poolKnown && !!entry.dbcPool) || (!dammKnown && !!entry.dammPool);
  const graduated = !!pool?.migrated || !!damm || (!dammKnown && !!entry.dammPool);
  const status = launchStatus({
    currentEpoch,
    endEpoch,
    opensAtEpoch: entry.opensAtEpoch ?? null,
    live,
    graduated,
  });

  // The band: the curve's own prices when its config was read, else from the revenue it was priced from.
  let band: CurveBand | null = pool
    ? {
        valuePerTokenSol: pool.migrationPriceSol / (BAND_HIGH_PCT / 100),
        bandLowSol: pool.startPriceSol,
        bandHighSol: pool.migrationPriceSol,
      }
    : null;
  const pricedFrom = entry.avgRevenueSol ?? revenue.avgRevenueSol;
  if (!band && pricedFrom !== null) {
    band = launchBand({
      avgRevenueSol: pricedFrom,
      shareBps: entry.shareBps,
      termEpochs: entry.termEpochs,
      supply: entry.supply,
    });
  }
  if (!band) notes.push(`${entry.symbol}: no curve and no revenue to price the band from yet.`);

  const priceSol =
    status === 'upcoming'
      ? null
      : status === 'curve'
        ? (pool?.priceSol ?? null)
        : (damm?.priceSol ?? pool?.priceSol ?? null);
  const burned = chain.mint ? Math.max(0, entry.supply - chain.mint.uiSupply) : (entry.burned ?? 0);
  const marketCap = marketCapSol(priceSol, entry.supply, burned);
  const shareRevenue =
    revenue.avgRevenueSol !== null ? shareRevenuePerEpochSol(revenue.avgRevenueSol, entry.shareBps) : 0;
  if (revenue.avgRevenueSol === null) {
    notes.push(`${entry.symbol}: share revenue is 0 until it is known (${revenue.note ?? 'no revenue estimate'}).`);
  }
  const remaining = currentEpoch !== null ? epochsLeft({ ...entry, currentEpoch }) : null;
  const known = revenue.avgRevenueSol !== null;

  const targetSol = pool?.migrationThresholdSol ?? entry.raiseTargetSol ?? 0;
  const raised = graduated ? targetSol : (pool?.quoteReserveSol ?? 0);
  const migrationFeePct = pool?.migrationFeePct ?? MIGRATION_FEE_PCT;
  const creatorSharePct = pool?.creatorMigrationFeeSharePct ?? CREATOR_MIGRATION_FEE_SHARE_PCT;
  const creatorMigrationFeePct = (migrationFeePct * creatorSharePct) / 100;
  const summary: LaunchSummary = {
    mint: entry.mint,
    symbol: entry.symbol,
    name: entry.name,
    validator: { name: entry.validator.name, vote: entry.validator.vote },
    shareBps: entry.shareBps,
    termEpochs: entry.termEpochs,
    startEpoch: entry.startEpoch,
    endEpoch,
    status,
    opensAtEpoch: status === 'upcoming' ? (entry.opensAtEpoch ?? null) : null,
    raise: {
      targetSol: round(targetSol, 4),
      raisedSol: round(targetSol > 0 ? Math.min(raised, targetSol) : raised, 4),
      progressPct: round(graduated ? 100 : (pool?.curveProgressPct ?? 0), 2),
      buyers: chain.holders?.holdersExcluding ?? 0,
    },
    priceSol: priceSol === null ? null : sig(priceSol),
    bandLowSol: band ? sig(band.bandLowSol) : 0,
    bandHighSol: band ? sig(band.bandHighSol) : 0,
    marketCapSol: marketCap === null ? null : round(marketCap, 4),
    shareRevenuePerEpochSol: round(shareRevenue, 6),
    impliedYieldPctPerEpoch: known ? nullableRound(impliedYieldPctPerEpoch(shareRevenue, marketCap), 2) : null,
    backingRatio:
      known && remaining !== null ? nullableRound(backingRatio(shareRevenue, remaining, marketCap), 2) : null,
  };

  if (chain.mint?.mintAuthority) notes.push(`${entry.symbol}: the mint still has a mint authority.`);
  let graduatedEpoch = entry.graduatedEpoch ?? null;
  if (graduatedEpoch === null && graduated && pool?.finishCurveTime && epoch) {
    graduatedEpoch = estimateEpochAt(pool.finishCurveTime, epoch, now);
  }
  if (chain.failed.length > 0) notes.push(`${entry.symbol}: could not read ${chain.failed.join(', ')}.`);
  if (pool === null) notes.push(`${entry.symbol}: the curve pool is not on ${network} yet.`);

  const detail: LaunchDetailBody = {
    token: {
      supply: entry.supply,
      burned: round(burned, 6),
      holders: chain.holders?.holders ?? 0,
      decimals: chain.mint?.decimals ?? entry.decimals,
      mintAuthority: null,
      metadataImmutable: pool ? pool.tokenUpdateAuthority === 1 : false,
    },
    curve: {
      dbcPool: entry.dbcPool ?? null,
      config: pool?.config ?? entry.dbcConfig ?? null,
      bandLowSol: summary.bandLowSol,
      bandHighSol: summary.bandHighSol,
      valuePerTokenSol: band ? sig(band.valuePerTokenSol) : 0,
      migrationThresholdSol: round(targetSol, 4),
      creatorMigrationFeePct,
      lockedLiquidityPct: pool
        ? pool.liquidity.partnerLockedPct + pool.liquidity.creatorLockedPct
        : LOCKED_LIQUIDITY_PCT,
      dammPool: entry.dammPool ?? pool?.dammPool ?? null,
      graduatedEpoch,
    },
    escrow: {
      address: entry.escrow ?? null,
      balanceSol: round(chain.escrowSol ?? 0, 6),
      slicesPerEpoch: BUYBACK_SLICES_PER_EPOCH,
      mode: 'buyback',
    },
    partnerFeesToSeniorSol: round(pool?.fees.partnerTotalSol ?? 0, 6),
    upfrontToValidatorSol: graduated ? round((targetSol * creatorMigrationFeePct) / 100, 4) : null,
    buybacks: [],
    risks: launchRisks(entry, network),
  };

  return { entry, summary, detail, notes, real: chain.failed.length === 0 && epoch !== null };
}

const nullableRound = (value: number | null, decimals: number): number | null =>
  value === null ? null : round(value, decimals);
