import '@epoch/common/first-module';

import path from 'path';

import { Logger } from '@epoch/logger';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { PostgresConnectionManager } from '../PostgresConnectionManager';

const logger = Logger.create('RunMigration');

/** Applies every pending migration in packages/pg_models/migrations. */
export async function runMigrations(): Promise<void> {
  const db = PostgresConnectionManager.getDb();
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../migrations') });
  logger.info('migrations applied');
}

if (require.main === module) {
  runMigrations()
    .then(() => PostgresConnectionManager.close())
    .catch(async (error) => {
      logger.error('migration failed', error);
      await PostgresConnectionManager.close();
      process.exit(1);
    });
}
