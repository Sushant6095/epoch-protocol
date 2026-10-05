import { LiveConfigSchema, loadConfig, SolamiApiConfigSchema } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { PostgresConnectionManager } from '@epoch/pg_models';

import { dbAvailable, requireDb } from '../../Lib/Db';
import { ValidatorNames } from '../Activity/ValidatorNames';
import { getServices } from '../index';
import { type StreamHub } from '../Stream/StreamHub';
import { LiveFeed } from './LiveFeed';
import { PgLiveRepository } from './LiveRepository';
import { LiveService } from './LiveService';

export { LiveFeed } from './LiveFeed';
export { LiveService } from './LiveService';

const logger = Logger.create('Live');

let service: LiveService | undefined;

/** /v1/live: built on first use; 503 DATABASE_NOT_CONFIGURED without DATABASE_URL. */
export function getLiveService(): LiveService {
  if (service) return service;
  requireDb();
  const services = getServices();
  const names = new ValidatorNames(async () => (await services.validators.get()).rows);
  service = new LiveService({
    repo: new PgLiveRepository(PostgresConnectionManager.getDb()),
    epochInfo: async () => ({
      ...(await services.market.epochInfo.get()),
      readAt: services.market.epochInfo.loadedAtMs,
    }),
    names: () => names.get(),
    staleAfterMs: loadConfig(LiveConfigSchema).LIVE_STALE_AFTER_SECONDS * 1_000,
    usageStaleMs: loadConfig(SolamiApiConfigSchema).SOLAMI_USAGE_STALE_SECONDS * 1_000,
  });
  return service;
}

/** Tests. */
export function setLiveService(next: LiveService | undefined): void {
  service = next;
}

/** LISTENs for the indexer's feed and serves the `slots` and `index:live` channels on WS /v1/stream. */
export function startLiveFeed(hub: StreamHub): LiveFeed | undefined {
  if (!dbAvailable() || !loadConfig(LiveConfigSchema).LIVE_FEED_ENABLED) {
    logger.info('live feed off (needs DATABASE_URL and LIVE_FEED_ENABLED)');
    return undefined;
  }
  const feed = new LiveFeed({ hub, service: getLiveService() });
  feed.start();
  return feed;
}
