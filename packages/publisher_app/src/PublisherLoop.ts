import { sleep } from '@epoch/common';
import { Logger, runWithTrace } from '@epoch/logger';

import { type PublisherStep } from './Publishers';

const logger = Logger.create('PublisherLoop');

/** Runs each step in order every `intervalMs` (IndexPublisher, then QuoteMaker). A failing step never stops the loop. */
export class PublisherLoop {
  private stopped = false;
  private running?: Promise<void>;

  constructor(
    private readonly steps: PublisherStep[],
    private readonly intervalMs: number,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async tick(): Promise<void> {
    for (const step of this.steps) {
      try {
        await step.tick();
      } catch (error) {
        logger.error('step failed; retrying next interval', error, { step: step.name });
      }
    }
  }

  /** Ticks until stopped. Returns the stop function, which resolves once the tick in progress has finished. */
  start(): () => Promise<void> {
    const loop = async () => {
      while (!this.stopped) {
        await runWithTrace(() => this.tick());
        if (!this.stopped) await this.wait(this.intervalMs);
      }
    };
    this.running = loop();
    return async () => {
      this.stopped = true;
      await this.running;
    };
  }
}
