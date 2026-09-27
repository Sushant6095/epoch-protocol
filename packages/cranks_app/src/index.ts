import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { loadConfig, SolanaConfigSchema } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { ConnectionManager, EpochClock } from '@epoch/solana';

import { JobRunner } from './JobRunner';

const logger = Logger.create('cranks_app');

async function main(): Promise<void> {
  const config = loadConfig(SolanaConfigSchema);
  const clock = new EpochClock(new ConnectionManager(config.RPC_URL, config.RPC_FALLBACK_URL));
  const runner = new JobRunner();
  const stop = clock.watch((epoch) => runner.runBoundary(epoch));
  GracefulShutdown.register('epoch-clock', stop);
  logger.info('watching for epoch boundaries', { epoch: (await clock.now()).epoch });
}

void main();
