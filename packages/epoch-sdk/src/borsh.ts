/**
 * The slice of Borsh the Epoch program uses: little-endian integers, `bool`, `Pubkey`, fixed byte arrays,
 * `Option<T>` and fieldless enums (one byte, the variant index). Reads are bounds-checked and reject the same
 * malformed input Rust's `borsh` rejects (a bool or Option tag other than 0/1, an unknown enum variant).
 */
import { PublicKey } from '@solana/web3.js';

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

/** Sequential reader over `data`, starting at `offset`. */
export class BorshReader {
  private readonly view: DataView;
  private cursor: number;

  constructor(
    readonly data: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.cursor = offset;
  }

  /** Bytes consumed so far (absolute offset into `data`). */
  get offset(): number {
    return this.cursor;
  }

  get remaining(): number {
    return this.data.length - this.cursor;
  }

  private take(size: number, what: string): number {
    if (this.cursor + size > this.data.length) {
      throw new RangeError(
        `Borsh: unexpected end of data reading ${what} at offset ${this.cursor} (need ${size}, have ${this.remaining})`,
      );
    }
    const at = this.cursor;
    this.cursor += size;
    return at;
  }

  u8(what = 'u8'): number {
    return this.view.getUint8(this.take(1, what));
  }

  u16(what = 'u16'): number {
    return this.view.getUint16(this.take(2, what), true);
  }

  u32(what = 'u32'): number {
    return this.view.getUint32(this.take(4, what), true);
  }

  u64(what = 'u64'): bigint {
    return this.view.getBigUint64(this.take(8, what), true);
  }

  i64(what = 'i64'): bigint {
    return this.view.getBigInt64(this.take(8, what), true);
  }

  bool(what = 'bool'): boolean {
    const v = this.u8(what);
    if (v > 1) throw new RangeError(`Borsh: invalid bool ${v} for ${what} at offset ${this.cursor - 1}`);
    return v === 1;
  }

  /** A copy of the next `length` bytes. */
  bytes(length: number, what = 'bytes'): Uint8Array {
    const at = this.take(length, what);
    return this.data.slice(at, at + length);
  }

  pubkey(what = 'pubkey'): PublicKey {
    return new PublicKey(this.bytes(32, what));
  }

  option<T>(read: () => T, what = 'option'): T | null {
    const tag = this.u8(what);
    if (tag === 0) return null;
    if (tag === 1) return read();
    throw new RangeError(`Borsh: invalid Option tag ${tag} for ${what} at offset ${this.cursor - 1}`);
  }

  /** A fieldless enum: one byte, the index into `variants` (Rust declaration order). */
  variant<T extends string>(variants: readonly T[], what: string): T {
    const index = this.u8(what);
    const value = variants[index];
    if (value === undefined) {
      throw new RangeError(`Borsh: unknown ${what} variant ${index} at offset ${this.cursor - 1}`);
    }
    return value;
  }

  array<T>(length: number, read: () => T): T[] {
    const out: T[] = [];
    for (let i = 0; i < length; i++) out.push(read());
    return out;
  }

  skip(length: number, what = 'padding'): void {
    this.take(length, what);
  }
}

function checkInt(value: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${what} must be an integer in [0, ${max}], got ${String(value)}`);
  }
  return value;
}

function checkBigInt(value: bigint, min: bigint, max: bigint, what: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${what} must be a bigint, got ${typeof value}`);
  if (value < min || value > max) throw new RangeError(`${what} must be in [${min}, ${max}], got ${value}`);
  return value;
}

/** Append-only writer. Every method validates its input range and returns `this`. */
export class BorshWriter {
  private buffer = new Uint8Array(64);
  private view = new DataView(this.buffer.buffer);
  private length = 0;

  /** Grows the buffer if needed and returns the write offset. Call it before reading `this.view`/`this.buffer`: it
   *  replaces both when it grows. */
  private reserve(size: number): number {
    if (this.length + size > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + size));
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.length;
    this.length += size;
    return at;
  }

  u8(value: number, what = 'u8'): this {
    const v = checkInt(value, 0xff, what);
    const at = this.reserve(1);
    this.view.setUint8(at, v);
    return this;
  }

  u16(value: number, what = 'u16'): this {
    const v = checkInt(value, 0xffff, what);
    const at = this.reserve(2);
    this.view.setUint16(at, v, true);
    return this;
  }

  u32(value: number, what = 'u32'): this {
    const v = checkInt(value, 0xffff_ffff, what);
    const at = this.reserve(4);
    this.view.setUint32(at, v, true);
    return this;
  }

  u64(value: bigint, what = 'u64'): this {
    const v = checkBigInt(value, 0n, U64_MAX, what);
    const at = this.reserve(8);
    this.view.setBigUint64(at, v, true);
    return this;
  }

  i64(value: bigint, what = 'i64'): this {
    const v = checkBigInt(value, I64_MIN, I64_MAX, what);
    const at = this.reserve(8);
    this.view.setBigInt64(at, v, true);
    return this;
  }

  bool(value: boolean, what = 'bool'): this {
    if (typeof value !== 'boolean') throw new TypeError(`${what} must be a boolean, got ${typeof value}`);
    return this.u8(value ? 1 : 0, what);
  }

  /** Exactly `length` raw bytes (a Rust `[u8; N]`). */
  fixedBytes(value: Uint8Array, length: number, what = 'bytes'): this {
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new RangeError(`${what} must be a Uint8Array of length ${length}`);
    }
    const at = this.reserve(length);
    this.buffer.set(value, at);
    return this;
  }

  pubkey(value: PublicKey, what = 'pubkey'): this {
    return this.fixedBytes(value.toBytes(), 32, what);
  }

  option<T>(value: T | null | undefined, write: (value: T) => void, what = 'option'): this {
    if (value === null || value === undefined) return this.u8(0, what);
    this.u8(1, what);
    write(value);
    return this;
  }

  /** A fieldless enum: one byte, the index of `value` in `variants`. */
  variant<T extends string>(variants: readonly T[], value: T, what: string): this {
    const index = variants.indexOf(value);
    if (index < 0) throw new TypeError(`Invalid ${what} '${String(value)}'; expected one of: ${variants.join(', ')}`);
    return this.u8(index, what);
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Little-endian `u64::to_le_bytes`, as used in PDA seeds. Accepts a bigint or a safe non-negative integer. */
export function u64ToLeBytes(value: bigint | number, what = 'u64'): Uint8Array {
  const v =
    typeof value === 'number'
      ? BigInt(checkInt(value, Number.MAX_SAFE_INTEGER, what))
      : checkBigInt(value, 0n, U64_MAX, what);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}
