import '@epoch/common/first-module';

import { GracefulShutdown } from '@epoch/common';
import { loadConfig, PantaBotConfigSchema } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { baseToUsdc, PantaClient, RequestBudget } from '@epoch/panta';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { ConnectionManager, loadKeypair } from '@epoch/solana';
import { type Keypair } from '@solana/web3.js';

import { LiveBotChain } from './Chain/BotChain';
import { MarketLifecycle } from './MarketLifecycle';
import { dryRunReasons, lifecycleConfig } from './Settings';
import { PgIndexHistory, PgMarketStore } from './Store/MarketStore';
import { TickLoop } from './TickLoop';

const logger = Logger.create('panta_bot_app');

/** RPC URLs often carry an API key: log the host only. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
};

async function main(): Promise<void> {
  const config = loadConfig(PantaBotConfigSchema);
  const hasDb = PostgresConnectionManager.isConfigured();
  const reasons = dryRunReasons(config, hasDb);

  // The keypair is read once and only ever used to sign; its path and bytes are never logged.
  let keypair: Keypair | undefined;
  if (config.PANTA_BOT_KEYPAIR_PATH) {
    try {
      keypair = loadKeypair(config.PANTA_BOT_KEYPAIR_PATH);
    } catch {
      reasons.push('PANTA_BOT_KEYPAIR_PATH does not point to a readable keypair file');
    }
  }
  const connections = new ConnectionManager(config.PANTA_RPC_URL, config.PANTA_RPC_FALLBACK_URL);
  const chain = new LiveBotChain({
    connections,
    keypair,
    usdcMint: config.PANTA_USDC_MINT,
    computeUnitPriceMicroLamports: config.PANTA_CU_PRICE_MICROLAMPORTS,
  });
  const panta = config.PANTA_API_KEY
    ? new PantaClient({
        baseUrl: config.PANTA_API_URL,
        apiKey: config.PANTA_API_KEY,
        timeoutMs: config.PANTA_TIMEOUT_MS,
        budget: new RequestBudget({ share: config.PANTA_BOT_RATE_LIMIT_SHARE }),
        // A background job can wait for budget and for Panta's Retry-After.
        maxBudgetWaitMs: 30_000,
        maxRetryWaitMs: 60_000,
      })
    : null;

  if (panta) {
    try {
      const account = await panta.account();
      logger.info('Panta account', { status: account.status, canCreateMarkets: account.canCreateMarkets });
      if (account.status !== 'active') reasons.push(`the Panta account is ${account.status}`);
      if (!account.canCreateMarkets) reasons.push('the Panta account may not create markets (canCreateMarkets: false)');
    } catch (error) {
      reasons.push(`the Panta account check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const settings = lifecycleConfig(config, reasons);
  const balances = await chain.balances().catch(() => null);
  logger.info('panta bot starting', {
    wallet: chain.wallet,
    usdc: balances ? baseToUsdc(BigInt(balances.usdcBase)) : null,
    sol: balances ? balances.lamports / 1e9 : null,
    rpc: hostOf(config.PANTA_RPC_URL),
    panta: hostOf(config.PANTA_API_URL),
    dryRun: settings.dryRun,
    dryRunReasons: reasons,
    marketsPerEpoch: settings.marketsPerEpoch,
    epochsAhead: settings.epochsAhead,
    budgetUsdcPerDay: config.PANTA_MAX_CREATE_USDC_PER_DAY,
    feeIndexAccount: settings.feeIndexAccount,
    publicApiUrl: settings.publicApiUrl,
    tickSeconds: config.PANTA_TICK_SECONDS,
  });

  const db = hasDb ? PostgresConnectionManager.getDb() : null;
  const lifecycle = new MarketLifecycle({
    config: settings,
    chain,
    panta,
    store: db ? new PgMarketStore(db) : null,
    history: db ? new PgIndexHistory(db) : null,
  });
  const loop = new TickLoop(() => lifecycle.tick(), config.PANTA_TICK_SECONDS * 1_000);
  GracefulShutdown.register('panta-bot-loop', loop.start());
}

main().catch((error: unknown) => {
  logger.error('panta_bot_app failed to start', error);
  process.exit(1);
});
