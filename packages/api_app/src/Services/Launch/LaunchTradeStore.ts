import { buildCandles, type Candle, CANDLE_INTERVAL_SECONDS, type CandleInterval } from '@epoch/meteora';
import { type EpochDb, indexerCursors, launchFeeEvents, launchTrades } from '@epoch/pg_models';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import { LAMPORTS_PER_SOL } from '../../Lib/Stats';

/** One decoded trade as stored (launch_trades). Amounts in base units. */
export interface StoredLaunchTrade {
  signature: string;
  ix: number;
  mint: string;
  pool: string;
  venue: 'dbc' | 'damm-v2';
  side: 'buy' | 'sell';
  trader: string | null;
  slot: number;
  blockTime: Date;
  solLamports: bigint;
  tokenAmount: bigint;
  feeAmount: bigint;
  feeInToken: boolean;
  priceSol: number;
  postPriceSol: number;
  quoteReserveLamports: bigint | null;
}

/** One claim, withdrawal or graduation event as stored (launch_fee_events). */
export interface StoredLaunchFeeEvent {
  signature: string;
  ix: number;
  mint: string;
  pool: string;
  kind: string;
  owner: string | null;
  slot: number;
  blockTime: Date;
  solLamports: bigint;
  tokenAmount: bigint;
}

/** Where a page of trades ends: the oldest row's position (newest-first order is slot, signature, ix descending). */
export interface TradeCursor {
  slot: number;
  signature: string;
  ix: number;
}

export const encodeTradeCursor = (cursor: TradeCursor): string => `${cursor.slot}:${cursor.signature}:${cursor.ix}`;

export function decodeTradeCursor(text: string): TradeCursor | null {
  const match = /^(\d+):([1-9A-HJ-NP-Za-km-z]{32,90}):(\d+)$/.exec(text);
  return match ? { slot: Number(match[1]), signature: match[2], ix: Number(match[3]) } : null;
}

export interface DayStats {
  volumeSol: number;
  trades: number;
  buys: number;
  sells: number;
  /** Price of the first and the last trade in the window. */
  firstPriceSol: number | null;
  lastPriceSol: number | null;
}

/** Where launch trades and fee events are kept: Postgres, or memory without DATABASE_URL (and in tests). */
export interface LaunchTradeStore {
  /** Stores trades, skipping (signature, ix) pairs already stored; returns the rows that were new. */
  insertTrades(rows: readonly StoredLaunchTrade[]): Promise<StoredLaunchTrade[]>;
  insertFeeEvents(rows: readonly StoredLaunchFeeEvent[]): Promise<StoredLaunchFeeEvent[]>;
  /** Newest first, `limit` at most, older than `before` when given. */
  trades(mint: string, options: { limit: number; before?: TradeCursor | null }): Promise<StoredLaunchTrade[]>;
  /** OHLC buckets of `interval` with trades in [from, to), oldest first (no empty buckets), and the last price before `from`. */
  candles(
    mint: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<{ candles: Candle[]; previousClose: number | null }>;
  dayStats(mint: string, since: Date): Promise<DayStats>;
  /** Newest first. */
  feeEvents(mint: string, limit: number): Promise<StoredLaunchFeeEvent[]>;
  /** The newest signature read for an ingest cursor name (`launch_trades:<pool>`), or null. */
  cursor(name: string): Promise<{ slot: number; signature: string } | null>;
  setCursor(name: string, slot: number, signature: string): Promise<void>;
}

const newestFirst = (a: StoredLaunchTrade, b: StoredLaunchTrade): number =>
  b.slot - a.slot || (b.signature < a.signature ? -1 : b.signature > a.signature ? 1 : 0) || b.ix - a.ix;

const isBefore = (row: { slot: number; signature: string; ix: number }, cursor: TradeCursor): boolean =>
  row.slot < cursor.slot ||
  (row.slot === cursor.slot &&
    (row.signature < cursor.signature || (row.signature === cursor.signature && row.ix < cursor.ix)));

/** In memory: tests and a process without Postgres (the last `maxRows` trades per launch). */
export class MemoryLaunchTradeStore implements LaunchTradeStore {
  private readonly tradesByMint = new Map<string, StoredLaunchTrade[]>();
  private readonly feesByMint = new Map<string, StoredLaunchFeeEvent[]>();
  private readonly cursors = new Map<string, { slot: number; signature: string }>();

  constructor(private readonly maxRows = 20_000) {}

  async insertTrades(rows: readonly StoredLaunchTrade[]): Promise<StoredLaunchTrade[]> {
    const added: StoredLaunchTrade[] = [];
    for (const row of rows) {
      const list = this.tradesByMint.get(row.mint) ?? [];
      if (list.some((existing) => existing.signature === row.signature && existing.ix === row.ix)) continue;
      list.push(row);
      added.push(row);
      list.sort(newestFirst);
      if (list.length > this.maxRows) list.length = this.maxRows;
      this.tradesByMint.set(row.mint, list);
    }
    return added;
  }

  async insertFeeEvents(rows: readonly StoredLaunchFeeEvent[]): Promise<StoredLaunchFeeEvent[]> {
    const added: StoredLaunchFeeEvent[] = [];
    for (const row of rows) {
      const list = this.feesByMint.get(row.mint) ?? [];
      if (list.some((existing) => existing.signature === row.signature && existing.ix === row.ix)) continue;
      list.push(row);
      added.push(row);
      list.sort((a, b) => b.slot - a.slot || b.ix - a.ix);
      this.feesByMint.set(row.mint, list);
    }
    return added;
  }

  async trades(mint: string, options: { limit: number; before?: TradeCursor | null }): Promise<StoredLaunchTrade[]> {
    const list = this.tradesByMint.get(mint) ?? [];
    const before = options.before;
    return (before ? list.filter((row) => isBefore(row, before)) : list).slice(0, options.limit);
  }

  async candles(
    mint: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<{ candles: Candle[]; previousClose: number | null }> {
    const list = this.tradesByMint.get(mint) ?? [];
    const inRange = list.filter((row) => row.blockTime >= from && row.blockTime < to);
    const earlier = list.find((row) => row.blockTime < from) ?? null;
    const candles = buildCandles(
      [...inRange].reverse().map((row) => ({
        t: row.blockTime.getTime() / 1000,
        priceSol: row.priceSol,
        volumeSol: Number(row.solLamports) / LAMPORTS_PER_SOL,
        trade: true,
      })),
      interval,
      { fill: false },
    );
    return { candles, previousClose: earlier?.priceSol ?? null };
  }

  async dayStats(mint: string, since: Date): Promise<DayStats> {
    const rows = (this.tradesByMint.get(mint) ?? []).filter((row) => row.blockTime >= since);
    return {
      volumeSol: rows.reduce((sum, row) => sum + Number(row.solLamports), 0) / LAMPORTS_PER_SOL,
      trades: rows.length,
      buys: rows.filter((row) => row.side === 'buy').length,
      sells: rows.filter((row) => row.side === 'sell').length,
      firstPriceSol: rows.length ? rows[rows.length - 1].priceSol : null,
      lastPriceSol: rows.length ? rows[0].priceSol : null,
    };
  }

  async feeEvents(mint: string, limit: number): Promise<StoredLaunchFeeEvent[]> {
    return (this.feesByMint.get(mint) ?? []).slice(0, limit);
  }

  async cursor(name: string): Promise<{ slot: number; signature: string } | null> {
    return this.cursors.get(name) ?? null;
  }

  async setCursor(name: string, slot: number, signature: string): Promise<void> {
    this.cursors.set(name, { slot, signature });
  }
}

const toTradeRow = (row: typeof launchTrades.$inferSelect): StoredLaunchTrade => ({
  signature: row.signature,
  ix: row.ix,
  mint: row.mint,
  pool: row.pool,
  venue: row.venue as StoredLaunchTrade['venue'],
  side: row.side as StoredLaunchTrade['side'],
  trader: row.trader,
  slot: row.slot,
  blockTime: row.blockTime,
  solLamports: row.solLamports,
  tokenAmount: BigInt(row.tokenAmount),
  feeAmount: BigInt(row.feeAmount),
  feeInToken: row.feeInToken,
  priceSol: row.priceSol,
  postPriceSol: row.postPriceSol,
  quoteReserveLamports: row.quoteReserveLamports,
});

const toFeeRow = (row: typeof launchFeeEvents.$inferSelect): StoredLaunchFeeEvent => ({
  signature: row.signature,
  ix: row.ix,
  mint: row.mint,
  pool: row.pool,
  kind: row.kind,
  owner: row.owner,
  slot: row.slot,
  blockTime: row.blockTime,
  solLamports: row.solLamports,
  tokenAmount: BigInt(row.tokenAmount),
});

/** launch_trades and launch_fee_events in Postgres; candles are bucketed in SQL. */
export class PgLaunchTradeStore implements LaunchTradeStore {
  constructor(private readonly db: EpochDb) {}

  async insertTrades(rows: readonly StoredLaunchTrade[]): Promise<StoredLaunchTrade[]> {
    if (rows.length === 0) return [];
    const inserted = await this.db
      .insert(launchTrades)
      .values(
        rows.map((row) => ({
          ...row,
          tokenAmount: row.tokenAmount.toString(),
          feeAmount: row.feeAmount.toString(),
        })),
      )
      .onConflictDoNothing()
      .returning();
    return inserted.map(toTradeRow);
  }

  async insertFeeEvents(rows: readonly StoredLaunchFeeEvent[]): Promise<StoredLaunchFeeEvent[]> {
    if (rows.length === 0) return [];
    const inserted = await this.db
      .insert(launchFeeEvents)
      .values(rows.map((row) => ({ ...row, tokenAmount: row.tokenAmount.toString() })))
      .onConflictDoNothing()
      .returning();
    return inserted.map(toFeeRow);
  }

  async trades(mint: string, options: { limit: number; before?: TradeCursor | null }): Promise<StoredLaunchTrade[]> {
    const before = options.before;
    const where = before
      ? and(
          eq(launchTrades.mint, mint),
          or(
            lt(launchTrades.slot, before.slot),
            and(eq(launchTrades.slot, before.slot), lt(launchTrades.signature, before.signature)),
            and(
              eq(launchTrades.slot, before.slot),
              eq(launchTrades.signature, before.signature),
              lt(launchTrades.ix, before.ix),
            ),
          ),
        )
      : eq(launchTrades.mint, mint);
    const rows = await this.db
      .select()
      .from(launchTrades)
      .where(where)
      .orderBy(desc(launchTrades.slot), desc(launchTrades.signature), desc(launchTrades.ix))
      .limit(options.limit);
    return rows.map(toTradeRow);
  }

  async candles(
    mint: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<{ candles: Candle[]; previousClose: number | null }> {
    const step = CANDLE_INTERVAL_SECONDS[interval];
    const result = await this.db.execute<{
      bucket: string | number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume_lamports: string | number;
      trades: string | number;
    }>(sql`
      select floor(extract(epoch from ${launchTrades.blockTime}) / ${step})::bigint * ${step} as bucket,
        (array_agg(${launchTrades.priceSol} order by ${launchTrades.slot}, ${launchTrades.signature}, ${launchTrades.ix}))[1] as open,
        max(${launchTrades.priceSol}) as high,
        min(${launchTrades.priceSol}) as low,
        (array_agg(${launchTrades.priceSol} order by ${launchTrades.slot} desc, ${launchTrades.signature} desc, ${launchTrades.ix} desc))[1] as close,
        sum(${launchTrades.solLamports}) as volume_lamports,
        count(*) as trades
      from ${launchTrades}
      where ${launchTrades.mint} = ${mint} and ${launchTrades.blockTime} >= ${from} and ${launchTrades.blockTime} < ${to}
      group by bucket
      order by bucket`);
    const [previous] = await this.db
      .select({ priceSol: launchTrades.priceSol })
      .from(launchTrades)
      .where(and(eq(launchTrades.mint, mint), lt(launchTrades.blockTime, from)))
      .orderBy(desc(launchTrades.slot), desc(launchTrades.signature), desc(launchTrades.ix))
      .limit(1);
    return {
      candles: result.rows.map((row) => ({
        t: Number(row.bucket),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volumeSol: Number(row.volume_lamports) / LAMPORTS_PER_SOL,
        trades: Number(row.trades),
      })),
      previousClose: previous?.priceSol ?? null,
    };
  }

  async dayStats(mint: string, since: Date): Promise<DayStats> {
    const result = await this.db.execute<{
      volume_lamports: string | number | null;
      trades: string | number;
      buys: string | number;
      first_price: number | null;
      last_price: number | null;
    }>(sql`
      select sum(${launchTrades.solLamports}) as volume_lamports,
        count(*) as trades,
        count(*) filter (where ${launchTrades.side} = 'buy') as buys,
        (array_agg(${launchTrades.priceSol} order by ${launchTrades.slot}, ${launchTrades.ix}))[1] as first_price,
        (array_agg(${launchTrades.priceSol} order by ${launchTrades.slot} desc, ${launchTrades.ix} desc))[1] as last_price
      from ${launchTrades}
      where ${launchTrades.mint} = ${mint} and ${launchTrades.blockTime} >= ${since}`);
    const row = result.rows[0];
    const trades = Number(row?.trades ?? 0);
    const buys = Number(row?.buys ?? 0);
    return {
      volumeSol: Number(row?.volume_lamports ?? 0) / LAMPORTS_PER_SOL,
      trades,
      buys,
      sells: trades - buys,
      firstPriceSol: row?.first_price === null || row?.first_price === undefined ? null : Number(row.first_price),
      lastPriceSol: row?.last_price === null || row?.last_price === undefined ? null : Number(row.last_price),
    };
  }

  async feeEvents(mint: string, limit: number): Promise<StoredLaunchFeeEvent[]> {
    const rows = await this.db
      .select()
      .from(launchFeeEvents)
      .where(eq(launchFeeEvents.mint, mint))
      .orderBy(desc(launchFeeEvents.slot), desc(launchFeeEvents.ix))
      .limit(limit);
    return rows.map(toFeeRow);
  }

  async cursor(name: string): Promise<{ slot: number; signature: string } | null> {
    const [row] = await this.db.select().from(indexerCursors).where(eq(indexerCursors.name, name)).limit(1);
    return row && row.signature ? { slot: row.slot, signature: row.signature } : null;
  }

  async setCursor(name: string, slot: number, signature: string): Promise<void> {
    await this.db
      .insert(indexerCursors)
      .values({ name, slot, signature })
      .onConflictDoUpdate({ target: indexerCursors.name, set: { slot, signature, updatedAt: new Date() } });
  }
}
