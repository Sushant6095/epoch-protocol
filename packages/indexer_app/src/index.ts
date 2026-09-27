import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { GrpcConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { GrpcStream } from '@epoch/solana';

import { SlotStream } from './Streams/SlotStream';

const logger = Logger.create('indexer_app');

async function main(): Promise<void> {
  const config = loadConfig(GrpcConfigSchema);
  const endpoints = [{ name: 'solami', url: config.SOLAMI_GRPC_URL, token: config.SOLAMI_TOKEN }];
  if (config.RPC_FAST_GRPC_URL) {
    endpoints.push({ name: 'rpc-fast', url: config.RPC_FAST_GRPC_URL, token: config.RPC_FAST_TOKEN });
  }
  const stream = new GrpcStream(endpoints);
  GracefulShutdown.register('grpc', () => stream.stop());
  logger.info('starting', { endpoints: endpoints.map((e) => e.name) });
  await new SlotStream(stream).run();
}

void main();
