import { createHash, type Hash } from 'crypto';

import { addressToBytes } from '@epoch/solana';

/**
 * The `inputs_hash` posted with every Fee Index value: SHA-256 over a canonical serialization of the mainnet epoch's
 * per-slot inputs (`slot_fees`), so anyone holding the same per-slot data can recompute it. Version 1:
 *
 * ```text
 * "epoch-fee-index-inputs-v1"                     25 ASCII bytes (domain separator; no length prefix, no NUL)
 * u64 LE  mainnet epoch
 * then one 52-byte record per slot_fees row of that epoch, in ascending slot order (slots without a row are absent):
 *   u64 LE  slot
 *   [u8;32] leader identity (the base58 pubkey's raw bytes)
 *   u64 LE  median_cu_price (micro-lamports per compute unit, leader-paid transactions excluded)
 *   u32 LE  tx_count
 * ```
 *
 * The hash commits to the per-slot fee inputs only; the stake weights of the stake-weighted median are the epoch's
 * public stake distribution and are not part of it.
 */
export const INPUTS_HASH_DOMAIN = 'epoch-fee-index-inputs-v1';
export const SLOT_RECORD_SIZE = 8 + 32 + 8 + 4;

export interface SlotFeeInput {
  slot: number;
  leader: string;
  medianCuPrice: number;
  txCount: number;
}

/** Incremental hasher: `update` slot rows in ascending slot order (any batch size), then `digest`. */
export class InputsHasher {
  private readonly hash: Hash = createHash('sha256');
  private lastSlot = -1;
  private count = 0;

  constructor(readonly epoch: number) {
    const header = Buffer.alloc(INPUTS_HASH_DOMAIN.length + 8);
    header.write(INPUTS_HASH_DOMAIN, 0, 'ascii');
    header.writeBigUInt64LE(BigInt(epoch), INPUTS_HASH_DOMAIN.length);
    this.hash.update(header);
  }

  update(rows: readonly SlotFeeInput[]): this {
    const buffer = Buffer.alloc(rows.length * SLOT_RECORD_SIZE);
    rows.forEach((row, i) => {
      if (!Number.isSafeInteger(row.slot) || row.slot <= this.lastSlot) {
        throw new RangeError(`slot_fees rows must be in strictly ascending slot order (slot ${row.slot})`);
      }
      this.lastSlot = row.slot;
      const at = i * SLOT_RECORD_SIZE;
      buffer.writeBigUInt64LE(BigInt(row.slot), at);
      addressToBytes(row.leader).copy(buffer, at + 8);
      buffer.writeBigUInt64LE(BigInt(row.medianCuPrice), at + 40);
      buffer.writeUInt32LE(row.txCount, at + 48);
    });
    this.hash.update(buffer);
    this.count += rows.length;
    return this;
  }

  /** The 32-byte hash and how many slots went into it. */
  digest(): { hash: Uint8Array; slots: number } {
    return { hash: new Uint8Array(this.hash.digest()), slots: this.count };
  }
}

/** One-shot form of `InputsHasher`. */
export function computeInputsHash(epoch: number, rows: readonly SlotFeeInput[]): Uint8Array {
  return new InputsHasher(epoch).update(rows).digest().hash;
}

export const sameHash = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
