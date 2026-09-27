import { Logger } from '@epoch/logger';

import { type Job } from './Job';

const logger = Logger.create('SweepJob');

/** Calls sweep for every validator with an open advance. */
export class SweepJob implements Job {
  readonly name = 'SweepJob';

  async run(epoch: number): Promise<void> {
    // TODO(F3): build and send the instruction(s) via @epoch/epoch-sdk + TransactionSender.
    logger.info('not implemented yet', { epoch });
  }
}
