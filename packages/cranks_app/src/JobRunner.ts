import { sleep } from '@epoch/common';
import { Logger, runWithTrace } from '@epoch/logger';
import { type PublicKey } from '@solana/web3.js';

import { type BuybackMarket } from './Chain/BuybackMarket';
import { type EpochChain } from './Chain/EpochChain';
import { type ValidatorDataSource } from './Chain/MainnetData';
import {
  AccrueJob,
  BuybackJob,
  type BuybackJobOptions,
  ClaimMevJob,
  type ClaimMevJobOptions,
  FinalizeIndexJob,
  type Job,
  type JobOutcome,
  MarkDefaultJob,
  ProcessWithdrawalsJob,
  SettleSwapsJob,
  SweepJob,
  Throttled,
  UpdateScoreJob,
} from './Jobs';

const logger = Logger.create('JobRunner');

export const DEFAULT_RESCORE_MS = 30 * 60_000;
export const DEFAULT_MEV_CLAIM_WAIT_MINUTES = 360;

export interface BoundaryStep {
  job: Job;
  /** Later boundary steps (and the steady jobs) wait until this one is done for the epoch. */
  gate: boolean;
  /**
   * Log `ALERT: boundary job still not done` when this gate is still waiting after `alertAfterMs` (default true). Off
   * for a gate with its own bounded wait (ClaimMevJob), which logs when it gives up.
   */
  alert?: boolean;
}

export interface JobRunnerOptions {
  /** Time between ticks. */
  pollMs: number;
  /** A gate step still unfinished this long after the runner first saw the epoch logs an error, once. */
  alertAfterMs: number;
  /** Between boundaries the scorer re-checks this often, so a new hedge counts without waiting for the next epoch. */
  rescoreMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the cranks on one loop (a tick every `pollMs`, a minute by default):
 *
 * 1. **Boundary steps**, in the order the program needs, until each is done for the current program epoch:
 *    update scores → wait for Jito's MEV claims (gate, bounded) → sweep (gate: waits for epoch rewards) → mark
 *    defaults (gate) → accrue (gate). A gate that is not done yet stops the steps after it; the next tick retries it.
 *    Scoring never blocks.
 * 2. **Steady jobs** once every gate is done, then on every tick: process withdrawals (the queue is paid as soon as
 *    the cash is there, never before this epoch's sweep and accrual), and revenue-token buybacks (one due slice per
 *    token per tick, after the sweep has moved this epoch's share into the escrow).
 * 3. **Pollers** on every tick regardless: finalize the Fee Index after its dispute window, settle swaps; and every
 *    `rescoreMs` (30 minutes) the scorer again, which posts only when a score or hedged flag changed.
 *
 * Every job is idempotent, so a restart mid-epoch simply re-checks the chain.
 */
export class JobRunner {
  private epoch?: bigint;
  private epochSeenAt = 0;
  private readonly done = new Set<string>();
  private readonly alerted = new Set<string>();
  private stopped = false;
  private running?: Promise<void>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly currentEpoch: () => Promise<bigint>,
    private readonly boundary: BoundaryStep[],
    private readonly steady: Job[],
    private readonly pollers: Job[],
    private readonly options: JobRunnerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /** The production wiring: every job on one chain client (BuybackJob when a market is given). */
  static create(
    chain: EpochChain,
    data: ValidatorDataSource,
    hedgeMakers: readonly PublicKey[],
    options: JobRunnerOptions,
    buyback?: { market: BuybackMarket; options: BuybackJobOptions },
    claimMev: ClaimMevJobOptions = { waitMinutes: DEFAULT_MEV_CLAIM_WAIT_MINUTES },
  ): JobRunner {
    const scores = new UpdateScoreJob(chain, data, hedgeMakers);
    const steady: Job[] = [new ProcessWithdrawalsJob(chain)];
    if (buyback) steady.push(new BuybackJob(chain, buyback.market, buyback.options));
    return new JobRunner(
      async () => (await chain.clock()).epoch,
      [
        { job: scores, gate: false },
        { job: new ClaimMevJob(chain, { now: options.now, ...claimMev }), gate: true, alert: false },
        { job: new SweepJob(chain), gate: true },
        { job: new MarkDefaultJob(chain), gate: true },
        { job: new AccrueJob(chain), gate: true },
      ],
      steady,
      [
        new FinalizeIndexJob(chain),
        new SettleSwapsJob(chain),
        new Throttled(scores, options.rescoreMs ?? DEFAULT_RESCORE_MS, options.now),
      ],
      options,
    );
  }

  /** One pass. Never throws. */
  async tick(): Promise<void> {
    let epoch: bigint;
    try {
      epoch = await this.currentEpoch();
    } catch (error) {
      logger.error('could not read the program cluster epoch', error);
      return;
    }
    if (epoch !== this.epoch) {
      if (this.epoch !== undefined) logger.info('epoch boundary', { epoch: epoch.toString() });
      this.epoch = epoch;
      this.epochSeenAt = this.now();
      this.done.clear();
      this.alerted.clear();
    }

    let blocked = false;
    for (const step of this.boundary) {
      if (blocked) break;
      if (this.done.has(step.job.name)) continue;
      const outcome = await this.runJob(step.job, epoch);
      if (outcome === 'done') this.done.add(step.job.name);
      else if (step.gate) blocked = true;
    }
    if (this.boundary.every((step) => !step.gate || this.done.has(step.job.name))) {
      for (const job of this.steady) await this.runJob(job, epoch);
    }
    for (const job of this.pollers) await this.runJob(job, epoch);
    this.alertIfLate(epoch);
  }

  /** Ticks until stopped. Returns the stop function, which resolves once the tick in progress has finished. */
  start(): () => Promise<void> {
    const loop = async () => {
      while (!this.stopped) {
        await runWithTrace(() => this.tick());
        if (!this.stopped) await this.sleep(this.options.pollMs);
      }
    };
    this.running = loop();
    return async () => {
      this.stopped = true;
      await this.running;
    };
  }

  /** Names of the boundary steps already done for the current epoch (for tests and logs). */
  doneSteps(): string[] {
    return this.boundary.map((s) => s.job.name).filter((name) => this.done.has(name));
  }

  private async runJob(job: Job, epoch: bigint): Promise<JobOutcome> {
    try {
      return await job.run(epoch);
    } catch (error) {
      logger.error('job threw; retrying next tick', error, { job: job.name, epoch: epoch.toString() });
      return 'retry';
    }
  }

  private alertIfLate(epoch: bigint): void {
    const minutes = Math.floor((this.now() - this.epochSeenAt) / 60_000);
    if (this.now() - this.epochSeenAt < this.options.alertAfterMs) return;
    for (const step of this.boundary) {
      if (!step.gate || step.alert === false || this.done.has(step.job.name) || this.alerted.has(step.job.name)) {
        continue;
      }
      this.alerted.add(step.job.name);
      logger.error('ALERT: boundary job still not done', undefined, {
        job: step.job.name,
        epoch: epoch.toString(),
        minutesSinceBoundary: minutes,
      });
    }
  }
}
