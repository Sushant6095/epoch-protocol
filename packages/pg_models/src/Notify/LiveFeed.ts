/**
 * The Postgres NOTIFY contract between indexer_app (publisher) and api_app (listener) for the Live page: one channel,
 * small JSON payloads. Postgres caps a payload at 8,000 bytes; ours stay near 300.
 */
export const LIVE_NOTIFY_CHANNEL = 'epoch_live';

/** Postgres refuses NOTIFY payloads of 8,000 bytes or more. */
export const MAX_NOTIFY_BYTES = 7_900;

/** A block's fee composition in lamports (request #30): see slot_fee_mix. */
export interface LiveSlotFeesPayload {
  baseLamports: number;
  priorityLamports: number;
  tipsLamports: number;
  tipTxs: number;
  /** The leader's Fee reward; null when the block reported none. */
  rewardLamports: number | null;
  /** counted | reward | estimated: how the votes' base fees were found. */
  basis: string;
}

/** One processed block. Prices are µL/CU over priced, non-leader-paid transactions; null when there were none. */
export interface LiveSlotPayload {
  t: 'slot';
  slot: number;
  epoch: number;
  leader: string;
  medianCuPrice: number | null;
  p25CuPrice: number | null;
  p75CuPrice: number | null;
  p90CuPrice: number | null;
  pricedTxs: number;
  unpricedTxs: number;
  leaderPaidTxs: number;
  failedTxs: number;
  /** Unix seconds; null when the block had no time. */
  blockTime: number | null;
  /** grpc | hybrid | rpc */
  source: string;
  /** Absent from indexers older than request #30; null when a payload's fees could not be read. */
  fees?: LiveSlotFeesPayload | null;
}

/** The running estimate of the epoch in progress (also written to fee_index_live). */
export interface LiveIndexPayload {
  t: 'index';
  epoch: number;
  estimate: number | null;
  leaders: number;
  slotsWithFees: number;
  pricedTxs: number;
  firstSlot: number | null;
  processedSlot: number | null;
  watermarkSlot: number | null;
  tipSlot: number | null;
  stakeEpoch: number | null;
  source: string;
  endpoint: string | null;
  status: string;
  stride: number;
  /** Unix ms of the last processed slot; null before the first. */
  lastSlotAt: number | null;
}

/** An epoch's final value was written to epoch_index. */
export interface LiveEpochPayload {
  t: 'epoch';
  epoch: number;
  value: number;
}

export type LivePayload = LiveSlotPayload | LiveIndexPayload | LiveEpochPayload;

/** JSON for pg_notify; throws when it would not fit (a bug: payloads are fixed-size records). */
export function encodeLivePayload(payload: LivePayload): string {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_NOTIFY_BYTES) {
    throw new RangeError(`NOTIFY payload of ${Buffer.byteLength(text)} bytes exceeds ${MAX_NOTIFY_BYTES}`);
  }
  return text;
}

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNumOrNull = (value: unknown): boolean => value === null || isNum(value);

function isFees(value: unknown): value is LiveSlotFeesPayload {
  if (typeof value !== 'object' || value === null) return false;
  const fees = value as Record<string, unknown>;
  return (
    isNum(fees.baseLamports) &&
    isNum(fees.priorityLamports) &&
    isNum(fees.tipsLamports) &&
    isNum(fees.tipTxs) &&
    isNumOrNull(fees.rewardLamports) &&
    typeof fees.basis === 'string'
  );
}

/** Parses a payload from the channel; null for anything that is not one of ours (never trusted blindly). */
export function decodeLivePayload(text: string | undefined): LivePayload | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as Record<string, unknown>;
  switch (payload.t) {
    case 'slot':
      return isNum(payload.slot) &&
        isNum(payload.epoch) &&
        typeof payload.leader === 'string' &&
        isNumOrNull(payload.medianCuPrice) &&
        isNum(payload.pricedTxs)
        ? ({
            ...payload,
            ...(payload.fees !== undefined ? { fees: isFees(payload.fees) ? payload.fees : null } : {}),
          } as unknown as LiveSlotPayload)
        : null;
    case 'index':
      return isNum(payload.epoch) && isNumOrNull(payload.estimate) && typeof payload.status === 'string'
        ? (payload as unknown as LiveIndexPayload)
        : null;
    case 'epoch':
      return isNum(payload.epoch) && isNum(payload.value) ? (payload as unknown as LiveEpochPayload) : null;
    default:
      return null;
  }
}
