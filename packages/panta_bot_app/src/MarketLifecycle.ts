import { Logger } from '@epoch/logger';

const logger = Logger.create('MarketLifecycle');

/** TODO(F10): resolve the finished epoch's market from epoch_index; create the next epoch's market. */
export class MarketLifecycle {
  async tick(): Promise<void> {
    logger.info('not implemented yet (F10)');
  }
}
