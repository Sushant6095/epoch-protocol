import { type EpochDb, poolSnapshots } from '@epoch/pg_models';
import { desc } from 'drizzle-orm';

import { type PoolHistory, type PoolHistoryPoint } from './ProgramSources';

/** `pool_snapshots`, written by the recorder at each `Accrued` event. */
export class PgPoolHistory implements PoolHistory {
  constructor(private readonly db: EpochDb) {}

  /** The newest `limit` snapshots, oldest first. */
  async recent(limit: number): Promise<PoolHistoryPoint[]> {
    const rows = await this.db
      .select({
        epoch: poolSnapshots.epoch,
        seniorPriceE9: poolSnapshots.seniorPriceE9,
        juniorPriceE9: poolSnapshots.juniorPriceE9,
        utilizationBps: poolSnapshots.utilizationBps,
      })
      .from(poolSnapshots)
      .orderBy(desc(poolSnapshots.epoch))
      .limit(limit);
    return rows.reverse().map((row) => ({
      epoch: row.epoch,
      seniorPriceE9: BigInt(row.seniorPriceE9),
      juniorPriceE9: BigInt(row.juniorPriceE9),
      utilizationBps: row.utilizationBps,
    }));
  }
}
