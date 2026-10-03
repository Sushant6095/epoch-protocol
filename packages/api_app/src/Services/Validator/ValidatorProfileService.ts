import { REVENUE_WINDOW_EPOCHS } from '@epoch/common';
import { NotFoundException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';

import { mapLimit } from '../../Lib/Async';
import { type EpochStart, epochAt, parseStakewizTime } from '../../Lib/EpochTimes';
import { KeyedSnapshotCache } from '../../Lib/KeyedSnapshotCache';
import { SnapshotCache } from '../../Lib/SnapshotCache';
import { isoIst } from '../../Lib/Stats';
import { type JitoKobeSource, type StakewizSource } from '../../Sources/ExternalSources';
import { type SolanaDataSource } from '../../Sources/SolanaDataSource';
import { type ValidatorProfile } from '../../types/Wallet.types';
import { type DelegatorLabel, type DelegatorLabels, keyBase58 } from '../DelegatorLabels';
import { type InflationRewards } from '../InflationRewards';
import { type MarketData, optional } from '../MarketData';
import { type ValidatorTable } from '../ValidatorTable';
import { type ValidatorHistorySnapshot } from './ValidatorHistory';
import { buildProfile } from './ValidatorProfileBuilder';

const logger = Logger.create('ValidatorProfile');

const MINUTE = 60_000;
const PROFILE_TTL_MS = 2 * MINUTE;
const PROFILES_KEPT = 200;

/**
 * GET /v1/validators/:vote — one validator's story: its row in the validator table, its vote account (credits for 64
 * epochs), one read of its stake accounts (delegators, split, stake moves), its inflation rewards for the last 10
 * epochs (from the cache VoteRewardsWarmer fills; only the last epoch is read on demand), Jito Kobe's tips history,
 * Stakewiz's stake series and commission log, and Epoch's own recorded history. Built on demand and kept for two
 * minutes per validator (the 200 most recently asked for).
 */
export class ValidatorProfileService {
  private readonly profiles: KeyedSnapshotCache<ValidatorProfile>;
  private readonly epochStarts: SnapshotCache<EpochStart[]>;

  constructor(
    private readonly market: MarketData,
    private readonly solana: SolanaDataSource,
    private readonly table: ValidatorTable,
    private readonly labels: DelegatorLabels,
    private readonly rewards: InflationRewards,
    private readonly stakewiz: StakewizSource,
    private readonly kobe: JitoKobeSource,
    private readonly history: () => ValidatorHistorySnapshot | undefined,
    private readonly foundationKeys: ReadonlySet<string>,
  ) {
    this.profiles = new KeyedSnapshotCache('validatorProfile', PROFILES_KEPT, PROFILE_TTL_MS, (vote) =>
      this.build(vote),
    );
    this.epochStarts = new SnapshotCache('epochStarts', 360 * MINUTE, async () =>
      (await stakewiz.getEpochHistory())
        .map((row) => ({ epoch: row.epoch, startMs: parseStakewizTime(row.start) }))
        .filter((row) => Number.isFinite(row.startMs)),
    );
  }

  /** 404 NOT_FOUND for a vote account without stake. */
  async get(vote: string): Promise<ValidatorProfile> {
    const table = await this.table.get();
    if (!table.rows.some((row) => row.vote === vote)) {
      throw new NotFoundException('No validator with stake has this vote account', { vote });
    }
    return this.profiles.get(vote);
  }

  private async build(vote: string): Promise<ValidatorProfile> {
    const t = await this.table.get();
    const row = t.rows.find((r) => r.vote === vote);
    if (!row) throw new NotFoundException('No validator with stake has this vote account', { vote });
    const epoch = t.epoch.epoch;
    const lastEpoch = epoch - 1;
    const soft = <T>(what: string, promise: Promise<T>): Promise<T | null> =>
      promise.catch((error: unknown) => {
        logger.warn(`${what} unavailable for the profile`, { vote, error: String(error) });
        return null;
      });

    // RPC reads are required; third-party histories degrade to null.
    // The last epoch's reward is read now when the warmer has not reached it; older ones come from the cache only.
    const lastReward =
      this.rewards.cached(vote, lastEpoch) === undefined
        ? soft('inflation reward', this.rewards.get([vote], lastEpoch, epoch))
        : Promise.resolve(null);
    const [voteAccount, stakeAccounts, lastRead, kobeHistory, stakewizStakes, commissionLog] = await Promise.all([
      this.solana.getVoteAccountParsed(vote),
      this.solana.getStakeAccountsForVoteWithKeys(vote),
      lastReward,
      soft('Jito Kobe history', this.kobe.getValidatorHistory(vote)),
      soft('Stakewiz stake series', this.stakewiz.getTotalStakes(vote)),
      soft('Stakewiz commission log', this.stakewiz.getCommissionHistory(vote)),
    ]);
    const [nodes, production, stakewizRows] = await Promise.all([
      optional(this.market.clusterNodes, []),
      optional(this.market.blockProduction, { byIdentity: {}, range: { firstSlot: 0, lastSlot: 0 } }),
      optional(this.market.stakewiz, new Map()),
    ]);

    // Naming a stake pool the first time asks Jupiter for its token symbol: a few at a time.
    const labels = new Map<string, DelegatorLabel>();
    await mapLimit([...new Set(stakeAccounts.map((account) => account.withdrawerKey))], 8, async (key) => {
      const label = await this.labels.resolve(key);
      if (label) labels.set(key, label);
    });
    const voteRewards = new Map<number, number | null>();
    for (let e = epoch - REVENUE_WINDOW_EPOCHS; e < epoch; e++) {
      const reward = this.rewards.cached(vote, e);
      if (reward !== undefined) voteRewards.set(e, reward);
    }
    if (lastRead) voteRewards.set(lastEpoch, lastRead.get(vote) ?? null);

    const msPerSlot = t.secondsPerSlot * 1_000;
    let inflationChangeEpoch: number | null = null;
    const observed = (commissionLog ?? []).map((c) => parseStakewizTime(c.observed_at)).filter(Number.isFinite);
    if (observed.length > 0) {
      const starts = await optional(this.epochStarts, []);
      inflationChangeEpoch = epochAt(Math.max(...observed), starts, {
        epoch,
        startMs: Date.now() - t.epoch.slotIndex * msPerSlot,
        msPerEpoch: t.epoch.slotsInEpoch * msPerSlot,
      });
    }

    const produced = production.byIdentity[row.identity] ?? null;
    const recorded = this.history();
    const { profile, notes } = buildProfile({
      row,
      epoch,
      slotsInEpoch: t.epoch.slotsInEpoch,
      voteFeesPerEpochSol: t.voteFeesPerEpochSol,
      feePerBlockSol: t.feePerBlockSol,
      grossYieldPerEpoch: t.grossYieldPerEpoch,
      production: produced,
      blocksPerEpoch: produced ? (produced[1] * t.epoch.slotsInEpoch) / Math.max(1, t.epoch.slotIndex) : 0,
      version: nodes.find((node) => node.pubkey === row.identity)?.version ?? null,
      stakewiz: stakewizRows.get(vote),
      voteAccount,
      stakeAccounts,
      labels,
      foundationKeys: this.foundationKeys,
      toBase58: keyBase58,
      voteRewards,
      kobeHistory,
      stakewizStakes,
      inflationChangeEpoch,
      inflationLogRead: commissionLog !== null,
      recordedStake: recorded?.stake.get(vote),
      recordedCommission: recorded?.commission.get(vote),
    });

    const sources = ['Solana mainnet RPC'];
    if (stakewizRows.size > 0 || stakewizStakes || commissionLog) sources.push('Stakewiz');
    if (kobeHistory) sources.push('Jito Kobe');
    if (recorded) sources.push("Epoch's validator history");
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(),
      source: sources.join(', '),
      note: notes.join('; '),
      ...profile,
    };
  }
}
