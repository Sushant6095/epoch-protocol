import { CommitmentLevel, grpcErrorText, type SubscribeRequest } from '@epoch/solana';

/**
 * The two Yellowstone requests the indexer uses (commitment `confirmed`; `fromSlot` replays a gap after a reconnect):
 *
 * `firehose` (SLOT_SOURCE=grpc): every non-vote transaction (`vote: false`, failed ones included: they pay their
 * priority fee too) plus each block's meta (slot, parent, leader Fee reward, block time) plus slot statuses for the
 * chain tip. This is the cheapest request that still sees every priced transaction:
 * - `blocks` with transactions would also carry every vote (~2/3 of all transactions, +30% bytes);
 * - a transactions filter scoped to the ComputeBudget program (`account_include`) is ~35% smaller and is allowed on
 *   Solami plan streams, but it misses SIMD-0385 v1 transactions, which carry their fee inline and never mention
 *   ComputeBudget: about half of the priced transactions on mainnet in October 2026. Wrong data, so not an option.
 * On Solami an unscoped transactions filter is a "firehose" and needs gRPC pay-as-you-go (or a firehose allowance).
 *
 * `meta` (SLOT_SOURCE=hybrid): block meta + slot statuses only (~210 bytes per block; fine on plan streams). The
 * block's transactions then come from Solami RPC getBlock.
 */
export type StreamKind = 'firehose' | 'meta';

export const FEES_FILTER = 'fees';
export const BLOCKS_FILTER = 'blocks';
export const TIP_FILTER = 'tip';

export function slotStreamRequest(kind: StreamKind, fromSlot?: number): SubscribeRequest {
  return {
    accounts: {},
    slots: { [TIP_FILTER]: { filterByCommitment: false, interslotUpdates: false } },
    transactions:
      kind === 'firehose'
        ? { [FEES_FILTER]: { vote: false, accountInclude: [], accountExclude: [], accountRequired: [] } }
        : {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: { [BLOCKS_FILTER]: {} },
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
    fromSlot: fromSlot !== undefined ? String(fromSlot) : undefined,
    ping: undefined,
  };
}

/**
 * Where to resume: `want` when the endpoint can still replay it (and it is not ahead of the known tip), else
 * undefined: subscribe live and let the gap filler fetch what was missed over RPC.
 */
export function replayFrom(
  want: number | undefined,
  firstAvailableSlot: number | undefined,
  tipSlot: number | undefined,
): number | undefined {
  if (want === undefined || firstAvailableSlot === undefined) return undefined;
  if (want < firstAvailableSlot) return undefined;
  if (tipSlot !== undefined && want > tipSlot) return undefined;
  return want;
}

const text = grpcErrorText;

/** Solami refused the firehose on a plan stream (needs gRPC PAYG or a firehose allowance). */
export const isFirehoseRefused = (error: unknown): boolean => /firehose|unfiltered/i.test(text(error));

/** The key is missing, wrong, revoked, or not a gRPC key. */
export const isAuthRefused = (error: unknown): boolean =>
  /unauthenticated|valid authentication credentials|missing api key|invalid api key|api key revoked|does not have grpc access|ip not allowed/i.test(
    text(error),
  );

/** The request itself was refused (filter caps); retrying the same request cannot help. */
export const isRequestRefused = (error: unknown): boolean =>
  isFirehoseRefused(error) || isAuthRefused(error) || /too many filters|has \d+ addresses \(max/i.test(text(error));
