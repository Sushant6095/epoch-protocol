import { Logger } from '@epoch/logger';
import { isRetryablePantaError } from '@epoch/panta';

const logger = Logger.create('PantaStreamPoller');

export const PANTA_CHANNEL = 'predict:panta';

/** The hub side the poller needs (StreamHub). */
export interface PantaStreamHub {
  subscriberCount(channel: typeof PANTA_CHANNEL): number;
  refresh(channel: typeof PANTA_CHANNEL): void;
}

export interface PantaStreamPollerOptions {
  hub: PantaStreamHub;
  /** Re-reads our markets' prices from Panta; throws when Panta cannot be read. */
  refresh: () => Promise<void>;
  /** PANTA_STREAM_INTERVAL_SECONDS × 1,000 (≥ 10 s). */
  intervalMs: number;
  /** Backoff ceiling. Default 5 minutes. */
  maxIntervalMs?: number;
}

/**
 * Feeds the WS `predict:panta` channel: while anyone is subscribed, re-reads Epoch's markets' prices every interval
 * and pushes them; nobody listening, no Panta reads at all. A failure (429, Panta down) doubles the interval up to the
 * ceiling; the next success resets it.
 */
export class PantaStreamPoller {
  private timer?: NodeJS.Timeout;
  private delayMs: number;
  private running = false;

  constructor(private readonly options: PantaStreamPollerOptions) {
    this.delayMs = options.intervalMs;
  }

  /** The wait before the next poll (grows on failures). */
  get currentDelayMs(): number {
    return this.delayMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.options.intervalMs);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One poll (exported for tests): skipped without subscribers. */
  async tick(): Promise<void> {
    if (this.options.hub.subscriberCount(PANTA_CHANNEL) === 0) return;
    try {
      await this.options.refresh();
      this.options.hub.refresh(PANTA_CHANNEL);
      this.delayMs = this.options.intervalMs;
    } catch (error) {
      this.delayMs = Math.min(this.options.maxIntervalMs ?? 300_000, this.delayMs * 2);
      logger.warn('Panta price poll failed; backing off', {
        nextPollSeconds: Math.round(this.delayMs / 1_000),
        rateLimited: isRetryablePantaError(error),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.delayMs));
    }, ms);
    this.timer.unref();
  }
}
