import { ServiceUnavailableException } from '@epoch/exceptions';
import { type EpochDb, PostgresConnectionManager } from '@epoch/pg_models';

/** True when DATABASE_URL is set. */
export const dbAvailable = (): boolean => PostgresConnectionManager.isConfigured();

/** The drizzle instance; 503 DATABASE_NOT_CONFIGURED when DATABASE_URL is unset (sign-in, watchlist, alerts, Predict). */
export function requireDb(): EpochDb {
  if (!dbAvailable()) {
    throw new ServiceUnavailableException('This feature needs Postgres: set DATABASE_URL', 'DATABASE_NOT_CONFIGURED');
  }
  return PostgresConnectionManager.getDb();
}
