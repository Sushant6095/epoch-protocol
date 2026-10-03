import { Logger } from '@epoch/logger';

import { SnapshotCache } from '../Lib/SnapshotCache';
import {
  type JitoKobeSource,
  type KobeValidator,
  type PriceSource,
  type StakewizSource,
  type StakewizValidator,
} from '../Sources/ExternalSources';
import {
  type BlockProduction,
  type ClusterNode,
  type EpochInfo,
  type InflationRate,
  type PerformanceSample,
  type SolanaDataSource,
  type VoteAccounts,
} from '../Sources/SolanaDataSource';
import { type StakeHistoryEntry } from '../Lib/StakeLayouts';

const logger = Logger.create('MarketData');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Every upstream read behind the network and validator endpoints, each cached for as long as the data
 * stays meaningful. Third-party sources (Stakewiz, Jito, prices) degrade to empty or null instead of
 * failing the whole response; RPC reads are required.
 */
export class MarketData {
  readonly epochInfo: SnapshotCache<EpochInfo>;
  readonly voteAccounts: SnapshotCache<VoteAccounts>;
  readonly performance: SnapshotCache<PerformanceSample[]>;
  readonly clusterNodes: SnapshotCache<ClusterNode[]>;
  readonly blockProduction: SnapshotCache<BlockProduction>;
  readonly inflation: SnapshotCache<InflationRate>;
  readonly supplySol: SnapshotCache<number>;
  readonly stakeHistory: SnapshotCache<StakeHistoryEntry[]>;
  readonly feePerBlockSol: SnapshotCache<number>;
  readonly stakewiz: SnapshotCache<Map<string, StakewizValidator>>;
  readonly kobe: SnapshotCache<Map<string, KobeValidator>>;
  readonly solUsd: SnapshotCache<number>;
  readonly usdInr: SnapshotCache<number>;

  constructor(solana: SolanaDataSource, stakewiz: StakewizSource, kobe: JitoKobeSource, prices: PriceSource) {
    this.epochInfo = new SnapshotCache('epochInfo', 10 * SECOND, () => solana.getEpochInfo());
    this.voteAccounts = new SnapshotCache('voteAccounts', MINUTE, () => solana.getVoteAccounts());
    this.performance = new SnapshotCache('performance', MINUTE, () => solana.getRecentPerformanceSamples(60));
    this.clusterNodes = new SnapshotCache('clusterNodes', 10 * MINUTE, () => solana.getClusterNodes());
    this.blockProduction = new SnapshotCache('blockProduction', 2 * MINUTE, () => solana.getBlockProduction());
    this.inflation = new SnapshotCache('inflation', HOUR, () => solana.getInflationRate());
    this.supplySol = new SnapshotCache('supply', HOUR, () => solana.getSupplySol());
    this.stakeHistory = new SnapshotCache('stakeHistory', 10 * MINUTE, () => solana.getStakeHistory());
    this.feePerBlockSol = new SnapshotCache('feePerBlock', 15 * MINUTE, async () =>
      solana.sampleFeePerBlockSol((await this.epochInfo.get()).absoluteSlot),
    );
    this.stakewiz = new SnapshotCache('stakewiz', 5 * MINUTE, () => stakewiz.getValidators());
    this.kobe = new SnapshotCache('kobe', 15 * MINUTE, () => kobe.getValidators());
    this.solUsd = new SnapshotCache('solUsd', MINUTE, () => prices.solUsd());
    this.usdInr = new SnapshotCache('usdInr', 6 * HOUR, () => prices.usdInr());
  }

  /** Seconds per slot measured over the last ~hour of performance samples. */
  async secondsPerSlot(): Promise<number> {
    const samples = await this.performance.get();
    const slots = samples.reduce((s, x) => s + x.numSlots, 0);
    const secs = samples.reduce((s, x) => s + x.samplePeriodSecs, 0);
    return slots > 0 ? secs / slots : 0.4;
  }
}

/**
 * For third-party sources: the cached value, or the last good one, or `fallback` when the source has never
 * answered. A failing source never fails the endpoint.
 */
export async function optional<T>(cache: SnapshotCache<T>, fallback: T): Promise<T> {
  try {
    return await cache.get();
  } catch (error) {
    logger.warn(`${cache.name} unavailable; serving without it`, { error: String(error) });
    return cache.peek() ?? fallback;
  }
}
