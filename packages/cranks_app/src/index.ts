import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { BuybackConfigSchema, CranksConfigSchema, LaunchClaimsConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { ConnectionManager, loadKeypair, TransactionSender } from '@epoch/solana';
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

  const chain = new ProgramClient({
    programId,
    connections,
    sender: new TransactionSender(connections, crank),
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
    epoch: clock.epoch.toString(),
  });
  GracefulShutdown.register('job-runner', runner.start());

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
