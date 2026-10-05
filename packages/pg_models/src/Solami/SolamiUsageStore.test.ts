import { TransactionRollbackError } from 'drizzle-orm';

import { runMigrations } from '../MigrationManager/RunMigration';
import { type EpochDb, PostgresConnectionManager } from '../PostgresConnectionManager';
import { SolamiUsageStore } from './SolamiUsageStore';

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('SolamiUsageStore (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  /** Rolled back: CI runs test files in parallel against one database. */
  const inRollback = (test: (db: EpochDb) => Promise<void>) =>
    PostgresConnectionManager.getDb()
      .transaction(
        async (tx) => {
          await test(tx as unknown as EpochDb);
          tx.rollback();
        },
        { isolationLevel: 'repeatable read' },
      )
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

  it('keeps one report per component, the newest one', () =>
    inRollback(async (db) => {
      const store = new SolamiUsageStore(db);
      await store.save({ component: 'test-indexer', grpc: { bytes: 1 } });
      await store.save({ component: 'test-indexer', grpc: { bytes: 2 }, rpc: [] });
      await store.save({ component: 'test-publisher', beam: { sends: 1 } });
      const rows = (await store.all()).filter((r) => r.component.startsWith('test-'));
      expect(rows.map((r) => [r.component, r.report])).toEqual([
        ['test-indexer', { component: 'test-indexer', grpc: { bytes: 2 }, rpc: [] }],
        ['test-publisher', { component: 'test-publisher', beam: { sends: 1 } }],
      ]);
      expect(rows[0].updatedAt).toBeInstanceOf(Date);
    }));
});
