import { type PoolAccount } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type EpochDb, poolSnapshots } from '@epoch/pg_models';
import { count } from 'drizzle-orm';

import { type EventBus, type StoredProgramEvent } from '../../Lib/EventBus';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import { type ProgramEventStore } from './ProgramEventStore';

const logger = Logger.create('PoolSnapshotRecorder');

/** One pool_snapshots row. */
export interface PoolSnapshotRow {
  epoch: number;
  seniorAssets: bigint;
  seniorShares: bigint;
  juniorAssets: bigint;
  juniorShares: bigint;
  outstandingPrincipal: bigint;
  cash: bigint;
  seniorPriceE9: number;
  juniorPriceE9: number;
  utilizationBps: number;
  recordedAt: Date;
}

export interface PoolSnapshotRepo {
  isEmpty(): Promise<boolean>;
  /** Insert or replace the row for its epoch. */
  upsert(row: PoolSnapshotRow): Promise<void>;
  /** Insert rows for epochs that have none; returns how many were written. */
  insertMissing(rows: readonly PoolSnapshotRow[]): Promise<number>;
}

export class PgPoolSnapshotRepo implements PoolSnapshotRepo {
  constructor(private readonly db: EpochDb) {}

  async isEmpty(): Promise<boolean> {
    const [row] = await this.db.select({ n: count() }).from(poolSnapshots);
    return (row?.n ?? 0) === 0;
  }

  async upsert(row: PoolSnapshotRow): Promise<void> {
    const { epoch, ...fields } = row;
    await this.db.insert(poolSnapshots).values(row).onConflictDoUpdate({ target: poolSnapshots.epoch, set: fields });
    logger.debug('pool snapshot recorded', { epoch });
  }

  async insertMissing(rows: readonly PoolSnapshotRow[]): Promise<number> {
    let written = 0;
    for (let start = 0; start < rows.length; start += 500) {
      const inserted = await this.db
        .insert(poolSnapshots)
        .values(rows.slice(start, start + 500))
        .onConflictDoNothing()
        .returning({ epoch: poolSnapshots.epoch });
      written += inserted.length;
    }
    return written;
  }
}

/** The program side (EpochProgramSource.requirePool). */
export interface PoolReader {
  requirePool(): Promise<ProgramAccount<PoolAccount>>;
}

export interface PoolSnapshotRecorderDeps {
  pool: PoolReader;
  events: Pick<ProgramEventStore, 'query'>;
  /** pool_snapshots in Postgres; null without DATABASE_URL (the recorder then does nothing). */
  repo: PoolSnapshotRepo | null;
  bus: EventBus;
  /** False when the program isn't configured. */
  enabled: boolean;
  now?: () => Date;
}

/** outstanding × 10,000 ÷ (senior + junior assets); 0 for an empty pool. */
export function utilizationBps(
  pool: Pick<PoolAccount, 'outstandingPrincipal' | 'seniorAssets' | 'juniorAssets'>,
): number {
  const total = pool.seniorAssets + pool.juniorAssets;
  return total > 0n ? Number((pool.outstandingPrincipal * 10_000n) / total) : 0;
}

/** The pool row for an Accrued event: prices from the event, everything else from `pool` (read after it). */
export function snapshotRow(event: StoredProgramEvent, pool: PoolAccount, recordedAt: Date): PoolSnapshotRow {
  return {
    epoch: Number(event.data.epoch),
    seniorAssets: pool.seniorAssets,
    seniorShares: pool.seniorShares,
    juniorAssets: pool.juniorAssets,
    juniorShares: pool.juniorShares,
    outstandingPrincipal: pool.outstandingPrincipal,
    cash: pool.cash,
    seniorPriceE9: Number(event.data.seniorPriceE9),
    juniorPriceE9: Number(event.data.juniorPriceE9),
    utilizationBps: utilizationBps(pool),
    recordedAt,
  };
}

/**
 * Keeps pool_snapshots (the Vault's share-price and lent-out series, which the chain doesn't keep): one row per
 * accrued epoch, written when an `Accrued` event arrives on the bus. At start, an empty table is backfilled from the
 * stored Accrued events: their prices, the other fields from the current Pool, all with one `recorded_at`.
 */
export class PoolSnapshotRecorder {
  private unsubscribe?: () => void;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly deps: PoolSnapshotRecorderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (!this.deps.enabled || !this.deps.repo) {
      logger.info('pool snapshots off', { reason: this.deps.repo ? 'program not configured' : 'no DATABASE_URL' });
      return;
    }
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bus.on('programEvent', (event) => {
      if (event.name === 'Accrued') void this.enqueue(() => this.record(event));
    });
    void this.enqueue(() => this.backfill().then(() => undefined));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Resolves when the queued work (backfill, recordings) is done. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Upserts the row for one Accrued event. */
  async record(event: StoredProgramEvent): Promise<void> {
    if (!this.deps.repo) return;
    const pool = await this.deps.pool.requirePool();
    await this.deps.repo.upsert(snapshotRow(event, pool.account, this.now()));
  }

  /** Writes rows from the stored Accrued events when the table is empty; returns how many were written. */
  async backfill(): Promise<number> {
    const repo = this.deps.repo;
    if (!repo || !(await repo.isEmpty())) return 0;
    const events = await this.deps.events.query({ names: ['Accrued'], limit: 10_000 }); // the newest 10,000 epochs
    if (events.length === 0) return 0;
    const pool = await this.deps.pool.requirePool();
    const recordedAt = this.now();
    const byEpoch = new Map<number, PoolSnapshotRow>();
    for (const event of [...events].reverse()) {
      const row = snapshotRow(event, pool.account, recordedAt);
      byEpoch.set(row.epoch, row);
    }
    const written = await repo.insertMissing([...byEpoch.values()]);
    logger.info('pool snapshots backfilled from stored Accrued events', { rows: written });
    return written;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(task)
      .catch((error: unknown) => logger.warn('pool snapshot failed', { error: String(error) }));
    return this.queue;
  }
}
