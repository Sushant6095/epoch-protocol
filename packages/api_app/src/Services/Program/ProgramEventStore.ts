import { type EventJsonValue, type EventName } from '@epoch/epoch-sdk';
import { type EpochDb, indexerCursors, programEvents } from '@epoch/pg_models';
import { and, asc, desc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';

import { type StoredProgramEvent } from '../../Lib/EventBus';

/** Filters for reading stored program events. */
export interface EventQuery {
  names?: readonly EventName[];
  /** Equality on payload fields, e.g. `{ owner: '<base58>' }` or `{ quote: '<base58>', epoch: '1047' }`. */
  where?: Record<string, string>;
  /** Inclusive. */
  sinceSlot?: number;
  /** Exclusive. */
  beforeSlot?: number;
  /** Default 500, at most 10,000. */
  limit?: number;
  /** By (slot, ix). Default `desc` (newest first). */
  order?: 'asc' | 'desc';
}

export interface EventCursor {
  slot: number;
  signature: string | null;
}

/** Where ingested program events live: Postgres when DATABASE_URL is set, otherwise memory (last N events). */
export interface ProgramEventStore {
  /** True when events survive a restart. */
  readonly persistent: boolean;
  /** Stores events, skipping ones already stored (signature, ix); returns the ones that were new. */
  insert(events: readonly StoredProgramEvent[]): Promise<StoredProgramEvent[]>;
  query(query?: EventQuery): Promise<StoredProgramEvent[]>;
  getCursor(name: string): Promise<EventCursor | null>;
  setCursor(name: string, cursor: EventCursor): Promise<void>;
}

const MAX_LIMIT = 10_000;
const clampLimit = (limit?: number): number => Math.max(1, Math.min(MAX_LIMIT, limit ?? 500));
const key = (event: Pick<StoredProgramEvent, 'signature' | 'ix'>): string => `${event.signature}:${event.ix}`;
const compare = (a: StoredProgramEvent, b: StoredProgramEvent): number => a.slot - b.slot || a.ix - b.ix;

/** Keeps the newest `capacity` events in memory. For development without Postgres, and for tests. */
export class MemoryEventStore implements ProgramEventStore {
  readonly persistent = false;
  private events: StoredProgramEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<string, EventCursor>();

  constructor(private readonly capacity = 5_000) {}

  async insert(events: readonly StoredProgramEvent[]): Promise<StoredProgramEvent[]> {
    const fresh = events.filter((event) => !this.seen.has(key(event)));
    for (const event of fresh) this.seen.add(key(event));
    if (fresh.length === 0) return [];
    this.events = [...this.events, ...fresh].sort(compare);
    if (this.events.length > this.capacity) {
      const dropped = this.events.splice(0, this.events.length - this.capacity);
      for (const event of dropped) this.seen.delete(key(event));
    }
    return fresh;
  }

  async query(query: EventQuery = {}): Promise<StoredProgramEvent[]> {
    const names = query.names ? new Set<string>(query.names) : undefined;
    const where = Object.entries(query.where ?? {});
    const matches = this.events.filter(
      (event) =>
        (!names || names.has(event.name)) &&
        (query.sinceSlot === undefined || event.slot >= query.sinceSlot) &&
        (query.beforeSlot === undefined || event.slot < query.beforeSlot) &&
        where.every(([field, value]) => String(event.data[field]) === value),
    );
    const ordered = query.order === 'asc' ? matches : [...matches].reverse();
    return ordered.slice(0, clampLimit(query.limit));
  }

  async getCursor(name: string): Promise<EventCursor | null> {
    return this.cursors.get(name) ?? null;
  }

  async setCursor(name: string, cursor: EventCursor): Promise<void> {
    this.cursors.set(name, cursor);
  }
}

/** program_events and indexer_cursors in Postgres. */
export class PgEventStore implements ProgramEventStore {
  readonly persistent = true;

  constructor(private readonly db: EpochDb) {}

  async insert(events: readonly StoredProgramEvent[]): Promise<StoredProgramEvent[]> {
    if (events.length === 0) return [];
    const inserted: StoredProgramEvent[] = [];
    // Chunks keep each statement well under Postgres' parameter limit.
    for (let start = 0; start < events.length; start += 500) {
      const chunk = events.slice(start, start + 500);
      const rows = await this.db
        .insert(programEvents)
        .values(
          chunk.map((event) => ({
            signature: event.signature,
            ix: event.ix,
            slot: event.slot,
            kind: event.name,
            payload: event.data,
            blockTime: event.blockTime ? new Date(event.blockTime) : null,
            epoch: event.epoch,
          })),
        )
        .onConflictDoNothing()
        .returning({ signature: programEvents.signature, ix: programEvents.ix });
      const fresh = new Set(rows.map(key));
      inserted.push(...chunk.filter((event) => fresh.has(key(event))));
    }
    return inserted;
  }

  async query(query: EventQuery = {}): Promise<StoredProgramEvent[]> {
    const conditions: SQL[] = [];
    if (query.names) {
      if (query.names.length === 0) return [];
      conditions.push(inArray(programEvents.kind, [...query.names]));
    }
    if (query.sinceSlot !== undefined) conditions.push(gte(programEvents.slot, query.sinceSlot));
    if (query.beforeSlot !== undefined) conditions.push(lt(programEvents.slot, query.beforeSlot));
    for (const [field, value] of Object.entries(query.where ?? {})) {
      conditions.push(sql`${programEvents.payload} ->> ${field} = ${value}`);
    }
    const order =
      query.order === 'asc'
        ? [asc(programEvents.slot), asc(programEvents.ix)]
        : [desc(programEvents.slot), desc(programEvents.ix)];
    const rows = await this.db
      .select()
      .from(programEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(...order)
      .limit(clampLimit(query.limit));
    return rows.map((row) => ({
      signature: row.signature,
      ix: row.ix,
      slot: row.slot,
      epoch: row.epoch,
      blockTime: row.blockTime ? row.blockTime.toISOString() : null,
      name: row.kind as EventName,
      data: row.payload as Record<string, EventJsonValue>,
    }));
  }

  async getCursor(name: string): Promise<EventCursor | null> {
    const [row] = await this.db.select().from(indexerCursors).where(eq(indexerCursors.name, name)).limit(1);
    return row ? { slot: row.slot, signature: row.signature } : null;
  }

  async setCursor(name: string, cursor: EventCursor): Promise<void> {
    await this.db
      .insert(indexerCursors)
      .values({ name, slot: cursor.slot, signature: cursor.signature, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: indexerCursors.name,
        set: { slot: cursor.slot, signature: cursor.signature, updatedAt: new Date() },
      });
  }
}
