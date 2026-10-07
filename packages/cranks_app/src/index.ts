import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import {
  BeamConfigSchema,
  BuybackConfigSchema,
  CranksConfigSchema,
  LaunchClaimsConfigSchema,
  loadConfig,
} from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { startUsageWriter } from '@epoch/pg_models';
import { beamRoute, ConnectionManager, loadKeypair, solamiUsage, TransactionSender } from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

import { MeteoraBuybackMarket } from './Chain/BuybackMarket';
import { MainnetData } from './Chain/MainnetData';
import { ProgramClient } from './Chain/ProgramClient';
import { JobRunner } from './JobRunner';
import { startLaunchFeeClaims } from './launchClaims';

const logger = Logger.create('cranks_app');

async function main(): Promise<void> {
  const config = loadConfig(CranksConfigSchema);
  const buyback = loadConfig(BuybackConfigSchema);
  const programId = new PublicKey(config.EPOCH_PROGRAM_ID);
  const connections = new ConnectionManager(config.EPOCH_RPC_URL, config.EPOCH_RPC_FALLBACK_URL);
  const crank = loadKeypair(config.CRANK_KEYPAIR_PATH);
  const scorer = config.SCORER_KEYPAIR_PATH ? loadKeypair(config.SCORER_KEYPAIR_PATH) : undefined;
  const hedgeMakers = config.EPOCH_MARKET_MAKER ? [new PublicKey(config.EPOCH_MARKET_MAKER)] : [];
  // Solami Beam for every crank transaction on mainnet (SOLAMI_BEAM_URL): sweeps, accruals, buyback slices,
  // settlements, finalization and treasury claims go out tipped through Beam's stake-weighted lane; off elsewhere.
  const beamConfig = loadConfig(BeamConfigSchema);
  const beam = beamRoute({
    url: beamConfig.SOLAMI_BEAM_URL,
    tipLamports: beamConfig.SOLAMI_BEAM_TIP_LAMPORTS,
    tipAddressesUrl: beamConfig.SOLAMI_TIP_ADDRESSES_URL,
    cluster: config.EPOCH_CLUSTER,
  });

  const chain = new ProgramClient({
    programId,
    connections,
    sender: new TransactionSender(connections, crank, { beam }),
    scorer,
    computeUnitPriceMicroLamports: config.CRANK_CU_PRICE_MICROLAMPORTS,
    dryRun: config.DRY_RUN,
  });
  const data = new MainnetData(
    new ConnectionManager(config.DATA_RPC_URL, config.DATA_RPC_FALLBACK_URL),
    config.JITO_KOBE_API_URL,
  );
  const runner = JobRunner.create(
    chain,
    data,
    hedgeMakers,
    { pollMs: config.CRANK_POLL_SECONDS * 1_000, alertAfterMs: config.CRANK_ALERT_AFTER_MINUTES * 60_000 },
    // Revenue-token buybacks trade on the program's cluster (the tokens' Meteora pools live there too).
    buyback.BUYBACK_ENABLED
      ? {
          market: new MeteoraBuybackMarket(connections),
          options: {
            slippageBps: buyback.BUYBACK_SLIPPAGE_BPS,
            maxAttempts: buyback.BUYBACK_MAX_ATTEMPTS,
            computeUnitLimit: buyback.BUYBACK_COMPUTE_UNITS,
          },
        }
      : undefined,
    { watchlist: config.HISTORY_WATCHLIST.map((vote) => new PublicKey(vote)) },
    { tipDistributionProgramId: config.JITO_TIP_DISTRIBUTION_PROGRAM_ID, waitMinutes: config.MEV_CLAIM_WAIT_MINUTES },
  );

  const clock = await chain.clock();
  logger.info('cranks starting', {
    cluster: config.EPOCH_CLUSTER,
    programId: programId.toBase58(),
    crank: crank.publicKey.toBase58(),
    scorer: scorer?.publicKey.toBase58() ?? null,
    hedgeMakers: hedgeMakers.map((m) => m.toBase58()),
    dryRun: config.DRY_RUN,
    buybacks: buyback.BUYBACK_ENABLED ? { slippageBps: buyback.BUYBACK_SLIPPAGE_BPS } : false,
    beam: beam !== undefined,
    epoch: clock.epoch.toString(),
  });
  GracefulShutdown.register('job-runner', runner.start());
  // GET /v1/live/solami shows this process's Beam sends as the `cranks` component (needs DATABASE_URL).
  solamiUsage.setComponent('cranks');
  GracefulShutdown.register(
    'solami-usage',
    startUsageWriter(() => solamiUsage.report()),
  );

  // Revenue-token fee claims (plan F13): their own loop, cluster and keys; off unless LAUNCH_CLAIMS_ENABLED=true. The
  // partner treasury's claims go through the program, sent by this crank. A bad claims configuration is logged; it
  // never stops the program's cranks.
  try {
    startLaunchFeeClaims(loadConfig(LaunchClaimsConfigSchema), {
      programId,
      cluster: config.EPOCH_CLUSTER,
      cranker: crank,
    });
  } catch (error) {
    logger.error('launch fee claims not started', error);
  }
}

main().catch((error: unknown) => {
  logger.error('cranks_app failed to start', error);
  process.exit(1);
});
