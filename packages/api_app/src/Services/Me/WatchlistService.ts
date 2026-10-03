import { EpochException } from '@epoch/exceptions';
import { type EpochDb, watchlists } from '@epoch/pg_models';
import { eq, sql } from 'drizzle-orm';

import { type Watchlist } from '../../types/Account.types';

export const WATCHLIST_MAX = 200;

/** The signed-in wallet's starred validators (request #14). Signed out, the app keeps them in local storage. */
export class WatchlistService {
  constructor(private readonly db: () => EpochDb) {}

  /** `{ votes: [] }` when the wallet never saved one. */
  async get(address: string): Promise<Watchlist> {
    const [row] = await this.db()
      .select({ votes: watchlists.votes })
      .from(watchlists)
      .where(eq(watchlists.address, address));
    return { votes: Array.isArray(row?.votes) ? row.votes : [] };
  }

  /** Replaces the list: duplicates dropped (first one kept), at most 200 (400 WATCHLIST_TOO_LONG). */
  async put(address: string, votes: readonly string[]): Promise<Watchlist> {
    const unique = [...new Set(votes)];
    if (unique.length > WATCHLIST_MAX) {
      throw new EpochException(
        `A watchlist holds at most ${WATCHLIST_MAX} validators (got ${unique.length})`,
        'WATCHLIST_TOO_LONG',
        400,
        { max: WATCHLIST_MAX, count: unique.length },
      );
    }
    await this.db()
      .insert(watchlists)
      .values({ address, votes: unique })
      .onConflictDoUpdate({ target: watchlists.address, set: { votes: unique, updatedAt: sql`now()` } });
    return { votes: unique };
  }
}
