import { Logger } from '@epoch/logger';

import { type Job } from './Job';

const logger = Logger.create('UpdateScoreJob');

/** Calls update_score for every validator position (after epoch rewards finish). */
export class UpdateScoreJob implements Job {
  readonly name = 'UpdateScoreJob';

  async run(epoch: number): Promise<void> {
    // TODO(F3): build and send the instruction(s) via @epoch/epoch-sdk + TransactionSender.
    logger.info('not implemented yet', { epoch });
  }
}
