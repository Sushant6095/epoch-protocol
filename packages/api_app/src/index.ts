import '@epoch/common/first-module';

import { ExpressAppServer } from '@epoch/common_http_server';
import { ApiConfigSchema, AuthConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';

import { dbAvailable } from './Lib/Db';
import { authRouter, meRouter, predictRouter, sessionMiddleware } from './Routes/AccountRouters';
import { activityRouter } from './Routes/ActivityRouters';
import { buybackRouter } from './Routes/BuybackRouters';
import { feeIndexRouter } from './Routes/FeeIndexRouter';
import { healthRouter } from './Routes/HealthRouter';
import { indiaRouter } from './Routes/IndiaRouters';
import { launchPageRouter } from './Routes/LaunchPageRouters';
import { launchRouter } from './Routes/LaunchRouters';
import { liveRouter } from './Routes/LiveRouter';
import { delegatorsRouter, networkRouter, validatorsRouter } from './Routes/MarketRouters';
import { feeIndexEpochRouter, pantaRouter } from './Routes/PantaRouters';
import { lenderRouter, marketRouter, validatorPositionRouter, vaultRouter } from './Routes/ProgramRouters';
import { walletStakeRouter } from './Routes/WalletRouters';
import { getServices } from './Services';
import { startAccountJobs } from './Services/Account';
import { startLaunchPriceSampler } from './Services/Launch';
import { startLaunchLive } from './Services/Launch/LaunchLive';
import { startLiveFeed } from './Services/Live';
import { startPantaJobs } from './Services/Panta';
import { getProgramEventServices } from './Services/Program/ProgramEventServices';
import { getProgramServices } from './Services/Program/ProgramServices';

const logger = Logger.create('api_app');

async function main(): Promise<void> {
  const config = loadConfig(ApiConfigSchema);
  const auth = loadConfig(AuthConfigSchema);
  const services = getServices();
  const server = new ExpressAppServer({
    appName: 'api_app',
    port: config.API_PORT,
    corsOrigins: config.API_CORS_ORIGINS,
    trustProxy: auth.API_TRUST_PROXY,
  })
    // Sign-in session from the cookie, for every route below (requests #7, #11, #14, #15).
    .use(sessionMiddleware)
    .route('/health', healthRouter)
    // Mainnet data: network, validators and their profiles, delegators, a wallet's stake (requests #1–#6, #10).
    .route('/v1/index', feeIndexRouter)
    // One mainnet epoch's Fee Index and status: the resolution source of Epoch's Panta markets.
    .route('/v1/index/epochs', feeIndexEpochRouter)
    .route('/v1/network', networkRouter)
    .route('/v1/validators', validatorsRouter)
    .route('/v1/delegators', delegatorsRouter)
    .route('/v1/wallets', walletStakeRouter)
    // The Epoch program (devnet): activity, Vault, Manage tab, lender position, Fee Market (requests #4, #8, #19).
    .route('/v1/activity', activityRouter)
    .route('/v1/vault', vaultRouter)
    .route('/v1/validators', validatorPositionRouter)
    .route('/v1/wallets', lenderRouter)
    .route('/v1/market', marketRouter)
    // Revenue-token launches on Meteora (request #22).
    .route('/v1/launches', launchRouter)
    // Meteora track: buybacks at source (escrow, schedule, burns) from the program's revenue-token events.
    .route('/v1/launches', buybackRouter)
    // Meteora track: the Launch page's live data: market, trades, candles, holders, fees, buy/sell (plan F13).
    .route('/v1/launches', launchPageRouter)
    // Superteam India track: SOL in ₹, validators hosted in India, rewards per Indian FY.
    .route('/v1/india', indiaRouter)
    // Sign-in, watchlist, alerts and Predict (requests #7, #11, #14, #15).
    .route('/v1/auth', authRouter)
    .route('/v1/me', meRouter)
    .route('/v1/predict', predictRouter)
    // Panta track: real-money Predict, USDC markets through Panta on Solana mainnet (decision of 3 Oct 2026).
    .route('/v1/predict/panta', pantaRouter)
    // Solami track: the Fee Index computed live from mainnet blocks streamed through Solami (indexer_app).
    .route('/v1/live', liveRouter);
  await server.start();

  // ── Program events, Fee Index status and WS /v1/stream (requests #3, #4) ──
  // The recorder listens before the ingester announces its backfill; the hub serves upgrades on the same port.
  const events = getProgramEventServices();
  if (services.program.configured) {
    const vault = getProgramServices().vault;
    events.stream.setProvider('vault', () => vault.snapshot());
  }
  events.recorder.start();
  events.ingester.start();
  if (server.httpServer) events.stream.attach(server.httpServer);
  // Panta track: trade attribution job and the WS `predict:panta` channel (needs PANTA_API_KEY).
  startPantaJobs(events.stream);

  // Warm the caches and name the stake pools, then start the stake-account scan (several minutes).
  services.labels
    .load()
    .catch((error: unknown) => logger.warn('delegator labels failed to load', { error: String(error) }));
  services.validators
    .get()
    .catch((error: unknown) => logger.warn('validator table warm-up failed', { error: String(error) }));
  services.scan.start();

  // Validator profiles: every validator's inflation rewards for 10 epochs, then commission and stake per validator per
  // epoch in Postgres (request #5b).
  services.voteRewards.start();
  if (dbAvailable()) services.history.start();

  // Alert sender, Telegram linker, Predict market maker and resolver: they need Postgres.
  if (dbAvailable()) startAccountJobs();
  else logger.info('DATABASE_URL unset: sign-in, watchlist, alerts and Predict answer 503 DATABASE_NOT_CONFIGURED');

  // Revenue-token launches (request #22): sample their prices every minute (needs LAUNCHES_PATH and DATABASE_URL).
  startLaunchPriceSampler();
  // Meteora track, the Launch page (plan F13): read the pools' trades into launch_trades and stream them on WS
  // `launch:<mint>`.
  startLaunchLive(events.stream);

  // Solami track: LISTEN for the indexer's live feed → WS `slots` and `index:live` (needs DATABASE_URL).
  startLiveFeed(events.stream);
}

void main();
