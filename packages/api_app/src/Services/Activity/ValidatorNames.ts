import { Logger } from '@epoch/logger';

import { type ValidatorRow } from '../../types/Api.types';

const logger = Logger.create('ValidatorNames');

export type NamedValidator = Pick<ValidatorRow, 'name' | 'vote' | 'identity'>;

/** Validator names by vote account (activity rows) and by identity (the slot leader). */
export interface NameIndex {
  byVote: ReadonlyMap<string, string>;
  byIdentity: ReadonlyMap<string, string>;
}

export const EMPTY_NAMES: NameIndex = { byVote: new Map(), byIdentity: new Map() };

export function nameIndex(rows: readonly NamedValidator[]): NameIndex {
  return {
    byVote: new Map(rows.map((row) => [row.vote, row.name])),
    byIdentity: new Map(rows.map((row) => [row.identity, row.name])),
  };
}

/**
 * Names from the mainnet validator table (`ValidatorTable.get().rows`), indexed once per table and reused for
 * `refreshMs` (names barely change, and each `get()` of a table past its TTL starts a rebuild of several RPC calls).
 * A caller waits at most `waitMs` for a cold table and gets the last index, or no names, meanwhile; the load carries
 * on in the background.
 */
export class ValidatorNames {
  private last?: { rows: readonly NamedValidator[]; index: NameIndex; at: number };
  private inflight?: Promise<NameIndex>;

  constructor(
    private readonly rows: () => Promise<readonly NamedValidator[]>,
    private readonly waitMs = 1_500,
    private readonly refreshMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<NameIndex> {
    if (this.last && this.now() - this.last.at < this.refreshMs) return this.last.index;
    const load = this.load();
    let timer: NodeJS.Timeout | undefined;
    const fallback = new Promise<NameIndex>((resolve) => {
      timer = setTimeout(() => resolve(this.last?.index ?? EMPTY_NAMES), this.waitMs);
    });
    try {
      return await Promise.race([load, fallback]);
    } finally {
      clearTimeout(timer);
    }
  }

  private load(): Promise<NameIndex> {
    this.inflight ??= this.rows()
      .then((rows) => {
        const index = this.last?.rows === rows ? this.last.index : nameIndex(rows);
        this.last = { rows, index, at: this.now() };
        return index;
      })
      .catch((error: unknown) => {
        logger.warn('validator names unavailable; using short keys', { error: String(error) });
        return this.last?.index ?? EMPTY_NAMES;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
