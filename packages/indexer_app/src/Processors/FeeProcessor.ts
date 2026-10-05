export interface TxFee {
  feePayer: string;
  /** Priority fee per compute unit, micro-lamports. */
  cuPrice: number;
}

export interface LeaderMedian {
  leader: string;
  medianCuPrice: number;
  stake: bigint;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Median priority fee for one slot, excluding transactions paid by the slot leader. */
export function slotMedianCuPrice(txs: TxFee[], leaderIdentity: string): number {
  return median(txs.filter((tx) => tx.feePayer !== leaderIdentity).map((tx) => tx.cuPrice));
}

/**
 * The leader whose median sets the stake-weighted median: leaders with stake, by median (ties by key, so the answer
 * is deterministic), the first at which the running stake reaches half the total. Null when no leader has stake.
 */
export function stakeWeightedMedianLeader(leaders: LeaderMedian[]): LeaderMedian | null {
  const entries = leaders
    .filter((l) => l.stake > 0n)
    .sort((a, b) => a.medianCuPrice - b.medianCuPrice || (a.leader < b.leader ? -1 : a.leader > b.leader ? 1 : 0));
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, l) => sum + l.stake, 0n);
  let running = 0n;
  for (const entry of entries) {
    running += entry.stake;
    if (running * 2n >= total) return entry;
  }
  return entries[entries.length - 1];
}

/** Stake-weighted median of per-leader medians: the epoch's Solana Fee Index. */
export function stakeWeightedMedian(leaders: LeaderMedian[]): number {
  return stakeWeightedMedianLeader(leaders)?.medianCuPrice ?? 0;
}
