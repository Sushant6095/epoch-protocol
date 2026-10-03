import { PostgresConnectionManager, poolSnapshots, runMigrations } from '@epoch/pg_models';

import { PgPoolHistory } from './PoolHistory';

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('PgPoolHistory (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  it('reads the newest snapshots, oldest first', async () => {
    const db = PostgresConnectionManager.getDb();
    await db.delete(poolSnapshots);
    const row = (epoch: number, utilizationBps: number) => ({
      epoch,
      seniorAssets: 1_124_000_000_000n,
      seniorShares: 1_120_000_000_000_000n,
      juniorAssets: 509_000_000_000n,
      juniorShares: 503_700_000_000_000n,
      outstandingPrincipal: 189_520_000_000n,
      cash: 1_443_480_000_000n,
      seniorPriceE9: 1_000_000 + epoch,
      juniorPriceE9: 1_000_000 + 2 * epoch,
      utilizationBps,
    });
    await db.insert(poolSnapshots).values([row(1042, 1_040), row(1043, 1_120), row(1044, 1_160)]);

    const points = await new PgPoolHistory(db).recent(2);
    expect(points).toEqual([
      { epoch: 1043, seniorPriceE9: 1_001_043n, juniorPriceE9: 1_002_086n, utilizationBps: 1_120 },
      { epoch: 1044, seniorPriceE9: 1_001_044n, juniorPriceE9: 1_002_088n, utilizationBps: 1_160 },
    ]);
    await db.delete(poolSnapshots);
  });
});
