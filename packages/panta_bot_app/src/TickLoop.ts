import { sleep } from '@epoch/common';
import { Logger, runWithTrace } from '@epoch/logger';

const logger = Logger.create('TickLoop');

/** Runs `tick` now and then every `intervalMs` after each run ends. A failing tick never stops the loop. */
export class TickLoop {
  private stopped = false;
  private running?: Promise<void>;

  constructor(
    private readonly tick: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Starts ticking; returns the stop function, which resolves once the tick in progress has finished. */
  start(): () => Promise<void> {
    const loop = async () => {
      while (!this.stopped) {
        await runWithTrace(async () => {
          try {
            await this.tick();
          } catch (error) {
            logger.error('tick failed; retrying next interval', error);
          }
        });
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
