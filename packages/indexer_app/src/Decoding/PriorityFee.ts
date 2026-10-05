import { addressToBytes } from '@epoch/solana';

/**
 * Priority fee per compute unit (µL/CU, micro-lamports) of one transaction, the Fee Index's per-transaction input.
 *
 * - legacy and v0: the ComputeBudget program's SetComputeUnitPrice instruction (discriminator 3, then the price as a
 *   u64 LE): exactly 9 bytes of data, invoked from a static account key. Two of them make the runtime reject the
 *   transaction (DuplicateInstruction), so such a transaction counts as unpriced.
 * - v1 (SIMD-0385): ComputeBudget instructions are ignored by the runtime; the message carries the TOTAL priority fee in
 *   lamports and the compute-unit limit, so the price per CU is ⌊fee × 1,000,000 ÷ limit⌋. A missing limit is 0 (the
 *   SIMD's default), which has no per-CU price.
 *
 * A transaction is "priced" when that price is above 0. Everything else (no instruction, an explicit 0, a v1 fee of 0
 * or under 1 µL/CU, a zero limit) is unpriced: it does not bid for priority, and is left out of the median.
 */
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';
export const SET_COMPUTE_UNIT_PRICE = 3;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

const COMPUTE_BUDGET_BYTES = addressToBytes(COMPUTE_BUDGET_PROGRAM_ID);
const VOTE_BYTES = addressToBytes(VOTE_PROGRAM_ID);

export type PriceStatus = 'priced' | 'none' | 'zero' | 'v1-no-fee' | 'v1-zero-limit' | 'duplicate' | 'malformed';

export interface TxPrice {
  /** µL/CU when status is `priced`, else null. Capped at Number.MAX_SAFE_INTEGER (≈ 9 × 10^15, 9 SOL per CU). */
  cuPrice: number | null;
  status: PriceStatus;
}

/** What the price needs from a message: the legacy/v0 wire view and Yellowstone's protobuf message both fit. */
export interface PricedMessage {
  accountKeys: readonly Uint8Array[];
  instructions: readonly { programIdIndex: number; data: Uint8Array }[];
  /** Present (possibly empty) exactly for v1 messages. */
  v1Config?: { priorityFeeLamports?: bigint; computeUnitLimit?: number };
}

export function sameKey(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const toPrice = (value: bigint): TxPrice =>
  value === 0n
    ? { cuPrice: null, status: 'zero' }
    : { cuPrice: value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value), status: 'priced' };

/** The u64 price of a SetComputeUnitPrice instruction's data, or null when it is not one (or is malformed). */
export function decodeSetComputeUnitPrice(data: Uint8Array): bigint | null {
  if (data.length !== 9 || data[0] !== SET_COMPUTE_UNIT_PRICE) return null;
  let value = 0n;
  for (let i = 8; i >= 1; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}

export function priorityFeeOf(message: PricedMessage): TxPrice {
  if (message.v1Config) {
    const { priorityFeeLamports, computeUnitLimit } = message.v1Config;
    if (priorityFeeLamports === undefined) return { cuPrice: null, status: 'v1-no-fee' };
    if (priorityFeeLamports === 0n) return { cuPrice: null, status: 'zero' };
    if (!computeUnitLimit) return { cuPrice: null, status: 'v1-zero-limit' };
    return toPrice((priorityFeeLamports * MICRO_LAMPORTS_PER_LAMPORT) / BigInt(computeUnitLimit));
  }
  let found: TxPrice | undefined;
  for (const instruction of message.instructions) {
    const program = message.accountKeys[instruction.programIdIndex];
    if (!sameKey(program, COMPUTE_BUDGET_BYTES) || instruction.data[0] !== SET_COMPUTE_UNIT_PRICE) continue;
    if (found) return { cuPrice: null, status: 'duplicate' };
    const price = decodeSetComputeUnitPrice(instruction.data);
    found = price === null ? { cuPrice: null, status: 'malformed' } : toPrice(price);
  }
  return found ?? { cuPrice: null, status: 'none' };
}

/**
 * Agave's "simple vote transaction" (what Yellowstone's `isVote` and its `vote: false` filter mean): a legacy message
 * with fewer than 3 signatures and exactly one instruction, on the vote program.
 */
export function isSimpleVote(message: {
  version: 'legacy' | 0 | 1;
  numRequiredSignatures: number;
  accountKeys: readonly Uint8Array[];
  instructions: readonly { programIdIndex: number }[];
}): boolean {
  return (
    message.version === 'legacy' &&
    message.numRequiredSignatures < 3 &&
    message.instructions.length === 1 &&
    sameKey(message.accountKeys[message.instructions[0].programIdIndex], VOTE_BYTES)
  );
}
