import { Logger } from '@epoch/logger';
import { sql } from 'drizzle-orm';

import { solamiUsageReports } from '../db_models';
import { type EpochDb, PostgresConnectionManager } from '../PostgresConnectionManager';

const logger = Logger.create('SolamiUsageStore');

/** A component's usage report as stored (`@epoch/solana` SolamiUsageReport): JSON, keyed by its component. */
export interface StoredUsageReport {
  component: string;
  [field: string]: unknown;
}

export interface SolamiUsageRow {
  component: string;
  report: StoredUsageReport;
  updatedAt: Date;
}

/** solami_usage: each component upserts its own row; api_app reads them all for GET /v1/live/solami. */
export class SolamiUsageStore {
  constructor(private readonly db: EpochDb) {}

  async save(report: { readonly component: string }): Promise<void> {
    const now = new Date();
    await this.db
      .insert(solamiUsageReports)
      .values({ component: report.component, report, updatedAt: now })
      .onConflictDoUpdate({
        target: solamiUsageReports.component,
        set: { report: sql`excluded.report`, updatedAt: now },
      });
  }

  async all(): Promise<SolamiUsageRow[]> {
    const rows = await this.db.select().from(solamiUsageReports).orderBy(solamiUsageReports.component);
    return rows.map((row) => ({ ...row, report: row.report as StoredUsageReport }));
  }
}

/**
 * Writes a component's usage report every `intervalMs` when Postgres is configured (publisher_app, cranks_app);
 * returns the function that writes a last one and stops. Without DATABASE_URL it does nothing.
 */
export function startUsageWriter(
  report: () => { readonly component: string },
  intervalMs = 30_000,
): () => Promise<void> {
  if (!PostgresConnectionManager.isConfigured()) return async () => undefined;
  const store = new SolamiUsageStore(PostgresConnectionManager.getDb());
  const write = () =>
    store.save(report()).catch((error: unknown) => logger.debug('solami_usage write failed', { error: String(error) }));
  const timer = setInterval(() => void write(), intervalMs);
  timer.unref();
  void write();
  return async () => {
    clearInterval(timer);
    await write();
  };
}
