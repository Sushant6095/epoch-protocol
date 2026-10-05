/** One slot_fees row: the Fee Index input for one block (written by IndexerStore.writeBatch). */
export interface SlotFeeRow {
  slot: number;
  epoch: number;
  leader: string;
  medianCuPrice: number;
  txCount: number;
}
