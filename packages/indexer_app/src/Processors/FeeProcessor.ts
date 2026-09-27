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

/** Stake-weighted median of per-leader medians: the epoch's Solana Fee Index. */
export function stakeWeightedMedian(leaders: LeaderMedian[]): number {
  const entries = leaders.filter((l) => l.stake > 0n).sort((a, b) => a.medianCuPrice - b.medianCuPrice);
  if (entries.length === 0) return 0;
  const total = entries.reduce((sum, l) => sum + l.stake, 0n);
  let running = 0n;
  for (const entry of entries) {
    running += entry.stake;
    if (running * 2n >= total) return entry.medianCuPrice;
  }
  return entries[entries.length - 1].medianCuPrice;
}
