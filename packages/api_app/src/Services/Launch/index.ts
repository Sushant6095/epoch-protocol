import { type LaunchConfig, LaunchConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { ConnectionManager } from '@epoch/solana';

import { getServices } from '..';
import { dbAvailable } from '../../Lib/Db';
import { RpcLaunchChainReader } from './LaunchChain';
import { type LaunchPriceStore, PgLaunchPriceStore } from './LaunchPriceStore';
import { LaunchPriceSampler } from './LaunchPriceSampler';
import { LaunchRegistry } from './LaunchRegistry';
import { validatorTableRevenue } from './LaunchRevenue';
import { LaunchService } from './LaunchService';

const logger = Logger.create('Launches');

export interface LaunchServices {
  config: LaunchConfig;
  launches: LaunchService;
  /** launch_price_samples; null without DATABASE_URL. */
  prices: LaunchPriceStore | null;
}

let launchServices: LaunchServices | undefined;

/** The revenue-token services (request #22), built from LaunchConfig on first use. */
export function getLaunchServices(): LaunchServices {
  if (launchServices) return launchServices;
  const config = loadConfig(LaunchConfigSchema);
  const prices = dbAvailable() ? new PgLaunchPriceStore(PostgresConnectionManager.getDb()) : null;
  const launches = new LaunchService({
    registry: new LaunchRegistry(config.LAUNCHES_PATH),
    reader: new RpcLaunchChainReader(
      new ConnectionManager(config.LAUNCH_RPC_URL, config.LAUNCH_RPC_FALLBACK_URL, 'confirmed'),
    ),
    revenue: validatorTableRevenue(() => getServices().validators.get()),
    prices,
    network: config.LAUNCH_CLUSTER,
    cacheMs: config.LAUNCH_CACHE_SECONDS * 1_000,
    holdersCacheMs: config.LAUNCH_HOLDERS_CACHE_MINUTES * 60_000,
  });
  launchServices = { config, launches, prices };
  return launchServices;
}

/** Starts the price sampler when it can run: enabled, a registry (LAUNCHES_PATH) and Postgres (DATABASE_URL). */
export function startLaunchPriceSampler(): LaunchPriceSampler | undefined {
  const { config, launches, prices } = getLaunchServices();
  if (!config.LAUNCH_SAMPLER_ENABLED) {
    logger.info('launch price sampler disabled (LAUNCH_SAMPLER_ENABLED=false)');
    return undefined;
  }
  if (!config.LAUNCHES_PATH || !prices) {
    logger.info('launch price sampler off: it needs LAUNCHES_PATH and DATABASE_URL');
    return undefined;
  }
  const sampler = new LaunchPriceSampler(launches, prices, config.LAUNCH_SAMPLE_SECONDS * 1_000);
  sampler.start();
  return sampler;
}
