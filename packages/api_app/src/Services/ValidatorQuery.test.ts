import { type ValidatorRow } from '../types/Api.types';
import { decodeCursor, encodeCursor, queryValidators, type ValidatorQuery } from './ValidatorQuery';
import { clientFamily, healthOf } from './ValidatorTable';

const row = (over: Partial<ValidatorRow>): ValidatorRow => {
  const base: ValidatorRow = {
    name: 'V',
    vote: 'vote',
    identity: 'id',
    voteShort: 'vote',
    client: 'Agave',
    clientId: 'AgaveBam',
    country: 'Germany',
    countryCode: 'DE',
    apyPct: 5,
    stakingApyPct: 4.8,
    tipsApyPct: 0.2,
    commissionPct: 5,
    stakeSol: 100_000,
    delegators: 100,
    biggestDelegatorSharePct: 10,
    blocksPerDay: 100,
    healthPerEpochSol: 10,
    uptimePct: 100,
    top18: false,
    epochScore: 90,
    mevCommissionPct: 5,
    delinquent: false,
    foundationSharePct: null,
    health: 'healthy',
    healthReasons: [],
  };
  return { ...base, ...over };
};

const rows: ValidatorRow[] = [
  row({ name: 'Alpha', vote: 'A1', stakeSol: 900_000, top18: true, epochScore: 50 }),
  row({ name: 'Bravo', vote: 'B1', stakeSol: 500_000, client: 'Firedancer', countryCode: 'US', commissionPct: 0 }),
  row({ name: 'Charlie', vote: 'C1', stakeSol: 300_000, healthPerEpochSol: -1, health: 'watch', apyPct: null }),
  row({ name: 'Delta', vote: 'D1', stakeSol: 200_000, biggestDelegatorSharePct: 80, health: 'watch' }),
  row({ name: 'Echo', vote: 'E1', stakeSol: 100_000, delinquent: true, health: 'offline', epochScore: 0 }),
];

const q = (over: Partial<ValidatorQuery> = {}): ValidatorQuery => ({
  tab: 'all',
  chips: [],
  sort: 'stake',
  dir: 'desc',
  clients: [],
  countries: [],
  votes: [],
  offset: 0,
  limit: 50,
  ...over,
});

describe('queryValidators', () => {
  it('filters by tab: watch includes offline validators', () => {
    expect(queryValidators(rows, q({ tab: 'healthy' })).rows.map((r) => r.name)).toEqual(['Alpha', 'Bravo']);
    expect(queryValidators(rows, q({ tab: 'watch' })).rows.map((r) => r.name)).toEqual(['Charlie', 'Delta', 'Echo']);
    expect(queryValidators(rows, q({ tab: 'watchlist', votes: ['D1', 'A1'] })).total).toBe(2);
    expect(queryValidators(rows, q({ tab: 'watchlist' })).total).toBe(0);
  });

  it('applies chips', () => {
    expect(queryValidators(rows, q({ chips: ['below'] })).rows.map((r) => r.name)).toEqual(['Charlie']);
    expect(queryValidators(rows, q({ chips: ['dep'] })).rows.map((r) => r.name)).toEqual(['Delta']);
    expect(queryValidators(rows, q({ chips: ['hide-top18'] })).total).toBe(4);
    expect(queryValidators(rows, q({ chips: ['firedancer', 'zero-fee'] })).rows.map((r) => r.name)).toEqual(['Bravo']);
  });

  it('searches by name or vote key and counts facets before the popover filters', () => {
    expect(queryValidators(rows, q({ q: 'cha' })).rows.map((r) => r.name)).toEqual(['Charlie']);
    expect(queryValidators(rows, q({ q: 'E1' })).rows.map((r) => r.name)).toEqual(['Echo']);
    const page = queryValidators(rows, q({ countries: ['US'] }));
    expect(page.total).toBe(1);
    expect(page.facets.country).toEqual({ DE: 4, US: 1 });
    expect(page.facets.client).toEqual({ agave: 4, firedancer: 1 });
  });

  it('filters by fee range and client family', () => {
    expect(queryValidators(rows, q({ fee: [0, 0] })).rows.map((r) => r.name)).toEqual(['Bravo']);
    expect(queryValidators(rows, q({ clients: ['firedancer'] })).total).toBe(1);
  });

  it('sorts with nulls last and stake as the tie-break', () => {
    expect(queryValidators(rows, q({ sort: 'apy', dir: 'asc' })).rows.map((r) => r.name)).toEqual([
      'Alpha',
      'Bravo',
      'Delta',
      'Echo',
      'Charlie',
    ]);
    expect(queryValidators(rows, q({ sort: 'score', dir: 'desc' })).rows[0].name).toBe('Bravo');
  });

  it('pages with an opaque cursor', () => {
    const first = queryValidators(rows, q({ limit: 2 }));
    expect(first.rows.map((r) => r.name)).toEqual(['Alpha', 'Bravo']);
    expect(first.nextCursor).not.toBeNull();
    const second = queryValidators(rows, q({ limit: 2, offset: decodeCursor(first.nextCursor ?? undefined) }));
    expect(second.rows.map((r) => r.name)).toEqual(['Charlie', 'Delta']);
    const last = queryValidators(rows, q({ limit: 2, offset: 4 }));
    expect(last.nextCursor).toBeNull();
    expect(decodeCursor(encodeCursor(150))).toBe(150);
    expect(() => decodeCursor('bad')).toThrow('Invalid cursor');
  });
});

describe('health rules and client families', () => {
  it('follows 01-PRODUCT-AND-USERS: offline, then watch reasons, else healthy', () => {
    expect(
      healthOf({ delinquent: true, healthPerEpochSol: 5, biggestDelegatorSharePct: 10, uptimePct: 100 }).health,
    ).toBe('offline');
    expect(
      healthOf({ delinquent: false, healthPerEpochSol: -0.5, biggestDelegatorSharePct: 86, uptimePct: 98.5 }),
    ).toEqual({
      health: 'watch',
      healthReasons: ['below break-even', '86% one delegator', 'uptime 98.5%'],
    });
    expect(
      healthOf({ delinquent: false, healthPerEpochSol: 1, biggestDelegatorSharePct: null, uptimePct: null }).health,
    ).toBe('healthy');
  });

  it('maps gossip client ids to families', () => {
    expect(clientFamily('AgaveBam')).toBe('Agave');
    expect(clientFamily('JitoLabs')).toBe('Agave');
    expect(clientFamily('Frankendancer')).toBe('Firedancer');
    expect(clientFamily('HarmonicFiredancer')).toBe('Firedancer');
    expect(clientFamily('Unknown(51585)')).toBe('Unknown');
    expect(clientFamily(undefined)).toBe('Unknown');
  });
});
