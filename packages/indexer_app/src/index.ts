import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { DatabaseConfigSchema, IndexerConfigSchema, loadConfig, normalizeGrpcUrl } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { type GrpcEndpoint } from '@epoch/solana';

import { PgIndexerStore } from './Repositories/IndexerStore';
import { rpcHost, SolanaRpc } from './Rpc/SolanaRpc';
import { SlotStream } from './Streams/SlotStream';

const logger = Logger.create('indexer_app');

async function main(): Promise<void> {
  const config = loadConfig(IndexerConfigSchema);
  loadConfig(DatabaseConfigSchema);
  // Solami RPC (with the key) for gap fill, leaders, stakes and the hybrid/rpc sources; public RPC without one.
  const rpc = new SolanaRpc(config.SOLAMI_RPC_URL ?? config.DATA_RPC_URL);
  const endpoints: GrpcEndpoint[] = [];
  if (config.SOLAMI_TOKEN) endpoints.push({ name: 'solami', url: config.SOLAMI_GRPC_URL, token: config.SOLAMI_TOKEN });
  if (config.RPC_FAST_GRPC_URL) {
    endpoints.push({ name: 'rpc-fast', url: normalizeGrpcUrl(config.RPC_FAST_GRPC_URL), token: config.RPC_FAST_TOKEN });
  }

  const stream = new SlotStream(
    {
      mode: config.SLOT_SOURCE,
      endpoints,
      compression: config.SOLAMI_GRPC_COMPRESSION === 'none' ? undefined : config.SOLAMI_GRPC_COMPRESSION,
      backfillEpoch: config.INDEXER_BACKFILL_EPOCH,
      gapFillRps: config.GAP_FILL_RPS,
      gapFillConcurrency: config.GAP_FILL_CONCURRENCY,
      gapFillMaxSlots: config.GAP_FILL_MAX_SLOTS,
      rpcPollMs: config.RPC_POLL_MS,
      stride: config.RPC_SLOT_STRIDE,
      liveIntervalMs: config.LIVE_INDEX_INTERVAL_MS,
      liveSlotsKeep: config.LIVE_SLOTS_KEEP,
    },
    { rpc, store: new PgIndexerStore(PostgresConnectionManager.getDb()) },
  );

  logger.info('starting', {
    slotSource: config.SLOT_SOURCE,
    grpc: endpoints.map((e) => `${e.name} (${rpcHost(e.url)})`),
    rpc: rpc.host,
    solamiRpc: config.SOLAMI_RPC_URL !== undefined,
    backfillEpoch: config.INDEXER_BACKFILL_EPOCH,
  });
  const running = stream.run();
  GracefulShutdown.register('slot-stream', async () => {
    stream.stop();
    await running.catch(() => undefined);
  });
  await running;
}

main().catch((error: unknown) => {
  logger.error('indexer_app stopped', error);
  void PostgresConnectionManager.close().finally(() => process.exit(1));
});
