import { type EpochDb, launchPriceSamples } from '@epoch/pg_models';
import { sql } from 'drizzle-orm';

/** One price sample of a launch's token. */
export interface LaunchPriceSample {
  mint: string;
  t: Date;
  epoch: number;
  priceSol: number;
}

/** Most points a price series returns (the Launch chart). */
export const MAX_SERIES_POINTS = 500;

/** Where launch prices are kept: launch_price_samples in Postgres; memory for tests. */
export interface LaunchPriceStore {
  /** Stores samples, skipping (mint, t) pairs already stored; returns how many were new. */
  insert(samples: readonly LaunchPriceSample[]): Promise<number>;
  /** Oldest first, thinned evenly to at most `maxPoints` (the newest sample always kept). */
  series(mint: string, maxPoints?: number): Promise<LaunchPriceSample[]>;
}

/**
 * Keeps at most `max` points, evenly spaced, oldest first: every ⌈n ÷ (max − 1)⌉-th point plus the newest one. The same
 * rule as `PgLaunchPriceStore.series`.
 */
export function downsample<T>(points: readonly T[], max = MAX_SERIES_POINTS): T[] {
  if (max < 2) throw new RangeError('max must be at least 2');
  if (points.length <= max) return [...points];
  const step = Math.ceil(points.length / (max - 1));
  const kept = points.filter((_, index) => index % step === 0);
  if ((points.length - 1) % step !== 0) kept.push(points[points.length - 1]);
  return kept;
}

/** launch_price_samples, thinned in SQL so a long history never leaves the database whole. */
export class PgLaunchPriceStore implements LaunchPriceStore {
  constructor(private readonly db: EpochDb) {}

  async insert(samples: readonly LaunchPriceSample[]): Promise<number> {
    if (samples.length === 0) return 0;
    const rows = await this.db
      .insert(launchPriceSamples)
      .values(samples.map((s) => ({ mint: s.mint, t: s.t, epoch: s.epoch, priceSol: s.priceSol })))
      .onConflictDoNothing()
      .returning({ mint: launchPriceSamples.mint });
    return rows.length;
  }

  async series(mint: string, maxPoints = MAX_SERIES_POINTS): Promise<LaunchPriceSample[]> {
    if (maxPoints < 2) throw new RangeError('maxPoints must be at least 2');
    const result = await this.db.execute<{ t: Date | string; epoch: number; price_sol: number | string }>(sql`
      select t, epoch, price_sol from (
        select t, epoch, price_sol,
          row_number() over (order by t) as rn,
          count(*) over () as n
        from ${launchPriceSamples}
        where ${launchPriceSamples.mint} = ${mint}
      ) samples
      where n <= ${maxPoints} or (rn - 1) % ceil(n::numeric / ${maxPoints - 1}) = 0 or rn = n
      order by t`);
    return result.rows.map((row) => ({
      mint,
      t: row.t instanceof Date ? row.t : new Date(row.t),
      epoch: Number(row.epoch),
      priceSol: Number(row.price_sol),
    }));
  }
}

/** In memory (tests, and a process without Postgres). */
export class MemoryLaunchPriceStore implements LaunchPriceStore {
  private readonly byMint = new Map<string, LaunchPriceSample[]>();

  async insert(samples: readonly LaunchPriceSample[]): Promise<number> {
    let added = 0;
    for (const sample of samples) {
      const list = this.byMint.get(sample.mint) ?? [];
      if (list.some((existing) => existing.t.getTime() === sample.t.getTime())) continue;
      list.push(sample);
      list.sort((a, b) => a.t.getTime() - b.t.getTime());
      this.byMint.set(sample.mint, list);
      added += 1;
    }
    return added;
  }

  async series(mint: string, maxPoints = MAX_SERIES_POINTS): Promise<LaunchPriceSample[]> {
    return downsample(this.byMint.get(mint) ?? [], maxPoints);
  }
}
