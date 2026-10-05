import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { BeamConfigSchema, loadConfig, PublisherConfigSchema } from '@epoch/config-sdk';
import { solToLamports } from '@epoch/epoch-sdk';
import { ConfigException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { beamRoute, ConnectionManager, loadKeypair, TransactionSender } from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

import { PublisherClient } from './Chain/PublisherClient';
import { IndexPublisher, type PublisherStep, QuoteMaker } from './Publishers';
import { PublisherLoop } from './PublisherLoop';
import { PgIndexStore } from './Repositories/EpochIndexRepository';

const logger = Logger.create('publisher_app');

async function main(): Promise<void> {
  const config = loadConfig(PublisherConfigSchema);
  const publisher = config.PUBLISHER_KEYPAIR_PATH ? loadKeypair(config.PUBLISHER_KEYPAIR_PATH) : undefined;
  const maker = config.MAKER_KEYPAIR_PATH ? loadKeypair(config.MAKER_KEYPAIR_PATH) : undefined;
  if (!publisher && !maker) {
    throw new ConfigException(
      'Nothing to run: set PUBLISHER_KEYPAIR_PATH (Fee Index) and/or MAKER_KEYPAIR_PATH (quotes)',
    );
  }
  if (publisher && !PostgresConnectionManager.isConfigured()) {
    throw new ConfigException('The index publisher reads epoch_index and slot_fees: set DATABASE_URL');
  }
  if (maker && config.EPOCH_MARKET_MAKER && config.EPOCH_MARKET_MAKER !== maker.publicKey.toBase58()) {
    logger.warn(
      'EPOCH_MARKET_MAKER is not the MAKER key: the API and the scorer will not see these quotes as Epoch’s',
      {
        EPOCH_MARKET_MAKER: config.EPOCH_MARKET_MAKER,
        maker: maker.publicKey.toBase58(),
      },
    );
  }

  const programId = new PublicKey(config.EPOCH_PROGRAM_ID);
  const connections = new ConnectionManager(config.EPOCH_RPC_URL, config.EPOCH_RPC_FALLBACK_URL);
  // Solami Beam for post_index on mainnet (SOLAMI_BEAM_URL): tipped, stake-weighted landing; off elsewhere.
  const beamConfig = loadConfig(BeamConfigSchema);
  const beam = beamRoute({
    url: beamConfig.SOLAMI_BEAM_URL,
    tipLamports: beamConfig.SOLAMI_BEAM_TIP_LAMPORTS,
    tipAddressesUrl: beamConfig.SOLAMI_TIP_ADDRESSES_URL,
    cluster: config.EPOCH_CLUSTER,
  });
  const chain = new PublisherClient({
    programId,
    connections,
    senders: {
      publisher: publisher ? new TransactionSender(connections, publisher, { beam }) : undefined,
      maker: maker ? new TransactionSender(connections, maker) : undefined,
    },
    computeUnitPriceMicroLamports: config.PUBLISHER_CU_PRICE_MICROLAMPORTS,
    dryRun: config.DRY_RUN,
  });

  const steps: PublisherStep[] = [];
  if (publisher) {
    const store = new PgIndexStore(PostgresConnectionManager.getDb());
    steps.push(new IndexPublisher(chain, store, { offset: config.FEE_INDEX_EPOCH_OFFSET }));
  }
  if (maker) {
    steps.push(
      new QuoteMaker(chain, {
        maxNotional: solToLamports(config.QUOTE_MAX_NOTIONAL_SOL),
        maxMoveBps: config.QUOTE_MAX_MOVE_BPS,
        epochsAhead: config.QUOTE_EPOCHS_AHEAD,
        spreadBps: config.QUOTE_SPREAD_BPS,
      }),
    );
  }

  const clock = await chain.clock();
  logger.info('publisher starting', {
    cluster: config.EPOCH_CLUSTER,
    programId: programId.toBase58(),
    publisher: publisher?.publicKey.toBase58() ?? null,
    maker: maker?.publicKey.toBase58() ?? null,
    feeIndexEpochOffset: config.FEE_INDEX_EPOCH_OFFSET,
    dryRun: config.DRY_RUN,
    beam: beam !== undefined,
    programEpoch: clock.epoch.toString(),
  });
  const loop = new PublisherLoop(steps, config.PUBLISHER_INTERVAL_SECONDS * 1_000);
  GracefulShutdown.register('publisher-loop', loop.start());
}

main().catch((error: unknown) => {
  logger.error('publisher_app failed to start', error);
  process.exit(1);
});
