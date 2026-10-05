import {
  type EpochDb,
  epochIndex,
  epochStakes,
  feeIndexLive,
  liveSlots,
  SolamiUsageStore,
  type SolamiUsageRow,
} from '@epoch/pg_models';
import { asc, desc, eq, gte, lt, sql } from 'drizzle-orm';

export type FeeIndexLiveRow = typeof feeIndexLive.$inferSelect;
export type LiveSlotRow = typeof liveSlots.$inferSelect;

export interface EpochIndexRow {
  epoch: number;
  value: number;
  postedSignature: string | null;
  computedAt: Date;
}

export interface LeaderStat {
  leader: string;
  slots: number;
  /** Median of the leader's slot medians (⌊(a + b) / 2⌋ for an even count, as the indexer computes it). */
  medianCuPrice: number;
  pricedTxs: number;
}

export interface DistributionRows {
  slots: number;
  /** Bucket b holds slot medians in [10^(b/4), 10^((b+1)/4)). */
  buckets: { bucket: number; slots: number }[];
  percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number } | null;
}

/** What /v1/live reads from Postgres (an in-memory fake in tests). */
export interface LiveRepository {
  /** The newest epoch's fee_index_live row. */
  latestLive(): Promise<FeeIndexLiveRow | null>;
  liveFor(epoch: number): Promise<FeeIndexLiveRow | null>;
  /** The newest epoch_index row below `beforeEpoch`. */
  lastFinal(beforeEpoch: number): Promise<EpochIndexRow | null>;
  finalFor(epoch: number): Promise<EpochIndexRow | null>;
  /** live_slots, newest first. */
  recentSlots(limit: number): Promise<LiveSlotRow[]>;
  leaderStats(epoch: number): Promise<LeaderStat[]>;
  /** The snapshot taken during `epoch`, else the next later one. */
  stakes(epoch: number): Promise<{ epoch: number; stakes: Map<string, bigint> } | null>;
  distribution(epoch: number): Promise<DistributionRows>;
  /** Every component's Solami usage report (solami_usage). */
  usageReports(): Promise<SolamiUsageRow[]>;
}

const BUCKETS_PER_DECADE = 4;

export class PgLiveRepository implements LiveRepository {
  constructor(private readonly db: EpochDb) {}

  usageReports(): Promise<SolamiUsageRow[]> {
    return new SolamiUsageStore(this.db).all();
  }

  async latestLive(): Promise<FeeIndexLiveRow | null> {
    const [row] = await this.db.select().from(feeIndexLive).orderBy(desc(feeIndexLive.epoch)).limit(1);
    return row ?? null;
  }

  async liveFor(epoch: number): Promise<FeeIndexLiveRow | null> {
    const [row] = await this.db.select().from(feeIndexLive).where(eq(feeIndexLive.epoch, epoch)).limit(1);
    return row ?? null;
  }

  async lastFinal(beforeEpoch: number): Promise<EpochIndexRow | null> {
    const [row] = await this.db
      .select()
      .from(epochIndex)
      .where(lt(epochIndex.epoch, beforeEpoch))
      .orderBy(desc(epochIndex.epoch))
      .limit(1);
    return row ?? null;
  }

  async finalFor(epoch: number): Promise<EpochIndexRow | null> {
    const [row] = await this.db.select().from(epochIndex).where(eq(epochIndex.epoch, epoch)).limit(1);
    return row ?? null;
  }

  recentSlots(limit: number): Promise<LiveSlotRow[]> {
    return this.db.select().from(liveSlots).orderBy(desc(liveSlots.slot)).limit(limit);
  }

  async leaderStats(epoch: number): Promise<LeaderStat[]> {
    // percentile_cont(0.5) is the mean of the two middle values for an even count; floor() makes it the indexer's
    // integer median. Exact for values below 2^53.
    const result = await this.db.execute<{ leader: string; slots: number; median: string; txs: string }>(sql`
      select leader,
             count(*)::int as slots,
             floor(percentile_cont(0.5) within group (order by median_cu_price))::bigint::text as median,
             sum(tx_count)::bigint::text as txs
        from slot_fees
       where epoch = ${epoch}
       group by leader`);
    return result.rows.map((r) => ({
      leader: r.leader,
      slots: Number(r.slots),
      medianCuPrice: Number(r.median),
      pricedTxs: Number(r.txs),
    }));
  }

  async stakes(epoch: number): Promise<{ epoch: number; stakes: Map<string, bigint> } | null> {
    const [first] = await this.db
      .select({ epoch: epochStakes.epoch })
      .from(epochStakes)
      .where(gte(epochStakes.epoch, epoch))
      .orderBy(asc(epochStakes.epoch))
      .limit(1);
    if (!first) return null;
    const rows = await this.db
      .select({ identity: epochStakes.identity, stakeLamports: epochStakes.stakeLamports })
      .from(epochStakes)
      .where(eq(epochStakes.epoch, first.epoch));
    return { epoch: first.epoch, stakes: new Map(rows.map((r) => [r.identity, r.stakeLamports])) };
  }

  async distribution(epoch: number): Promise<DistributionRows> {
    const buckets = await this.db.execute<{ bucket: number; slots: number }>(sql`
      select floor(log(10, median_cu_price::numeric) * ${BUCKETS_PER_DECADE})::int as bucket, count(*)::int as slots
        from slot_fees
       where epoch = ${epoch} and median_cu_price > 0
       group by 1
       order by 1`);
    const [stats] = (
      await this.db.execute<{ slots: number; p: string[] | null }>(sql`
      select count(*)::int as slots,
             (percentile_disc(array[0.1, 0.25, 0.5, 0.75, 0.9]) within group (order by median_cu_price))::text[] as p
        from slot_fees
       where epoch = ${epoch}`)
    ).rows;
    const p = stats?.p?.map(Number);
    return {
      slots: Number(stats?.slots ?? 0),
      buckets: buckets.rows.map((r) => ({ bucket: Number(r.bucket), slots: Number(r.slots) })),
      percentiles: p && p.length === 5 ? { p10: p[0], p25: p[1], p50: p[2], p75: p[3], p90: p[4] } : null,
    };
  }
}
