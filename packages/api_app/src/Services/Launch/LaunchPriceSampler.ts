import { GracefulShutdown } from '@epoch/common';
import { Logger } from '@epoch/logger';

import { type LaunchPriceSample, type LaunchPriceStore } from './LaunchPriceStore';

const logger = Logger.create('LaunchPriceSampler');

/** Where the samples come from: the launch service's fresh read of every launch. */
export interface LaunchPriceSource {
  priceSamples(): Promise<LaunchPriceSample[]>;
}

/**
 * Samples every launch's price into launch_price_samples while the API runs (once a minute by default): the Launch
 * chart's series. A sample per (mint, read time); a read served twice is stored once.
 */
export class LaunchPriceSampler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly source: LaunchPriceSource,
    private readonly store: LaunchPriceStore,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    const run = () => {
      this.tick().catch((error: unknown) => logger.warn('launch price sample failed', { error: String(error) }));
    };
    setTimeout(run, 5_000).unref();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
    GracefulShutdown.register('launch-price-sampler', async () => this.stop());
    logger.info('launch price sampler started', { everySeconds: this.intervalMs / 1000 });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass; returns how many new samples were stored (0 while a pass is still running). */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const samples = await this.source.priceSamples();
      return await this.store.insert(samples);
    } finally {
      this.running = false;
    }
  }
}
