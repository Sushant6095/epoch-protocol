import { GracefulShutdown } from '@epoch/common';
import { Logger } from '@epoch/logger';

import { isoIst } from '../Lib/Stats';
import { type SolanaDataSource } from '../Sources/SolanaDataSource';
import { DelegationAccumulator, type DelegationSnapshot } from './DelegationAccumulator';

const logger = Logger.create('DelegatorScan');

export interface DelegatorScanOptions {
  enabled: boolean;
  intervalHours: number;
  concurrency: number;
  /** Development only: scan the N largest validators. 0 = all. */
  voteLimit: number;
  foundationKeys: ReadonlySet<string>;
  /** Runs before a finished scan is published (used to name the largest owners); errors are logged. */
  beforePublish?: (snapshot: ScanSnapshot) => Promise<void>;
}

export type ScanSnapshot = DelegationSnapshot & {
  asOf: string;
  /** Validators whose stake accounts could not be read in this pass. */
  missingVotes: number;
};

export interface ScanStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  votesDone: number;
  votesTotal: number;
  lastError: string | null;
}

/**
 * Reads every delegated stake account on mainnet (one getProgramAccounts call per vote account, filtered
 * on the voter) and keeps the latest aggregate in memory. A full pass is ~700 calls; on the public RPC it
 * takes several minutes, on a paid RPC about one. It runs at boot and then every `intervalHours`.
 */
export class DelegatorScanService {
  private snapshot?: ScanSnapshot;
  private timer?: NodeJS.Timeout;
  private readonly state: ScanStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    votesDone: 0,
    votesTotal: 0,
    lastError: null,
  };

  constructor(
    private readonly solana: SolanaDataSource,
    private readonly options: DelegatorScanOptions,
  ) {}

  get latest(): ScanSnapshot | undefined {
    return this.snapshot;
  }

  get status(): ScanStatus {
    return { ...this.state };
  }

  start(): void {
    if (!this.options.enabled) {
      logger.info('delegator scan disabled');
      return;
    }
    const run = () => {
      this.scan().catch((error: unknown) => logger.error('delegator scan failed', error));
    };
    setTimeout(run, 2_000).unref();
    this.timer = setInterval(run, this.options.intervalHours * 3_600_000);
    this.timer.unref();
    GracefulShutdown.register('delegator-scan', async () => this.stop());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan(): Promise<void> {
    if (this.state.running) return;
    this.state.running = true;
    this.state.startedAt = isoIst();
    this.state.lastError = null;
    try {
      const [epochInfo, voteAccounts] = await Promise.all([this.solana.getEpochInfo(), this.solana.getVoteAccounts()]);
      let votes = [...voteAccounts.current, ...voteAccounts.delinquent]
        .filter((v) => v.activatedStake > 0)
        .sort((a, b) => b.activatedStake - a.activatedStake)
        .map((v) => v.votePubkey);
      if (this.options.voteLimit > 0) votes = votes.slice(0, this.options.voteLimit);
      this.state.votesTotal = votes.length;
      this.state.votesDone = 0;

      const accumulator = new DelegationAccumulator(epochInfo.epoch, this.options.foundationKeys);
      const failed: string[] = [];
      const scanOne = async (vote: string): Promise<boolean> => {
        try {
          accumulator.add(vote, await this.solana.getStakeAccountsForVote(vote));
          return true;
        } catch (error) {
          logger.warn('stake accounts for one validator failed', { vote, error: String(error) });
          return false;
        }
      };
      let next = 0;
      const worker = async () => {
        while (next < votes.length) {
          const vote = votes[next++];
          if (!(await scanOne(vote))) failed.push(vote);
          this.state.votesDone++;
          if (this.state.votesDone % 100 === 0)
            logger.info('scan progress', { done: this.state.votesDone, total: votes.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.options.concurrency, votes.length) }, worker));
      // One more try, one at a time, for the validators that failed in the parallel pass.
      const stillFailed: string[] = [];
      for (const vote of failed) if (!(await scanOne(vote))) stillFailed.push(vote);
      if (stillFailed.length > votes.length * 0.05) {
        throw new Error(`stake accounts failed for ${stillFailed.length} of ${votes.length} validators`);
      }

      const finished: ScanSnapshot = { ...accumulator.finish(), asOf: isoIst(), missingVotes: stillFailed.length };
      if (this.options.beforePublish) {
        await this.options
          .beforePublish(finished)
          .catch((error: unknown) => logger.warn('before-publish step failed', { error: String(error) }));
      }
      this.snapshot = finished;
      this.state.finishedAt = finished.asOf;
      logger.info('delegator scan finished', {
        votes: finished.votes,
        missingVotes: stillFailed.length,
        stakeAccounts: finished.stakeAccounts,
        wallets: finished.network.wallets,
      });
    } catch (error) {
      this.state.lastError = String(error);
      throw error;
    } finally {
      this.state.running = false;
    }
  }
}
