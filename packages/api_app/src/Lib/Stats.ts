/** Median of a list; 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Nearest-rank percentile (`p` in 0–1); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

export const round = (value: number, decimals = 0): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * The smallest set of the largest stakes that together hold MORE than one third of the total: enough to
 * halt the chain if they stopped. Returns the indices of those entries in `stakes`.
 */
export function superminority(stakes: readonly number[]): Set<number> {
  const total = sum(stakes);
  const order = stakes.map((stake, index) => ({ stake, index })).sort((a, b) => b.stake - a.stake);
  const members = new Set<number>();
  let held = 0;
  for (const { stake, index } of order) {
    if (held * 3 > total) break;
    members.add(index);
    held += stake;
  }
  return members;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const lamportsToSol = (lamports: number | bigint): number => Number(lamports) / LAMPORTS_PER_SOL;

/** `abcd…wxyz` for a base58 key, as the UI prints it. */
export const shortKey = (key: string): string => (key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key);

/** ISO 8601 in India Standard Time, matching the fixtures (`2026-09-29T00:30:00+05:30`). */
export function isoIst(date: Date = new Date()): string {
  const ist = new Date(date.getTime() + 330 * 60_000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
}
