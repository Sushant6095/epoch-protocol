import '@epoch/common/first-module';

import { Logger } from '@epoch/logger';

import { MarketLifecycle } from './MarketLifecycle';

const logger = Logger.create('panta_bot_app');

async function main(): Promise<void> {
  logger.info('starting');
  await new MarketLifecycle().tick();
}

void main();
