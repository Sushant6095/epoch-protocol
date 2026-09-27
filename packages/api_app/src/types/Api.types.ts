export interface FeeIndexPoint {
  epoch: number;
  /** Stake-weighted median priority fee, micro-lamports per compute unit. */
  value: number;
}
