import { Logger } from '@epoch/logger';

import { type Job } from './Job';

const logger = Logger.create('SettleEpochJob');

/** Settles the previous epoch's fee swaps once its index is posted. */
export class SettleEpochJob implements Job {
  readonly name = 'SettleEpochJob';

  async run(epoch: number): Promise<void> {
    // TODO(F7): build and send the instruction(s) via @epoch/epoch-sdk + TransactionSender.
    logger.info('not implemented yet', { epoch });
  }
}
