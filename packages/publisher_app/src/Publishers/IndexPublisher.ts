import { Logger } from '@epoch/logger';

const logger = Logger.create('IndexPublisher');

/** TODO(F9): read the latest finished epoch from epoch_index, call post_index, update the Switchboard feed. */
export class IndexPublisher {
  async publishLatest(): Promise<void> {
    logger.info('not implemented yet (F9)');
  }
}
