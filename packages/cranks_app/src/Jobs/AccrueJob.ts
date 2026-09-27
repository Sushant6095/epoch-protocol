import { Logger } from '@epoch/logger';

import { type Job } from './Job';

const logger = Logger.create('AccrueJob');

/** Accrues senior/junior share prices after all sweeps. */
export class AccrueJob implements Job {
  readonly name = 'AccrueJob';

  async run(epoch: number): Promise<void> {
    // TODO(F2): build and send the instruction(s) via @epoch/epoch-sdk + TransactionSender.
    logger.info('not implemented yet', { epoch });
  }
}
