import { BadRequestException } from '@epoch/exceptions';

import { type ValidatorRow } from '../types/Api.types';

export type ValidatorTab = 'all' | 'healthy' | 'watch' | 'watchlist';
export type ValidatorChip = 'below' | 'dep' | 'hide-top18' | 'firedancer' | 'zero-fee';
export type ValidatorSort = 'stake' | 'apy' | 'score' | 'kept' | 'dels' | 'fee' | 'blocks' | 'up';

export interface ValidatorQuery {
  tab: ValidatorTab;
  chips: ValidatorChip[];
  q?: string;
  sort: ValidatorSort;
  dir: 'asc' | 'desc';
  /** Commission range in %, inclusive. */
  fee?: [number, number];
  /** Client families, lower case: `agave`, `firedancer`. */
  clients: string[];
  /** ISO country codes. */
  countries: string[];
  /** Vote keys for the Watchlist tab (or any explicit set). */
  votes: string[];
  offset: number;
  limit: number;
}

export interface ValidatorPage {
  rows: ValidatorRow[];
  total: number;
  nextCursor: string | null;
  facets: { client: Record<string, number>; country: Record<string, number> };
}

const SORT_FIELD: Record<ValidatorSort, (row: ValidatorRow) => number | null> = {
  stake: (r) => r.stakeSol,
  apy: (r) => r.apyPct,
  score: (r) => r.epochScore,
  kept: (r) => r.healthPerEpochSol,
  dels: (r) => r.delegators,
  fee: (r) => r.commissionPct,
  blocks: (r) => r.blocksPerDay,
  up: (r) => r.uptimePct,
};

const CHIP_TEST: Record<ValidatorChip, (row: ValidatorRow) => boolean> = {
  below: (r) => r.healthPerEpochSol < 0,
  dep: (r) => r.biggestDelegatorSharePct !== null && r.biggestDelegatorSharePct > 50,
  'hide-top18': (r) => !r.top18,
  firedancer: (r) => r.client === 'Firedancer',
  'zero-fee': (r) => r.commissionPct === 0,
};

export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match) throw new BadRequestException('Invalid cursor');
  return Number(match[1]);
}

const count = (rows: ValidatorRow[], key: (row: ValidatorRow) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
};

/**
 * Filters, sorts and pages the validator table the way the Validators page asks for it (URL state in
 * 11-CLICK-MAP.md VE rows). Facets are counted after the tab, chips and search but before the Filters
 * popover's own fee, client and country filters.
 */
export function queryValidators(all: readonly ValidatorRow[], query: ValidatorQuery): ValidatorPage {
  let rows = all.slice();
  if (query.tab === 'healthy') rows = rows.filter((r) => r.health === 'healthy');
  if (query.tab === 'watch') rows = rows.filter((r) => r.health !== 'healthy');
  if (query.tab === 'watchlist' || query.votes.length > 0) {
    const wanted = new Set(query.votes);
    rows = rows.filter((r) => wanted.has(r.vote));
  }
  for (const chip of query.chips) rows = rows.filter(CHIP_TEST[chip]);
  if (query.q) {
    const needle = query.q.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.vote.toLowerCase() === needle ||
        r.identity.toLowerCase() === needle ||
        r.vote.toLowerCase().startsWith(needle),
    );
  }

  const facets = {
    client: count(rows, (r) => r.client.toLowerCase()),
    country: count(rows, (r) => r.countryCode),
  };

  if (query.fee) {
    const [low, high] = query.fee;
    rows = rows.filter((r) => r.commissionPct >= low && r.commissionPct <= high);
  }
  if (query.clients.length) rows = rows.filter((r) => query.clients.includes(r.client.toLowerCase()));
  if (query.countries.length) rows = rows.filter((r) => query.countries.includes(r.countryCode));

  const field = SORT_FIELD[query.sort];
  const direction = query.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = field(a);
    const y = field(b);
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    if (x !== null && y !== null && x !== y) return (x - y) * direction;
    return b.stakeSol - a.stakeSol;
  });

  const page = rows.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + page.length;
  return {
    rows: page,
    total: rows.length,
    nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null,
    facets,
  };
}
