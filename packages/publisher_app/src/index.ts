import '@epoch/common/first-module';

import { Logger } from '@epoch/logger';

import { IndexPublisher } from './Publishers/IndexPublisher';

const logger = Logger.create('publisher_app');

async function main(): Promise<void> {
  logger.info('starting');
  await new IndexPublisher().publishLatest();
}

void main();
