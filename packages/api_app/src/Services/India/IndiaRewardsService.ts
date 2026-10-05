import { ChainException, EpochException, ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';

import { mapLimit } from '../../Lib/Async';
import { type FinancialYear } from '../../Lib/IndianFy';
import { RateLimiter } from '../../Lib/RateLimiter';
import { type StakeAccountInfo } from '../../Lib/StakeLayouts';
import { shortKey } from '../../Lib/Stats';
import { type IndiaRewardsStatus, type IndiaWalletRewards } from '../../types/India.types';
import { type InflationRewards } from '../InflationRewards';
import { MAX_REWARD_ACCOUNTS, rewardAccounts } from '../Wallet/WalletStakeBuilder';
import { type EpochCalendar, type EpochSpan, epochsEndingIn } from './EpochCalendar';
import { walletRewards } from './IndiaRewards';
import { priceBrief } from './IndiaValidators';
import { type InrPriceService, PriceBook } from './InrPriceService';

const logger = Logger.create('IndiaRewards');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** A finished read is served for this long before the wallet is read again (finished epochs come from the cache). */
const DONE_TTL_MS = 10 * MINUTE;
/** A read that could not finish (some epochs failed) is retried sooner. */
const INCOMPLETE_TTL_MS = MINUTE;
const JOBS_KEPT = 500;
const MAX_RUNNING_JOBS = 25;
/** getInflationReward calls one wallet read keeps in flight (the shared limit applies on top). */
const PER_JOB_CONCURRENCY = 3;
/** Poll interval suggested to the page while a year loads. */
const POLL_SECONDS = 4;

/** At most `max` tasks at once across every caller; the rest wait in order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    // The slot is handed over by the releasing task, so `active` never exceeds `max`.
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

interface Job {
  key: string;
  wallet: string;
  fy: FinancialYear;
  finishedAtMs: number | null;
  /** Stake accounts whose rewards are read; null until listed. */
  accounts: string[] | null;
  delegatedAccounts: number;
  targets: EpochSpan[] | null;
  lamports: Map<number, number>;
  failed: Set<number>;
  /** Why the read could not start (stake accounts or epoch times unreadable). */
  error: EpochException | null;
  done: Promise<void>;
}

export interface IndiaRewardsDeps {
  /** The wallet's stake accounts as staker or withdrawer (SolanaDataSource.getStakeAccountsByAuthority). */
  stakeAccounts: (wallet: string) => Promise<StakeAccountInfo[]>;
  rewards: Pick<InflationRewards, 'get'>;
  calendar: Pick<EpochCalendar, 'spans'>;
  currentEpoch: () => Promise<number>;
  prices: Pick<InrPriceService, 'live' | 'history'>;
  /** getInflationReward calls in flight across all wallets. */
  rpcConcurrency: number;
  /** New wallet-year reads per IP per hour. */
  newReadsPerHour: number;
  /** How long a request waits for a read to finish before answering with what it has. */
  waitMs?: number;
  now?: () => number;
}

/** Resolves after the promise or `ms`, whichever is first; never rejects; the timer does not hold the process. */
function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * A wallet's staking rewards for one Indian financial year, in SOL and rupees. The first request starts a read in the
 * background: the wallet's stake accounts (the 100 largest delegated, as My Stake), then getInflationReward for every
 * epoch that ended in the year, newest first, three at a time per wallet and `rpcConcurrency` across wallets (one
 * call per epoch for up to 32 accounts; 100–200 epochs a year). The request that starts a read waits up to `waitMs`
 * (8 s); polls of a running read answer at once with what is read (`partial`). Finished epochs stay in the
 * InflationRewards cache, so a later read only fetches new epochs. A finished read is kept 10 minutes per wallet and
 * year (one with unreadable epochs, one minute).
 */
export class IndiaRewardsService {
  private readonly jobs = new Map<string, Job>();
  private readonly limiter: Semaphore;
  private readonly newReads: RateLimiter;
  private readonly now: () => number;

  constructor(private readonly deps: IndiaRewardsDeps) {
    this.now = deps.now ?? Date.now;
    this.limiter = new Semaphore(deps.rpcConcurrency);
    this.newReads = new RateLimiter(deps.newReadsPerHour, 60 * MINUTE, this.now);
  }

  /** The year's rewards as read so far. 429 when this IP starts too many new reads, 503 when too many run. */
  async get(wallet: string, fy: FinancialYear, meta: { ip?: string } = {}): Promise<IndiaWalletRewards> {
    const { job, started } = this.job(wallet, fy, meta.ip);
    await waitAtMost(job.done, started ? (this.deps.waitMs ?? 8_000) : 0);
    if (job.error) {
      this.jobs.delete(job.key);
      throw job.error;
    }
    return this.view(job);
  }

  /** The year's rewards once the read is done (for the CSV); 503 REWARDS_LOADING while it is still running. */
  async getFinished(wallet: string, fy: FinancialYear, meta: { ip?: string } = {}): Promise<IndiaWalletRewards> {
    const view = await this.get(wallet, fy, meta);
    if (view.status === 'loading' || view.status === 'partial') {
      throw new ServiceUnavailableException('The rewards for this year are still loading', 'REWARDS_LOADING', {
        retryAfterSeconds: POLL_SECONDS,
        epochsRead: view.coverage.epochsRead,
        epochsInYear: view.coverage.epochsInYear,
      });
    }
    return view;
  }

  private job(wallet: string, fy: FinancialYear, ip: string | undefined): { job: Job; started: boolean } {
    const key = `${wallet}:${fy.label}`;
    const existing = this.jobs.get(key);
    if (existing) {
      const ttl = existing.failed.size > 0 ? INCOMPLETE_TTL_MS : DONE_TTL_MS;
      if (existing.finishedAtMs === null || this.now() - existing.finishedAtMs < ttl) {
        return { job: existing, started: false };
      }
      this.jobs.delete(key);
    }
    const running = [...this.jobs.values()].filter((j) => j.finishedAtMs === null).length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new ServiceUnavailableException('Too many wallets are loading right now; try again in a minute', 'BUSY', {
        retryAfterSeconds: 30,
      });
    }
    this.newReads.consume(`india-read:${ip ?? 'unknown'}`, 'Too many new wallets from your network; wait a while');
    const job: Job = {
      key,
      wallet,
      fy,
      finishedAtMs: null,
      accounts: null,
      delegatedAccounts: 0,
      targets: null,
      lamports: new Map(),
      failed: new Set(),
      error: null,
      done: Promise.resolve(),
    };
    job.done = this.run(job)
      .catch((error: unknown) => {
        job.error = new ChainException('The wallet could not be read', { cause: String(error) });
      })
      .finally(() => {
        job.finishedAtMs = this.now();
      });
    this.jobs.set(key, job);
    this.evict();
    return { job, started: true };
  }

  /** Drops the oldest finished reads beyond JOBS_KEPT. */
  private evict(): void {
    for (const [key, job] of this.jobs) {
      if (this.jobs.size <= JOBS_KEPT) break;
      if (job.finishedAtMs !== null) this.jobs.delete(key);
    }
  }

  private async run(job: Job): Promise<void> {
    const { deps } = this;
    let current: number;
    try {
      const [accounts, spans, epoch] = await Promise.all([
        deps.stakeAccounts(job.wallet).catch((error: unknown) => {
          throw new ChainException("The wallet's stake accounts could not be read", { cause: String(error) });
        }),
        deps.calendar.spans().catch((error: unknown) => {
          throw new ServiceUnavailableException('Epoch times are unavailable right now', 'EPOCH_TIMES_UNAVAILABLE', {
            retryAfterSeconds: 30,
            cause: String(error),
          });
        }),
        deps.currentEpoch(),
      ]);
      current = epoch;
      job.delegatedAccounts = accounts.filter((a) => a.state === 'delegated').length;
      job.accounts = rewardAccounts(accounts);
      job.targets = epochsEndingIn(spans, job.fy.startMs, job.fy.endMs).filter((s) => s.epoch < current);
    } catch (error) {
      job.error =
        error instanceof EpochException
          ? error
          : new ChainException('The wallet could not be read', { cause: String(error) });
      return;
    }
    const accounts = job.accounts;
    if (accounts.length === 0) return;

    const readEpoch = async (span: EpochSpan): Promise<void> => {
      const byAccount = await this.limiter.run(() => deps.rewards.get(accounts, span.epoch, current));
      let lamports = 0;
      for (const amount of byAccount.values()) lamports += amount ?? 0;
      job.lamports.set(span.epoch, lamports);
      job.failed.delete(span.epoch);
    };
    const newestFirst = [...job.targets].sort((a, b) => b.epoch - a.epoch);
    await mapLimit(newestFirst, PER_JOB_CONCURRENCY, (span) =>
      readEpoch(span).catch(() => {
        job.failed.add(span.epoch);
      }),
    );
    // One more try for the epochs that failed (the RPC client already retried each call and failed over).
    for (const span of newestFirst.filter((s) => job.failed.has(s.epoch))) await readEpoch(span).catch(() => undefined);
    if (job.failed.size > 0) {
      logger.warn('some epochs could not be read', {
        wallet: shortKey(job.wallet),
        fy: job.fy.label,
        epochs: [...job.failed],
      });
    }
  }

  private async view(job: Job): Promise<IndiaWalletRewards> {
    const { deps } = this;
    const now = this.now();
    let status: IndiaRewardsStatus;
    if (job.targets === null) status = 'loading';
    else if (job.finishedAtMs === null) status = job.lamports.size > 0 ? 'partial' : 'loading';
    else status = job.failed.size > 0 ? 'incomplete' : 'complete';

    const notes: string[] = [];
    const sources = ['Solana mainnet RPC (stake accounts, getInflationReward)', 'Stakewiz (epoch times)'];
    let book = new PriceBook([]);
    if (job.lamports.size > 0) {
      const history = await deps.prices.history(job.fy.startMs, Math.min(job.fy.endMs, now));
      book = history.book;
      notes.push(...history.notes);
      sources.push(...book.sources);
    }
    const live = await deps.prices.live().catch(() => null);
    if (live && !sources.includes(live.source)) sources.push(`${live.source} (live)`);

    // No stake accounts: every epoch is known to have paid this wallet nothing.
    const lamports = new Map(job.lamports);
    if (job.accounts !== null && job.accounts.length === 0) {
      for (const span of job.targets ?? []) lamports.set(span.epoch, 0);
      notes.push('this wallet has no stake accounts today (as staker or withdrawer)');
    }
    if (job.delegatedAccounts > MAX_REWARD_ACCOUNTS) {
      notes.push(`rewards cover the ${MAX_REWARD_ACCOUNTS} largest of ${job.delegatedAccounts} stake accounts`);
    }
    if (job.fy.endMs > now) notes.push('the year so far: epochs that have ended');
    return walletRewards({
      wallet: job.wallet,
      fy: job.fy,
      now,
      status,
      stage: job.targets === null ? 'accounts' : job.finishedAtMs === null ? 'rewards' : 'done',
      targets: job.targets,
      lamports,
      failed: job.failed,
      stakeAccounts: job.accounts?.length ?? null,
      book,
      live: priceBrief(live),
      notes,
      sources,
      retryAfterSeconds: status === 'loading' || status === 'partial' ? POLL_SECONDS : null,
    });
  }
}
