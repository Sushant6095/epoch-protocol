import { isoIst, median, percentile, round } from '../Lib/Stats';
import { type NetworkSnapshot, type StakeHistory } from '../types/Api.types';
import { type ScanSnapshot } from './DelegatorScanService';
import { type MarketData, optional } from './MarketData';
import { type ValidatorTable } from './ValidatorTable';

/** Finality: 32 confirmed slots on top of the vote (Tower BFT), as the UI explains it. */
const FINALITY_SLOTS = 32;

/** Published counts for the "validators over time" line; the live count is appended. */
const VALIDATOR_COUNT_HISTORY = [
  { date: '2023-03', count: 2560, source: 'Cointelegraph' },
  { date: '2026-01', count: 795, source: 'Cointelegraph' },
];

export class NetworkService {
  constructor(
    private readonly market: MarketData,
    private readonly table: ValidatorTable,
    private readonly scan: () => ScanSnapshot | undefined,
  ) {}

  /** GET /v1/network */
  async snapshot(): Promise<NetworkSnapshot> {
    const t = await this.table.get();
    const [solUsd, usdInr, history] = await Promise.all([
      optional(this.market.solUsd, null),
      optional(this.market.usdInr, null),
      optional(this.market.stakeHistory, []),
    ]);
    const scan = this.scan();
    const live = t.rows.filter((r) => !r.delinquent);
    const apys = live.map((r) => r.apyPct).filter((a): a is number => a !== null);

    // Activating and deactivating this epoch come from the delegator scan when it ran this epoch;
    // otherwise from the StakeHistory sysvar, whose newest entry is the last finished epoch.
    const scanThisEpoch = scan && scan.epoch === t.epoch.epoch ? scan : undefined;
    const latest = history[0];
    const activating = scanThisEpoch?.network.activatingSol ?? (latest ? Number(latest.activatingLamports) / 1e9 : 0);
    const deactivating =
      scanThisEpoch?.network.deactivatingSol ?? (latest ? Number(latest.deactivatingLamports) / 1e9 : 0);

    // Break-even: the stake at which a validator charging the median commission covers its vote fees from
    // inflation commission plus the block fees its stake share earns.
    const perSolPerEpoch =
      t.grossYieldPerEpoch * (t.medianCommissionBps / 10_000) +
      (t.totalStakeSol > 0 ? (t.epoch.slotsInEpoch * t.feePerBlockSol) / t.totalStakeSol : 0);
    const breakEven = perSolPerEpoch > 0 ? t.voteFeesPerEpochSol / perSolPerEpoch : 0;

    const sources = [...t.sources];
    if (solUsd !== null) sources.push('Jupiter');

    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(),
      source: sources.join(', '),
      note: scan ? undefined : 'Delegator figures appear once the first stake-account scan finishes.',
      epoch: {
        number: t.epoch.epoch,
        slotsInEpoch: t.epoch.slotsInEpoch,
        slotIndex: t.epoch.slotIndex,
        startSlot: t.epoch.absoluteSlot - t.epoch.slotIndex,
        secondsPerSlot: round(t.secondsPerSlot, 3),
        hoursPerEpoch: round(t.hoursPerEpoch, 1),
        epochsPerYear: round(t.epochsPerYear, 1),
      },
      validators: {
        total: t.rows.length,
        delinquent: t.recentlyDelinquent,
        belowBreakEven: live.filter((r) => r.healthPerEpochSol < 0).length,
        dependOnOneDelegator: scan ? live.filter((r) => (r.biggestDelegatorSharePct ?? 0) > 50).length : null,
        dependOnFoundation:
          scan && live.some((r) => r.foundationSharePct !== null)
            ? live.filter((r) => (r.foundationSharePct ?? 0) > 50).length
            : null,
        superminorityCount: t.superminorityCount,
      },
      stake: {
        totalSol: round(t.totalStakeSol),
        activatingThisEpochSol: round(activating),
        deactivatingThisEpochSol: round(deactivating),
        medianApyPct: round(median(apys), 2),
        topApyPct: round(percentile(apys, 0.9), 2),
      },
      delegators: scan
        ? {
            wallets: scan.network.wallets,
            stakeAccounts: scan.stakeAccounts,
            medianWalletSol: scan.network.medianWalletSol,
            retail: scan.network.retail,
            midSize: scan.network.midSize,
            allocators: scan.network.allocators,
          }
        : null,
      blocks: t.blocks,
      tps: await this.tps(),
      finalitySeconds: round(FINALITY_SLOTS * t.secondsPerSlot, 1),
      clients: t.clients,
      breakEvenStakeSol: Math.round(breakEven / 1_000) * 1_000,
      voteFeesPerEpochSol: round(t.voteFeesPerEpochSol, 2),
      price: { solUsd: solUsd === null ? null : round(solUsd, 2), usdInr: usdInr === null ? null : round(usdInr, 2) },
      validatorCountHistory: [
        ...VALIDATOR_COUNT_HISTORY,
        { date: isoIst().slice(0, 7), count: t.rows.length, source: 'Solana RPC (getVoteAccounts)' },
      ],
    };
  }

  /** GET /v1/network/stake-history?epochs= — oldest first, ending with the last finished epoch. */
  async stakeHistory(epochs: number): Promise<StakeHistory> {
    const entries = await this.market.stakeHistory.get();
    const rows = entries
      .slice(0, epochs)
      .reverse()
      .map((e) => ({
        epoch: e.epoch,
        totalActiveSol: Math.round(Number(e.effectiveLamports) / 1e9),
        activatingSol: Math.round(Number(e.activatingLamports) / 1e9),
        deactivatingSol: Math.round(Number(e.deactivatingLamports) / 1e9),
      }));
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(),
      source: 'Solana mainnet RPC (StakeHistory sysvar)',
      unit: 'SOL',
      rows,
    };
  }

  private async tps(): Promise<NetworkSnapshot['tps']> {
    const samples = await this.market.performance.get();
    const secs = samples.reduce((s, x) => s + x.samplePeriodSecs, 0);
    if (secs === 0) return { total: 0, user: 0, vote: 0 };
    const total = samples.reduce((s, x) => s + x.numTransactions, 0) / secs;
    const user = samples.reduce((s, x) => s + (x.numNonVoteTransactions ?? 0), 0) / secs;
    return { total: Math.round(total), user: Math.round(user), vote: Math.round(total - user) };
  }
}
