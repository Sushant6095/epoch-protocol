/**
 * Which program-cluster epoch P carries the Fee Index of mainnet epoch M.
 *
 * The index value comes from MAINNET slots (indexer_app → epoch_index, keyed by mainnet epoch), but the program
 * reads its own cluster's clock: quotes are for program epochs, `open_swap` closes when the program cluster reaches the
 * quote's epoch, and `settle_swap` looks up `FeeIndex.value_for(quote epoch)`. So the publisher posts M's value under
 *
 * - `P = M + FEE_INDEX_EPOCH_OFFSET` (a number; 0 when the program runs on mainnet), or
 * - `auto`: `P = (program cluster's current epoch) − 1` at posting time, i.e. the program epoch that was running
 *   while M ran, when the publisher posts promptly after M ends.
 *
 * See packages/publisher_app/README.md for how to choose the offset on devnet.
 */
export type EpochOffset = number | 'auto';

export function programEpochFor(mainnetEpoch: number, offset: EpochOffset, programEpoch: bigint): bigint {
  return offset === 'auto' ? programEpoch - 1n : BigInt(mainnetEpoch) + BigInt(offset);
}
