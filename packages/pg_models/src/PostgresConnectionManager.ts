import { GracefulShutdown } from '@epoch/common';
import { DatabaseConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './db_models/schema';

export type EpochDb = NodePgDatabase<typeof schema>;

const logger = Logger.create('PostgresConnectionManager');

/** One pool and one drizzle instance per process. */
export class PostgresConnectionManager {
  private static pool?: Pool;
  private static db?: EpochDb;

  static getDb(): EpochDb {
    if (!this.db) {
      const config = loadConfig(DatabaseConfigSchema);
      this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_SIZE });
      this.pool.on('error', (error) => logger.error('Postgres pool error', error));
      this.db = drizzle(this.pool, { schema });
      GracefulShutdown.register('postgres', () => this.close());
    }
    return this.db;
  }

  static async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
    this.db = undefined;
  }
}
