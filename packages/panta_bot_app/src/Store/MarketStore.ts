import { epochIndex, type EpochDb, pantaMarkets } from '@epoch/pg_models';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';

/** A `panta_markets` row. */
export type MarketRecord = typeof pantaMarkets.$inferSelect;

/**
 * planned → quoted → signed → confirmed → registered. `unregistered`: paid and confirmed, but Panta's registration
 * window passed (a person must ask Panta). `failed`: given up (too late for its epoch, refused by the spend guard, or
 * failed `PANTA_MAX_ATTEMPTS` times).
 */
export type MarketStatus = 'planned' | 'quoted' | 'signed' | 'confirmed' | 'registered' | 'unregistered' | 'failed';

/** What planning writes; the lifecycle fills in the rest as the market moves on. */
export type NewMarket = Pick<
  MarketRecord,
  | 'epoch'
  | 'threshold'
  | 'question'
  | 'title'
  | 'description'
  | 'resolutionRule'
  | 'sourcesOfTruth'
  | 'imageUrl'
  | 'startTime'
  | 'endTime'
  | 'resolutionTime'
>;

export type MarketPatch = Partial<Omit<MarketRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'>> & {
  status?: MarketStatus;
};

/** Statuses whose creation fee counts against the daily budget (it was signed, so it may have been paid). */
export const COMMITTED_STATUSES: readonly MarketStatus[] = ['signed', 'confirmed', 'registered', 'unregistered'];

/** Where the lifecycle keeps its markets. Every status change is a compare-and-set, so two runners never both act. */
export interface MarketStore {
  /** Every row for these epochs. */
  forEpochs(epochs: readonly number[]): Promise<MarketRecord[]>;
  /** Inserts a `planned` market unless (epoch, threshold) already has a row; returns the new row or null. */
  plan(market: NewMarket): Promise<MarketRecord | null>;
  /** Rows in these statuses, oldest epoch first. */
  withStatus(statuses: readonly MarketStatus[]): Promise<MarketRecord[]>;
  /** Applies `patch` only while the row is still `from`; false when another writer moved it first. */
  transition(id: number, from: MarketStatus, patch: MarketPatch): Promise<boolean>;
  /** Creation fees (quoted, base units) of rows signed since `since` and not rolled back. */
  committedSince(since: Date): Promise<number>;
}

/** Finished epochs' Fee Index values (mainnet epochs, µL/CU), from the indexer's `epoch_index`. */
export interface IndexHistory {
  /** Epochs before `beforeEpoch`, newest first, at most `limit`. */
  recent(beforeEpoch: number, limit: number): Promise<{ epoch: number; value: number }[]>;
}

export class PgMarketStore implements MarketStore {
  constructor(private readonly db: EpochDb) {}

  async forEpochs(epochs: readonly number[]): Promise<MarketRecord[]> {
    if (epochs.length === 0) return [];
    return this.db
      .select()
      .from(pantaMarkets)
      .where(inArray(pantaMarkets.epoch, [...epochs]))
      .orderBy(asc(pantaMarkets.epoch), asc(pantaMarkets.threshold));
  }

  async plan(market: NewMarket): Promise<MarketRecord | null> {
    const rows = await this.db
      .insert(pantaMarkets)
      .values({ ...market, status: 'planned' })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  async withStatus(statuses: readonly MarketStatus[]): Promise<MarketRecord[]> {
    if (statuses.length === 0) return [];
    return this.db
      .select()
      .from(pantaMarkets)
      .where(inArray(pantaMarkets.status, [...statuses]))
      .orderBy(asc(pantaMarkets.epoch), asc(pantaMarkets.id));
  }

  async transition(id: number, from: MarketStatus, patch: MarketPatch): Promise<boolean> {
    const rows = await this.db
      .update(pantaMarkets)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(pantaMarkets.id, id), eq(pantaMarkets.status, from)))
      .returning({ id: pantaMarkets.id });
    return rows.length > 0;
  }

  async committedSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${pantaMarkets.quotedUsdcBase}), 0)` })
      .from(pantaMarkets)
      .where(and(inArray(pantaMarkets.status, [...COMMITTED_STATUSES]), gte(pantaMarkets.signedAt, since)));
    return Number(row?.total ?? 0);
  }
}

export class PgIndexHistory implements IndexHistory {
  constructor(private readonly db: EpochDb) {}

  async recent(beforeEpoch: number, limit: number): Promise<{ epoch: number; value: number }[]> {
    return this.db
      .select({ epoch: epochIndex.epoch, value: epochIndex.value })
      .from(epochIndex)
      .where(lt(epochIndex.epoch, beforeEpoch))
      .orderBy(desc(epochIndex.epoch))
      .limit(limit);
  }
}
