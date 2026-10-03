import '@epoch/common/first-module';

import { ExpressAppServer } from '@epoch/common_http_server';
import { ApiConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';

import { feeIndexRouter } from './Routes/FeeIndexRouter';
import { healthRouter } from './Routes/HealthRouter';
import { delegatorsRouter, networkRouter, validatorsRouter } from './Routes/MarketRouters';
import { getServices } from './Services';

const logger = Logger.create('api_app');

async function main(): Promise<void> {
  const config = loadConfig(ApiConfigSchema);
  const services = getServices();
  await new ExpressAppServer({ appName: 'api_app', port: config.API_PORT, corsOrigins: config.API_CORS_ORIGINS })
    .route('/health', healthRouter)
    .route('/v1/index', feeIndexRouter)
    .route('/v1/network', networkRouter)
    .route('/v1/validators', validatorsRouter)
    .route('/v1/delegators', delegatorsRouter)
    .start();

  // Warm the caches and name the stake pools, then start the stake-account scan (several minutes).
  services.labels
    .load()
    .catch((error: unknown) => logger.warn('delegator labels failed to load', { error: String(error) }));
  services.validators
    .get()
    .catch((error: unknown) => logger.warn('validator table warm-up failed', { error: String(error) }));
  services.scan.start();
}

void main();
