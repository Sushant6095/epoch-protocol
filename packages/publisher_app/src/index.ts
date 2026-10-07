import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { BeamConfigSchema, loadConfig, PublisherConfigSchema } from '@epoch/config-sdk';
import { solToLamports } from '@epoch/epoch-sdk';
import { ConfigException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { PostgresConnectionManager, startUsageWriter } from '@epoch/pg_models';
import { beamRoute, ConnectionManager, loadKeypair, solamiUsage, TransactionSender } from '@epoch/solana';
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
  // Operator keys vote once consensus is on; without INDEX_OPERATOR_KEYPAIR_PATHS the publisher key is the one voter.
  const operators =
    config.INDEX_OPERATOR_KEYPAIR_PATHS.length > 0
      ? config.INDEX_OPERATOR_KEYPAIR_PATHS.map((path) => loadKeypair(path))
      : publisher
        ? [publisher]
        : [];
  const indexing = publisher !== undefined || operators.length > 0;
  if (!indexing && !maker) {
    throw new ConfigException(
      'Nothing to run: set PUBLISHER_KEYPAIR_PATH or INDEX_OPERATOR_KEYPAIR_PATHS (Fee Index) and/or ' +
        'MAKER_KEYPAIR_PATH (quotes)',
    );
  }
  if (indexing && !PostgresConnectionManager.isConfigured()) {
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
  // Solami Beam for every transaction signed here on mainnet (SOLAMI_BEAM_URL): post_index and the maker's quotes go
  // out tipped through Beam's stake-weighted lane; off elsewhere. Sends, landings and tips go to solami_usage.
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
      maker: maker ? new TransactionSender(connections, maker, { beam }) : undefined,
    },
    operators: operators.map((operator) => new TransactionSender(connections, operator, { beam })),
    computeUnitPriceMicroLamports: config.PUBLISHER_CU_PRICE_MICROLAMPORTS,
    dryRun: config.DRY_RUN,
  });

  const steps: PublisherStep[] = [];
  if (indexing) {
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
    indexOperators: operators.map((operator) => operator.publicKey.toBase58()),
    maker: maker?.publicKey.toBase58() ?? null,
    feeIndexEpochOffset: config.FEE_INDEX_EPOCH_OFFSET,
    dryRun: config.DRY_RUN,
    beam: beam !== undefined,
    programEpoch: clock.epoch.toString(),
  });
  const loop = new PublisherLoop(steps, config.PUBLISHER_INTERVAL_SECONDS * 1_000);
  GracefulShutdown.register('publisher-loop', loop.start());
  // GET /v1/live/solami shows this process's Beam sends and RPC use as the `publisher` component.
  solamiUsage.setComponent('publisher');
  GracefulShutdown.register(
    'solami-usage',
    startUsageWriter(() => solamiUsage.report()),
  );
}

main().catch((error: unknown) => {
  logger.error('publisher_app failed to start', error);
  process.exit(1);
});
