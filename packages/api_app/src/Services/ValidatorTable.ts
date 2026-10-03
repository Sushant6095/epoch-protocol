import { countryCode } from '../Lib/Countries';
import { computeScore, displayScore } from '../Lib/EpochScore';
import { SnapshotCache } from '../Lib/SnapshotCache';
import { isoIst, median, round, shortKey, superminority } from '../Lib/Stats';
import { type EpochInfo, type VoteAccount } from '../Sources/SolanaDataSource';
import { type HealthStatus, type ValidatorRow } from '../types/Api.types';
import { type ScanSnapshot } from './DelegatorScanService';
import { type MarketData, optional } from './MarketData';
import { lastCommissionRaise, type ValidatorHistorySnapshot } from './Validator/ValidatorHistory';

/** Fee per vote transaction; one vote per slot. */
const VOTE_FEE_LAMPORTS = 5_000;
const FIREDANCER_CLIENTS = new Set(['Firedancer', 'Frankendancer', 'HarmonicFiredancer', 'FireBAM']);
const SECONDS_PER_YEAR = 365.25 * 86_400;

export interface ValidatorTableData {
  asOf: string;
  /** Every validator with stake, largest first. */
  rows: ValidatorRow[];
  epoch: EpochInfo;
  secondsPerSlot: number;
  hoursPerEpoch: number;
  epochsPerYear: number;
  voteFeesPerEpochSol: number;
  /** Staking rewards per SOL per epoch before commission (inflation only). */
  grossYieldPerEpoch: number;
  feePerBlockSol: number;
  medianCommissionBps: number;
  totalStakeSol: number;
  superminorityCount: number;
  /** Delinquent now but earned credits in this or the last epoch. */
  recentlyDelinquent: number;
  clients: { agavePct: number; firedancerPct: number; validatorsWithVersion: number };
  blocks: { perDay: number; skipRatePct: number };
  /** Third-party sources that answered, for `source`. */
  sources: string[];
  /** `asOf` of the delegator scan the rows were built with; null before the first scan. */
  scanAsOf: string | null;
  /** `version` of the validator history the rows were built with; 0 without history. */
  historyVersion: number;
}

export const clientFamily = (clientId: string | undefined): ValidatorRow['client'] => {
  if (!clientId || clientId.startsWith('Unknown')) return 'Unknown';
  return FIREDANCER_CLIENTS.has(clientId) ? 'Firedancer' : 'Agave';
};

/** Credits earned in `epoch`, from a vote account's epochCredits. */
const creditsIn = (account: VoteAccount, epoch: number): number => {
  const entry = account.epochCredits.find(([e]) => e === epoch);
  return entry ? entry[1] - entry[2] : 0;
};

/** Health rules, the same as the app's lib/health.ts (01-PRODUCT-AND-USERS.md). */
export function healthOf(
  row: Pick<
    ValidatorRow,
    'delinquent' | 'healthPerEpochSol' | 'biggestDelegatorSharePct' | 'uptimePct' | 'commissionHistory'
  >,
): {
  health: HealthStatus;
  healthReasons: string[];
} {
  if (row.delinquent) return { health: 'offline', healthReasons: ['not voting'] };
  const reasons: string[] = [];
  if (row.healthPerEpochSol < 0) reasons.push('below break-even');
  if (row.biggestDelegatorSharePct !== null && row.biggestDelegatorSharePct > 50) {
    reasons.push(`${Math.round(row.biggestDelegatorSharePct)}% one delegator`);
  }
  if (row.uptimePct !== null && row.uptimePct < 99) reasons.push(`uptime ${row.uptimePct}%`);
  // "Commission raised in the last 10 epochs": applied when the validator history (Postgres) has the commissions.
  const raise = row.commissionHistory ? lastCommissionRaise(row.commissionHistory) : null;
  if (raise) reasons.push(`commission raised ${raise.fromPct}% → ${raise.toPct}%`);
  return { health: reasons.length > 0 ? 'watch' : 'healthy', healthReasons: reasons };
}

/**
 * Builds one row per validator from RPC, Stakewiz, Jito and the delegator scan, plus the network-wide
 * figures derived from the same pass. Cached for a minute.
 */
export class ValidatorTable {
  private readonly cache: SnapshotCache<ValidatorTableData>;

  constructor(
    private readonly market: MarketData,
    private readonly scan: () => ScanSnapshot | undefined,
    private readonly history: () => ValidatorHistorySnapshot | undefined = () => undefined,
  ) {
    this.cache = new SnapshotCache('validatorTable', 60_000, () => this.build());
  }

  async get(): Promise<ValidatorTableData> {
    const data = await this.cache.get();
    // A delegator scan finished after these rows were built: rebuild now, so delegator fields on the rows and the
    // network counts derived from them match the scan.
    if ((this.scan()?.asOf ?? null) !== data.scanAsOf) return this.cache.refresh();
    // Likewise when the validator history recorder wrote new epochs.
    if ((this.history()?.version ?? 0) !== data.historyVersion) return this.cache.refresh();
    return data;
  }

  private async build(): Promise<ValidatorTableData> {
    const m = this.market;
    const [epoch, voteAccounts, secondsPerSlot, inflation, supplySol] = await Promise.all([
      m.epochInfo.get(),
      m.voteAccounts.get(),
      m.secondsPerSlot(),
      m.inflation.get(),
      m.supplySol.get(),
    ]);
    const [nodes, production, feePerBlockSol, stakewiz, kobe] = await Promise.all([
      optional(m.clusterNodes, []),
      optional(m.blockProduction, { byIdentity: {}, range: { firstSlot: 0, lastSlot: 0 } }),
      optional(m.feePerBlockSol, 0),
      optional(m.stakewiz, new Map()),
      optional(m.kobe, new Map()),
    ]);
    const scan = this.scan();
    const history = this.history();

    const delinquentSet = new Set(voteAccounts.delinquent.map((v) => v.votePubkey));
    const all = [...voteAccounts.current, ...voteAccounts.delinquent]
      .filter((v) => v.activatedStake > 0)
      .sort((a, b) => b.activatedStake - a.activatedStake);
    const stakesSol = all.map((v) => v.activatedStake / 1e9);
    const totalStakeSol = stakesSol.reduce((s, x) => s + x, 0);
    const superSet = superminority(stakesSol);

    const secondsPerEpoch = epoch.slotsInEpoch * secondsPerSlot;
    const epochsPerYear = SECONDS_PER_YEAR / secondsPerEpoch;
    const voteFeesPerEpochSol = (epoch.slotsInEpoch * VOTE_FEE_LAMPORTS) / 1e9;
    const grossYieldPerEpoch =
      totalStakeSol > 0 ? (inflation.validator * supplySol) / totalStakeSol / epochsPerYear : 0;
    const elapsedSeconds = Math.max(1, epoch.slotIndex * secondsPerSlot);
    const epochScale = epoch.slotsInEpoch / Math.max(1, epoch.slotIndex);

    const lastEpoch = epoch.epoch - 1;
    const voterCredits = voteAccounts.current.map((v) => creditsIn(v, lastEpoch)).filter((c) => c > 0);
    const avgCredits = voterCredits.length ? voterCredits.reduce((s, c) => s + c, 0) / voterCredits.length : 0;
    const recentlyDelinquent = voteAccounts.delinquent.filter(
      (v) => v.activatedStake > 0 && v.epochCredits.some(([e]) => e >= lastEpoch),
    ).length;
    const nodeByIdentity = new Map(nodes.map((n) => [n.pubkey, n]));

    const rows: ValidatorRow[] = all.map((v, index) => {
      const sw = stakewiz.get(v.votePubkey);
      const kb = kobe.get(v.votePubkey);
      const node = nodeByIdentity.get(v.nodePubkey);
      const [, produced] = production.byIdentity[v.nodePubkey] ?? [0, 0];
      const stakeSol = v.activatedStake / 1e9;
      const commissionBps = v.inflationRewardsCommissionBps ?? v.commission * 100;
      const mevBps = kb?.mev_commission_bps ?? sw?.jito_commission_bps ?? null;
      const tipsApyPct = sw?.jito_apy ?? (sw ? 0 : null);

      const inflationCommission = stakeSol * grossYieldPerEpoch * (commissionBps / 10_000);
      const tipsToStakers = (stakeSol * ((tipsApyPct ?? 0) / 100)) / epochsPerYear;
      const mevCommission = mevBps !== null && mevBps < 10_000 ? (tipsToStakers * mevBps) / (10_000 - mevBps) : 0;
      const blockFees = produced * epochScale * feePerBlockSol;
      const healthPerEpochSol = round(inflationCommission + mevCommission + blockFees - voteFeesPerEpochSol, 2);

      const delinquent = delinquentSet.has(v.votePubkey);
      const epochsActive =
        sw?.first_epoch_with_stake !== null && sw?.first_epoch_with_stake !== undefined
          ? Math.max(0, epoch.epoch - sw.first_epoch_with_stake)
          : v.epochCredits.length;
      const credits = creditsIn(v, lastEpoch);
      const score = computeScore({
        creditsRatioBps: avgCredits > 0 ? (credits / avgCredits) * 10_000 : 10_000,
        commissionBps: Math.max(commissionBps, mevBps ?? 0),
        epochsActive,
        delinquent,
        superminority: superSet.has(index),
      });
      const stats = scan?.perVote.get(v.votePubkey);
      const uptimePct = sw?.uptime ?? null;
      const commissionHistory = history?.commission.get(v.votePubkey);
      const stakeHistory = history?.stake.get(v.votePubkey);

      const base = {
        delinquent,
        healthPerEpochSol,
        biggestDelegatorSharePct: stats?.biggestDelegatorSharePct ?? null,
        uptimePct,
        commissionHistory,
      };
      return {
        name: sw?.name?.trim() || shortKey(v.votePubkey),
        vote: v.votePubkey,
        identity: v.nodePubkey,
        voteShort: shortKey(v.votePubkey),
        client: clientFamily(node?.clientId),
        clientId: node?.clientId ?? null,
        country: sw?.ip_country ?? 'Unknown',
        countryCode: countryCode(sw?.ip_country),
        apyPct: sw?.total_apy ?? null,
        stakingApyPct: sw?.staking_apy ?? null,
        tipsApyPct,
        commissionPct: commissionBps / 100,
        stakeSol: round(stakeSol),
        delegators: stats?.delegators ?? null,
        biggestDelegatorSharePct: base.biggestDelegatorSharePct,
        blocksPerDay: Math.round((produced / elapsedSeconds) * 86_400),
        healthPerEpochSol,
        uptimePct,
        top18: superSet.has(index),
        epochScore: displayScore(score),
        mevCommissionPct: mevBps === null ? null : mevBps / 100,
        delinquent,
        foundationSharePct: stats?.foundationSharePct ?? null,
        ...healthOf(base),
        ...(commissionHistory ? { commissionHistory } : {}),
        ...(stakeHistory ? { stakeHistorySol: stakeHistory.map((point) => point.sol) } : {}),
      };
    });

    let leaderSlots = 0;
    let producedTotal = 0;
    for (const [slots, produced] of Object.values(production.byIdentity)) {
      leaderSlots += slots;
      producedTotal += produced;
    }
    const withVersion = rows.filter((r) => r.client !== 'Unknown');
    const firedancer = withVersion.filter((r) => r.client === 'Firedancer').length;
    const sources = ['Solana mainnet RPC'];
    if (stakewiz.size) sources.push('Stakewiz');
    if (kobe.size) sources.push('Jito Kobe');
    if (scan) sources.push('stake-account scan');
    if (history) sources.push('validator history');

    return {
      asOf: isoIst(),
      rows,
      epoch,
      secondsPerSlot,
      hoursPerEpoch: secondsPerEpoch / 3_600,
      epochsPerYear,
      voteFeesPerEpochSol,
      grossYieldPerEpoch,
      feePerBlockSol,
      medianCommissionBps: median(
        voteAccounts.current.map((v) => v.inflationRewardsCommissionBps ?? v.commission * 100),
      ),
      totalStakeSol,
      superminorityCount: superSet.size,
      recentlyDelinquent,
      clients: {
        agavePct: withVersion.length ? round(((withVersion.length - firedancer) / withVersion.length) * 100, 1) : 0,
        firedancerPct: withVersion.length ? round((firedancer / withVersion.length) * 100, 1) : 0,
        validatorsWithVersion: withVersion.length,
      },
      blocks: {
        perDay: Math.round((producedTotal / elapsedSeconds) * 86_400),
        skipRatePct: leaderSlots > 0 ? round(((leaderSlots - producedTotal) / leaderSlots) * 100, 2) : 0,
      },
      sources,
      scanAsOf: scan?.asOf ?? null,
      historyVersion: history?.version ?? 0,
    };
  }
}
