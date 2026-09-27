import { Logger } from '@epoch/logger';

import { AccrueJob, ClaimMevJob, type Job, SettleEpochJob, SweepJob, UpdateScoreJob } from './Jobs';

const logger = Logger.create('JobRunner');

/** Runs the epoch-boundary jobs in the order the program enforces. */
export class JobRunner {
  constructor(
    private readonly jobs: Job[] = [
      new ClaimMevJob(),
      new UpdateScoreJob(),
      new SweepJob(),
      new SettleEpochJob(),
      new AccrueJob(),
    ],
  ) {}

  async runBoundary(epoch: number): Promise<void> {
    logger.info('epoch boundary', { epoch });
    for (const job of this.jobs) {
      const started = Date.now();
      try {
        await job.run(epoch);
        logger.info('job done', { job: job.name, ms: Date.now() - started });
      } catch (error) {
        logger.error('job failed; later jobs still run, the next boundary retries', error, { job: job.name });
      }
    }
  }
}
