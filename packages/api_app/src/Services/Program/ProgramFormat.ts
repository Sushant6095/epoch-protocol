import { type EpochEventMap, type EventName, rawSharesToUi, sharePriceE9, sharePriceE9ToSol } from '@epoch/epoch-sdk';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { round } from '../../Lib/Stats';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_EXACT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Lamports → SOL, exact to the lamport: every amount is computed in bigint lamports and converted once, so a
 * response never carries float noise like 0.30000000000000004. Negative amounts (swap payoffs) keep their sign.
 */
export function toSol(lamports: bigint): number {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const value =
    abs <= MAX_EXACT ? Number(abs) / 1e9 : Number(abs / LAMPORTS_PER_SOL) + Number(abs % LAMPORTS_PER_SOL) / 1e9;
  return negative ? -value : value;
}

/** SOL → lamports, rounded down (for estimates computed in SOL). */
export const toLamports = (sol: number): bigint => (sol > 0 ? BigInt(Math.floor(sol * 1e9)) : 0n);

/** An amount in SOL for activity and parameter texts: "120", "2.4", "5,000". */
export const solText = (lamports: bigint): string =>
  toSol(lamports).toLocaleString('en-US', { maximumFractionDigits: 9 });

/** Basis points as a percent string without float noise: 3 → "0.03", 200 → "2", 1250 → "12.5". */
export const bpsText = (bps: number): string => String(bps / 100);

/** SOL per UI share for a tranche, the program's price with its virtual offsets (par = 1.0). */
export const sharePrice = (assets: bigint, shares: bigint): number => sharePriceE9ToSol(sharePriceE9(assets, shares));

/** Raw shares (1e12 per UI share) → UI shares. */
export const uiShares = (shares: bigint): number => rawSharesToUi(shares);

/** `part ÷ whole × 100` on bigint amounts, rounded; 0 when `whole` is 0. */
export function ratioPct(part: bigint, whole: bigint, decimals = 2): number {
  if (whole <= 0n) return 0;
  return round(Number((part * 100_000_000n) / whole) / 1_000_000, decimals);
}

export const ceilDiv = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : (a + b - 1n) / b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// ── Stored event payloads: epoch-sdk `eventToJson(event).data`, camelCase field names, u64/i64 as decimal strings,
// pubkeys base58, enums as the SDK's strings ('senior' | 'junior', 'payFixed' | 'receiveFixed').

type PayloadValue = string | number | boolean;
export type EventFields<N extends EventName> = Record<keyof EpochEventMap[N] & string, PayloadValue>;

/** A stored event's payload, its field names checked against epoch-sdk's event types at compile time. */
export const payload = <N extends EventName>(event: StoredProgramEvent, _name: N): EventFields<N> =>
  event.data as EventFields<N>;

/** A u64/i64 payload value (a decimal string) as bigint; 0n when absent. */
export const big = (value: PayloadValue | undefined): bigint =>
  typeof value === 'string' || typeof value === 'number' ? BigInt(value) : 0n;

/** Events in chain order (slot, then position in the transaction). */
export const chainOrder = (a: StoredProgramEvent, b: StoredProgramEvent): number => a.slot - b.slot || a.ix - b.ix;

/** "1,284 other wallets", "1 other wallet". */
export const plural = (count: number, word: string): string =>
  `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
