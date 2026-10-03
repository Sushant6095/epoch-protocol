import { Logger } from '@epoch/logger';

const logger = Logger.create('PeriodicJob');

/**
 * Runs `task` after `firstDelayMs` and then every `intervalMs`. A run never overlaps the previous one, and a failure
 * is logged and retried at the next tick, so one bad RPC answer never stops the job.
 */
export class PeriodicJob {
  private timer?: NodeJS.Timeout;
  private firstRun?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
    private readonly firstDelayMs = 0,
  ) {}

  get started(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.runNow();
    this.firstRun = setTimeout(tick, this.firstDelayMs);
    this.firstRun.unref();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
    logger.info('job started', { job: this.name, everyMinutes: Math.round((this.intervalMs / 60_000) * 10) / 10 });
  }

  /** Stops the schedule and waits for a run in progress. */
  async stop(): Promise<void> {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
    this.firstRun = undefined;
    this.timer = undefined;
    await this.running;
  }

  /** One run now, unless one is already in progress (then it waits for that one). Never throws. */
  runNow(): Promise<void> {
    if (!this.running) {
      const started = Date.now();
      this.running = this.task()
        .then(() => logger.debug('job run done', { job: this.name, ms: Date.now() - started }))
        .catch((error: unknown) => logger.error('job run failed; the next tick retries', error, { job: this.name }))
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running;
  }
}
