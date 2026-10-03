import { createHash, randomBytes } from 'crypto';

import { Logger } from '@epoch/logger';
import { type EpochDb, sessions } from '@epoch/pg_models';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { type SessionInfo } from '../../Lib/Session';
import { isoIst, shortKey } from '../../Lib/Stats';

const logger = Logger.create('SessionStore');

/** sessions.id: the sha256 (hex) of the cookie token. The token itself is never stored. */
export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SessionStoreOptions {
  /** How long a looked-up session (or a miss) is trusted before the next DB read. */
  cacheMs: number;
  /** last_seen_at is written at most this often per session. */
  touchEveryMs: number;
  maxCached: number;
}

const DEFAULTS: SessionStoreOptions = { cacheMs: 30_000, touchEveryMs: 5 * 60_000, maxCached: 20_000 };

interface CacheEntry {
  /** null: unknown, revoked or expired. */
  session: SessionInfo | null;
  expiresAtMs: number;
  fetchedAt: number;
  lastSeenAt: number;
}

/**
 * Signed-in sessions in Postgres with a short in-process cache, so a request with a cookie costs a DB read at most
 * every 30 s per session. Revoking in this process takes effect at once; other processes see it within the cache time.
 */
export class SessionStore {
  private readonly cache = new Map<string, CacheEntry>();
  /** Revoked here: a lookup that raced the revocation must not cache the session as live again. */
  private readonly revoked = new Map<string, number>();

  constructor(
    private readonly db: () => EpochDb,
    private readonly options: SessionStoreOptions = DEFAULTS,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new session for `address`: the random cookie token (32 bytes, base64url) and what the middleware will see. */
  async create(
    address: string,
    ttlHours: number,
    userAgent: string | undefined,
  ): Promise<{ token: string; session: SessionInfo }> {
    const token = randomBytes(32).toString('base64url');
    const id = hashSessionToken(token);
    const now = this.now();
    const expiresAt = new Date(now + ttlHours * 3_600_000);
    await this.db()
      .insert(sessions)
      .values({ id, address, expiresAt, userAgent: userAgent ? userAgent.slice(0, 512) : null });
    const session: SessionInfo = { id, address, expiresAt: isoIst(expiresAt) };
    this.remember(id, { session, expiresAtMs: expiresAt.getTime(), fetchedAt: now, lastSeenAt: now });
    return { token, session };
  }

  /** The live session behind a cookie token, or null (unknown, expired or revoked). Throws only on DB errors. */
  async lookup(token: string): Promise<SessionInfo | null> {
    if (!token || token.length > 256) return null;
    const id = hashSessionToken(token);
    const now = this.now();
    let entry = this.cache.get(id);
    if (!entry || now - entry.fetchedAt >= this.options.cacheMs) entry = await this.load(id);
    if (!entry.session || entry.expiresAtMs <= now) return null;
    if (now - entry.lastSeenAt >= this.options.touchEveryMs) {
      entry.lastSeenAt = now;
      this.touch(id);
    }
    return entry.session;
  }

  /** Signs a session out (revoked_at), effective at once in this process. Idempotent. */
  async revoke(id: string): Promise<void> {
    const now = this.now();
    this.revoked.set(id, now);
    this.cache.set(id, { session: null, expiresAtMs: 0, fetchedAt: now, lastSeenAt: now });
    await this.db()
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }

  /** Deletes sessions that expired more than `olderThanDays` ago. */
  async pruneExpired(olderThanDays = 30): Promise<number> {
    const rows = await this.db()
      .delete(sessions)
      .where(sql`${sessions.expiresAt} < now() - make_interval(days => ${olderThanDays})`)
      .returning({ id: sessions.id });
    return rows.length;
  }

  private async load(id: string): Promise<CacheEntry> {
    const fetchedAt = this.now();
    const [row] = await this.db()
      .select({
        address: sessions.address,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .where(eq(sessions.id, id));
    const live = row && !row.revokedAt && !this.revoked.has(id) && row.expiresAt.getTime() > fetchedAt;
    const entry: CacheEntry = live
      ? {
          session: { id, address: row.address, expiresAt: isoIst(row.expiresAt) },
          expiresAtMs: row.expiresAt.getTime(),
          fetchedAt,
          lastSeenAt: row.lastSeenAt.getTime(),
        }
      : { session: null, expiresAtMs: 0, fetchedAt, lastSeenAt: fetchedAt };
    this.remember(id, entry);
    return entry;
  }

  private remember(id: string, entry: CacheEntry): void {
    if (this.cache.size >= this.options.maxCached) this.prune(entry.fetchedAt);
    this.cache.set(id, entry);
  }

  private prune(now: number): void {
    for (const [id, entry] of this.cache) if (now - entry.fetchedAt >= this.options.cacheMs) this.cache.delete(id);
    if (this.cache.size >= this.options.maxCached) this.cache.clear();
    for (const [id, at] of this.revoked) if (now - at >= this.options.cacheMs * 2) this.revoked.delete(id);
  }

  private touch(id: string): void {
    Promise.resolve()
      .then(() =>
        this.db()
          .update(sessions)
          .set({ lastSeenAt: sql`now()` })
          .where(eq(sessions.id, id)),
      )
      .catch((error: unknown) =>
        logger.warn('last_seen_at update failed', { session: shortKey(id), error: String(error) }),
      );
  }
}
