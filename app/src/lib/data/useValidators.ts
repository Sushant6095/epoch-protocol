'use client';
import { request, apiConfigured, API_BASE } from './client';
import { useQuery } from '@tanstack/react-query';
import fixture from '@/fixtures/validators.real.json';
import type { ValidatorList, ValidatorRow } from './contracts/Api.types';
const snapshot: ValidatorList = {
  ...fixture,
  schemaVersion: 1,
  kind: 'real',
  total: fixture.rows.length,
  nextCursor: null,
  facets: { client: {}, country: {} },
  rows: fixture.rows.map((row) => ({
    ...row,
    name: row.name || row.voteShort,
    client: row.client as ValidatorRow['client'],
    clientId: null,
    countryCode: '',
    mevCommissionPct: null,
    delinquent: false,
    foundationSharePct: null,
    health: row.healthPerEpochSol < 0 || row.biggestDelegatorSharePct > 50 || row.uptimePct < 99 ? 'watch' : 'healthy',
    healthReasons: [
      ...(row.uptimePct < 99 ? [`Uptime ${row.uptimePct}%`] : []),
      ...(row.healthPerEpochSol < 0 ? ['Revenue below vote fees'] : []),
      ...(row.biggestDelegatorSharePct > 50 ? ['One delegator holds over 50%'] : []),
    ],
  })),
};
export function useValidators(query = 'limit=1000') {
  return useQuery({
    queryKey: ['validators', query, API_BASE || 'snapshot'],
    queryFn: async ({ signal }): Promise<ValidatorList> => {
      if (!apiConfigured) return snapshot;
      const first = await request<ValidatorList>(`/v1/validators?${query}`, { signal });
      const rows = [...first.rows];
      let cursor = first.nextCursor;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor) || seen.size >= 20)
          throw new Error('Validator pagination could not finish. Please retry.');
        seen.add(cursor);
        const params = new URLSearchParams(query);
        params.set('cursor', cursor);
        const next = await request<ValidatorList>(`/v1/validators?${params}`, { signal });
        rows.push(...next.rows);
        cursor = next.nextCursor;
      }
      return { ...first, rows: [...new Map(rows.map((row) => [row.vote, row])).values()], nextCursor: null };
    },
    staleTime: apiConfigured ? 30_000 : Infinity,
  });
}
