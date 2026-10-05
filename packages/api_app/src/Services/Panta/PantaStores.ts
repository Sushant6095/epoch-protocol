import { type EpochDb, epochIndex, pantaMarkets, pantaTrades, slotFees } from '@epoch/pg_models';
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';

/** A `panta_trades` row: one buy or win claim made through Epoch. */
export type PantaTradeRecord = typeof pantaTrades.$inferSelect;
/** A `panta_markets` row: one of Epoch's Fee Index markets (written by panta_bot_app). */
export type PantaMarketRow = typeof pantaMarkets.$inferSelect;

export type NewPantaTrade = Pick<
  PantaTradeRecord,
  | 'id'
  | 'kind'
  | 'wallet'
  | 'marketId'
  | 'side'
  | 'amountUsdc'
  | 'amountUsdcBase'
  | 'feeUsdc'
  | 'expectedShares'
  | 'quoteId'
  | 'orderId'
  | 'messageHash'
  | 'lastValidBlockHeight'
  | 'summary'
  | 'consentAt'
  | 'sessionAddress'
  | 'country'
>;

export interface PantaTradeTotals {
  trades: number;
  buys: number;
  claims: number;
  uniqueWallets: number;
  volumeUsdcBase: number;
  attributed: number;
  pendingAttribution: number;
  firstTradeAt: Date | null;
  lastTradeAt: Date | null;
}

/** Trades made through Epoch: the consent record, the signature, Panta's attribution. */
export interface PantaTradeStore {
  insert(trade: NewPantaTrade): Promise<void>;
  get(id: string): Promise<PantaTradeRecord | null>;
  /** built → submitted with the signature; false when it is not `built` any more or the signature is taken. */
  markSubmitted(id: string, signature: string): Promise<boolean>;
  /** submitted → confirmed | failed | expired. */
  settle(id: string, status: 'confirmed' | 'failed' | 'expired'): Promise<void>;
  /** Records an attribution attempt: processed, failed (given up), or still pending (with the reason). */
  recordReport(id: string, result: { status: 'processed' | 'failed' | 'pending'; error?: string }): Promise<void>;
  /** Submitted or confirmed trades whose attribution is still pending, created since `since`, oldest first. */
  pending(since: Date, limit: number): Promise<PantaTradeRecord[]>;
  totals(): Promise<PantaTradeTotals>;
  /** Distinct wallets of submitted or confirmed trades, at most `limit` (the traders count). */
  wallets(limit: number): Promise<string[]>;
}

export interface PantaMarketTotals {
  created: number;
  live: number;
  creationFeesPaidBase: number;
  creatorFeesClaimedBase: number;
}

/** Epoch's own Panta markets, as panta_bot_app recorded them. */
export interface PantaMarketReader {
  /** Registered markets, newest epoch first. */
  recent(limit: number): Promise<PantaMarketRow[]>;
  /** One epoch's registered markets (its strikes), lowest threshold first. */
  forEpoch(epoch: number): Promise<PantaMarketRow[]>;
  byMarketId(marketId: string): Promise<PantaMarketRow | null>;
  totals(now: Date): Promise<PantaMarketTotals>;
}

/** The Fee Index history the informational model needs. */
export interface IndexReads {
  /** Finished epochs' computed values (epoch_index), newest first. */
  history(limit: number): Promise<{ epoch: number; value: number }[]>;
  /** The newest indexed epoch so far: median of its slot medians and how many slots (slot_fees); null without data. */
  running(): Promise<{ epoch: number; value: number; slots: number } | null>;
}

const toNumber = (value: unknown): number => Number(value ?? 0);
/** Postgres 23505, raw or wrapped in drizzle's DrizzleQueryError (`cause`). */
const isUniqueViolation = (error: unknown): boolean => {
  const failure = error as { code?: string; cause?: { code?: string } } | null;
  return failure?.code === '23505' || failure?.cause?.code === '23505';
};
const toDate = (value: unknown): Date | null => (value ? new Date(String(value)) : null);

export class PgPantaTradeStore implements PantaTradeStore {
  constructor(private readonly db: () => EpochDb) {}

  async insert(trade: NewPantaTrade): Promise<void> {
    await this.db()
      .insert(pantaTrades)
      .values({ ...trade, status: 'built' });
  }

  async get(id: string): Promise<PantaTradeRecord | null> {
    const [row] = await this.db().select().from(pantaTrades).where(eq(pantaTrades.id, id)).limit(1);
    return row ?? null;
  }

  async markSubmitted(id: string, signature: string): Promise<boolean> {
    try {
      const rows = await this.db()
        .update(pantaTrades)
        .set({ status: 'submitted', signature, submittedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(pantaTrades.id, id), eq(pantaTrades.status, 'built')))
        .returning({ id: pantaTrades.id });
      return rows.length > 0;
    } catch (error) {
      // The unique signature index: that transaction was already submitted for another trade.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async settle(id: string, status: 'confirmed' | 'failed' | 'expired'): Promise<void> {
    await this.db()
      .update(pantaTrades)
      .set({
        status,
        updatedAt: sql`now()`,
        ...(status === 'confirmed' ? { confirmedAt: sql`now()` } : {}),
        ...(status === 'confirmed' ? {} : { reportStatus: 'failed', reportError: `transaction ${status}` }),
      })
      .where(and(eq(pantaTrades.id, id), eq(pantaTrades.status, 'submitted')));
  }

  async recordReport(
    id: string,
    result: { status: 'processed' | 'failed' | 'pending'; error?: string },
  ): Promise<void> {
    await this.db()
      .update(pantaTrades)
      .set({
        reportStatus: result.status,
        reportError: result.error?.slice(0, 500) ?? null,
        reportAttempts: sql`${pantaTrades.reportAttempts} + 1`,
        updatedAt: sql`now()`,
        ...(result.status === 'processed' ? { reportedAt: sql`now()` } : {}),
      })
      .where(eq(pantaTrades.id, id));
  }

  async pending(since: Date, limit: number): Promise<PantaTradeRecord[]> {
    return this.db()
      .select()
      .from(pantaTrades)
      .where(
        and(
          inArray(pantaTrades.status, ['submitted', 'confirmed']),
          eq(pantaTrades.reportStatus, 'pending'),
          isNotNull(pantaTrades.signature),
          gte(pantaTrades.createdAt, since),
        ),
      )
      .orderBy(asc(pantaTrades.createdAt))
      .limit(limit);
  }

  async wallets(limit: number): Promise<string[]> {
    const rows = await this.db()
      .selectDistinct({ wallet: pantaTrades.wallet })
      .from(pantaTrades)
      .where(inArray(pantaTrades.status, ['submitted', 'confirmed']))
      .limit(limit);
    return rows.map((row) => row.wallet);
  }

  async totals(): Promise<PantaTradeTotals> {
    const result = await this.db().execute<Record<string, unknown>>(sql`
      SELECT
        count(*) AS trades,
        count(*) FILTER (WHERE kind = 'buy') AS buys,
        count(*) FILTER (WHERE kind = 'claim') AS claims,
        count(DISTINCT wallet) AS wallets,
        coalesce(sum(amount_usdc_base) FILTER (WHERE kind = 'buy' AND status = 'confirmed'), 0) AS volume,
        count(*) FILTER (WHERE report_status = 'processed') AS attributed,
        count(*) FILTER (WHERE report_status = 'pending') AS pending,
        min(created_at) AS first_at,
        max(created_at) AS last_at
      FROM ${pantaTrades}
      WHERE status IN ('submitted', 'confirmed')`);
    const row = result.rows[0] ?? {};
    return {
      trades: toNumber(row.trades),
      buys: toNumber(row.buys),
      claims: toNumber(row.claims),
      uniqueWallets: toNumber(row.wallets),
      volumeUsdcBase: toNumber(row.volume),
      attributed: toNumber(row.attributed),
      pendingAttribution: toNumber(row.pending),
      firstTradeAt: toDate(row.first_at),
      lastTradeAt: toDate(row.last_at),
    };
  }
}

export class PgPantaMarketReader implements PantaMarketReader {
  constructor(private readonly db: () => EpochDb) {}

  async recent(limit: number): Promise<PantaMarketRow[]> {
    return this.db()
      .select()
      .from(pantaMarkets)
      .where(and(eq(pantaMarkets.status, 'registered'), isNotNull(pantaMarkets.marketId)))
      .orderBy(desc(pantaMarkets.epoch), asc(pantaMarkets.threshold))
      .limit(limit);
  }

  async forEpoch(epoch: number): Promise<PantaMarketRow[]> {
    return this.db()
      .select()
      .from(pantaMarkets)
      .where(
        and(eq(pantaMarkets.epoch, epoch), eq(pantaMarkets.status, 'registered'), isNotNull(pantaMarkets.marketId)),
      )
      .orderBy(asc(pantaMarkets.threshold));
  }

  async byMarketId(marketId: string): Promise<PantaMarketRow | null> {
    const [row] = await this.db().select().from(pantaMarkets).where(eq(pantaMarkets.marketId, marketId)).limit(1);
    return row ?? null;
  }

  async totals(now: Date): Promise<PantaMarketTotals> {
    const [row] = await this.db()
      .select({
        created: sql<string>`count(*) FILTER (WHERE ${pantaMarkets.paidUsdcBase} IS NOT NULL)`,
        live: sql<string>`count(*) FILTER (WHERE ${pantaMarkets.status} = 'registered' AND ${pantaMarkets.endTime} > ${now})`,
        paid: sql<string>`coalesce(sum(${pantaMarkets.paidUsdcBase}), 0)`,
        creatorFees: sql<string>`coalesce(sum(${pantaMarkets.creatorFeesClaimedUsdcBase}), 0)`,
      })
      .from(pantaMarkets)
      .where(or(isNotNull(pantaMarkets.paidUsdcBase), eq(pantaMarkets.status, 'registered')));
    return {
      created: toNumber(row?.created),
      live: toNumber(row?.live),
      creationFeesPaidBase: toNumber(row?.paid),
      creatorFeesClaimedBase: toNumber(row?.creatorFees),
    };
  }
}

export class PgIndexReads implements IndexReads {
  constructor(private readonly db: () => EpochDb) {}

  async history(limit: number): Promise<{ epoch: number; value: number }[]> {
    return this.db()
      .select({ epoch: epochIndex.epoch, value: epochIndex.value })
      .from(epochIndex)
      .orderBy(desc(epochIndex.epoch))
      .limit(limit);
  }

  async running(): Promise<{ epoch: number; value: number; slots: number } | null> {
    const result = await this.db().execute<{ epoch: number | null; value: string | null; slots: string }>(sql`
      SELECT epoch,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY ${slotFees.medianCuPrice}) AS value,
        count(*) AS slots
      FROM ${slotFees}
      WHERE epoch = (SELECT max(epoch) FROM ${slotFees})
      GROUP BY epoch`);
    const row = result.rows[0];
    if (!row || row.epoch === null || row.value === null) return null;
    return { epoch: Number(row.epoch), value: Number(row.value), slots: Number(row.slots) };
  }
}
