import { Logger } from '@epoch/logger';

import { type Job } from './Job';

const logger = Logger.create('ClaimMevJob');

/** Claims each borrower's Jito tip commission to its vote account. */
export class ClaimMevJob implements Job {
  readonly name = 'ClaimMevJob';

  async run(epoch: number): Promise<void> {
    // TODO(F8): build and send the instruction(s) via @epoch/epoch-sdk + TransactionSender.
    logger.info('not implemented yet', { epoch });
  }
}
