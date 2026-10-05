import { GracefulShutdown } from '@epoch/common';
import { loadConfig, type PantaTradingConfig, PantaTradingConfigSchema } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { type PantaApi, PantaClient, RequestBudget } from '@epoch/panta';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { ConnectionManager } from '@epoch/solana';

import { dbAvailable } from '../../Lib/Db';
import { PeriodicJob } from '../../Lib/PeriodicJob';
import { RateLimiter } from '../../Lib/RateLimiter';
import { getProgramEventServices } from '../Program/ProgramEventServices';
import { LivePantaChain, type PantaChain } from './PantaChain';
import { PantaService } from './PantaService';
import {
  type IndexReads,
  type PantaMarketReader,
  type PantaTradeStore,
  PgIndexReads,
  PgPantaMarketReader,
  PgPantaTradeStore,
} from './PantaStores';
import { PANTA_CHANNEL, type PantaStreamHub, PantaStreamPoller } from './PantaStreamPoller';
import { type FinalIndexReader, IndexSnapshotSource } from './PantaSupport';

const logger = Logger.create('PantaServices');

/** How long after a submit the attribution job looks (a transaction usually confirms within seconds). */
const ATTRIBUTION_NUDGE_MS = 8_000;

/** Our own per-IP and per-wallet limits, on top of Panta's per-account budget (RequestBudget). */
export interface PantaLimits {
  /** GET routes, per IP. */
  read: RateLimiter;
  /** POST quote, per IP (Panta allows 30 quotes a minute for the whole app). */
  quote: RateLimiter;
  /** POST build, submit, claim/build, per IP. */
  trade: RateLimiter;
  /** POST build and claim/build, per signed-in wallet (Panta allows 20 builds a minute for the whole app). */
  build: RateLimiter;
  /** POST submit, per signed-in wallet. */
  submit: RateLimiter;
}

/** Real-money Predict through Panta: the service, its limits, the attribution job and the stream poller. */
export interface PantaServices {
  config: PantaTradingConfig;
  service: PantaService;
  limits: PantaLimits;
  /** Follows submitted trades on chain and reports every confirmed one to Panta (attribution). */
  attribution: PeriodicJob;
}

export interface PantaDeps {
  env?: NodeJS.ProcessEnv;
  panta?: PantaApi;
  chain?: PantaChain;
  trades?: PantaTradeStore | null;
  markets?: PantaMarketReader | null;
  reads?: IndexReads | null;
  finals?: FinalIndexReader | null;
  now?: () => number;
}

export function buildPantaServices(deps: PantaDeps = {}): PantaServices {
  const config = loadConfig(PantaTradingConfigSchema, deps.env ?? process.env);
  const now = deps.now ?? Date.now;
  const panta =
    deps.panta ??
    new PantaClient({
      baseUrl: config.PANTA_API_URL,
      apiKey: config.PANTA_API_KEY,
      timeoutMs: config.PANTA_TIMEOUT_MS,
      budget: new RequestBudget({ share: config.PANTA_RATE_LIMIT_SHARE }),
      // A user is waiting: fail fast rather than queue behind the budget or a long Retry-After.
      maxBudgetWaitMs: 0,
      maxRetries: 1,
      maxRetryWaitMs: 3_000,
    });
  const chain =
    deps.chain ?? new LivePantaChain(new ConnectionManager(config.PANTA_RPC_URL, config.PANTA_RPC_FALLBACK_URL));
  const db = dbAvailable() ? () => PostgresConnectionManager.getDb() : null;
  const trades = deps.trades !== undefined ? deps.trades : db ? new PgPantaTradeStore(db) : null;
  const markets = deps.markets !== undefined ? deps.markets : db ? new PgPantaMarketReader(db) : null;
  const reads = deps.reads !== undefined ? deps.reads : db ? new PgIndexReads(db) : null;
  const finals =
    deps.finals !== undefined
      ? deps.finals
      : { latestFinal: async () => (await getProgramEventServices().feeIndex.latest()).final };

  const service = new PantaService({
    panta,
    config,
    trades,
    markets,
    index: new IndexSnapshotSource(reads, finals, config.PANTA_MODEL_LOOKBACK_EPOCHS, now),
    chain,
    now,
    // A submit nudges the attribution job a few seconds later, once the transaction has had time to land (the
    // periodic run covers it anyway). `attribution` is declared below; this only runs once requests flow.
    onSubmitted: () => {
      setTimeout(() => void attribution.runNow(), ATTRIBUTION_NUDGE_MS).unref();
    },
  });
  const attribution = new PeriodicJob(
    'panta-attribution',
    config.PANTA_ATTRIBUTION_INTERVAL_SECONDS * 1_000,
    () => service.reconcile(),
    10_000,
  );
  return {
    config,
    service,
    attribution,
    limits: {
      read: new RateLimiter(120, 60_000, now),
      quote: new RateLimiter(20, 60_000, now),
      trade: new RateLimiter(30, 60_000, now),
      build: new RateLimiter(10, 60_000, now),
      submit: new RateLimiter(20, 60_000, now),
    },
  };
}

let services: PantaServices | undefined;

/** One set per process, built on first use. */
export function getPantaServices(): PantaServices {
  if (!services) services = buildPantaServices();
  return services;
}

/** Tests: swap in services built from fakes (or undefined to rebuild from the environment). */
export function setPantaServices(next: PantaServices | undefined): void {
  services = next;
}

/**
 * Starts the attribution job (needs Postgres and the API key) and the `predict:panta` stream channel (needs the key).
 * A bad Panta configuration is logged and leaves Panta off; it never stops the API.
 */
export function startPantaJobs(
  hub?: PantaStreamHub & { setProvider: (channel: typeof PANTA_CHANNEL, provider: () => Promise<unknown>) => void },
): void {
  let resolved: PantaServices;
  try {
    resolved = getPantaServices();
  } catch (error) {
    logger.error('Panta is off: invalid PANTA_* configuration', error);
    return;
  }
  const { service, config, attribution } = resolved;
  if (!config.PANTA_API_KEY) {
    logger.info('PANTA_API_KEY unset: real-money Predict answers 503 PANTA_NOT_CONFIGURED');
    return;
  }
  logger.info('real-money Predict through Panta', {
    trading: service.tradingEnabled,
    blockedCountries: config.PANTA_BLOCKED_COUNTRIES,
    rateLimitShare: config.PANTA_RATE_LIMIT_SHARE,
  });
  if (dbAvailable()) {
    attribution.start();
    GracefulShutdown.register('panta-attribution', () => attribution.stop());
  } else {
    logger.warn('DATABASE_URL unset: Panta trades cannot be recorded, so trading answers 503');
  }
  if (hub) {
    hub.setProvider(PANTA_CHANNEL, () => service.streamSnapshot());
    const poller = new PantaStreamPoller({
      hub,
      refresh: () => service.refreshPrices(),
      intervalMs: config.PANTA_STREAM_INTERVAL_SECONDS * 1_000,
    });
    poller.start();
    GracefulShutdown.register('panta-stream', () => poller.stop());
  }
}
