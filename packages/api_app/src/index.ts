import '@epoch/common/first-module';

import { ExpressAppServer } from '@epoch/common_http_server';
import { ApiConfigSchema, loadConfig } from '@epoch/config-sdk';

import { feeIndexRouter } from './Routes/FeeIndexRouter';
import { healthRouter } from './Routes/HealthRouter';

async function main(): Promise<void> {
  const config = loadConfig(ApiConfigSchema);
  await new ExpressAppServer({ appName: 'api_app', port: config.API_PORT, corsOrigins: config.API_CORS_ORIGINS })
    .route('/health', healthRouter)
    .route('/v1/index', feeIndexRouter)
    .start();
}

void main();
