/**
 * Just enough of Solana's transaction wire format to read priority fees: legacy and v0 messages, and the v1 format of
 * SIMD-0385 (live on mainnet; its priority fee is carried inline instead of in a ComputeBudget instruction).
 *
 * legacy / v0: compact-u16 signature count, signatures, [0x80 | version], header (3 bytes), compact-u16 account count,
 *              keys, recent blockhash, compact-u16 instruction count, instructions, [v0: address table lookups]
 * v1:          0x81, header (3), config mask (u32 LE), lifetime (32), instruction count (u8), address count (u8), keys,
 *              config values (4 bytes per mask bit), instruction headers (u8 program, u8 accounts, u16 LE data length),
 *              instruction payloads (account indexes then data), signatures (64 bytes each)
 */

export class WireFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireFormatError';
  }
}

export interface CompiledInstructionView {
  programIdIndex: number;
  /** Indexes into the account keys (static keys, then any lookup-table addresses). */
  accounts: Uint8Array;
  data: Uint8Array;
}

/** The SIMD-0385 inline budget of a v1 transaction. Absent fields fall back to the runtime minimum (fee 0, limit 0). */
export interface TransactionConfigView {
  /** Total priority fee in lamports (mask bits 0 and 1). */
  priorityFeeLamports?: bigint;
  /** Requested compute-unit limit (mask bit 2). */
  computeUnitLimit?: number;
}

export interface MessageView {
  version: 'legacy' | 0 | 1;
  numRequiredSignatures: number;
  /** Static account keys only: a v0 lookup table can never supply a fee payer or an invoked program. */
  accountKeys: Uint8Array[];
  instructions: CompiledInstructionView[];
  /** v1 only. */
  config?: TransactionConfigView;
}

const V1_VERSION_BYTE = 129;
const MASK_PRIORITY_FEE = 0b11;
const MASK_CU_LIMIT = 0b100;

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new WireFormatError(`truncated transaction: need ${n} bytes at ${this.offset} of ${this.bytes.length}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  peek(): number {
    this.need(1);
    return this.bytes[this.offset];
  }

  u16le(): number {
    this.need(2);
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  u32le(): number {
    this.need(4);
    const b = this.bytes;
    const o = this.offset;
    this.offset += 4;
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1_00_00_00;
  }

  u64le(): bigint {
    const lo = BigInt(this.u32le());
    const hi = BigInt(this.u32le());
    return (hi << 32n) | lo;
  }

  /** compact-u16 ("shortvec"). */
  shortVec(): number {
    let value = 0;
    for (let shift = 0; shift <= 14; shift += 7) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new WireFormatError('compact-u16 longer than 3 bytes');
  }

  bytesOf(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  skip(n: number): void {
    this.need(n);
    this.offset += n;
  }
}

function keys(reader: Reader, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) out.push(reader.bytesOf(32));
  return out;
}

function parseV1(reader: Reader): MessageView {
  reader.skip(1); // version byte
  const numRequiredSignatures = reader.u8();
  reader.skip(2); // readonly signed, readonly unsigned
  const mask = reader.u32le();
  reader.skip(32); // lifetime specifier (recent blockhash)
  const instructionCount = reader.u8();
  const addressCount = reader.u8();
  const accountKeys = keys(reader, addressCount);
  const config: TransactionConfigView = {};
  // Values follow in mask-bit order, 4 bytes per set bit; the priority fee uses bits 0 and 1 together (one u64).
  const priorityBits = mask & MASK_PRIORITY_FEE;
  if (priorityBits !== 0 && priorityBits !== MASK_PRIORITY_FEE) {
    throw new WireFormatError('v1 priority-fee mask needs both bits');
  }
  if (priorityBits === MASK_PRIORITY_FEE) config.priorityFeeLamports = reader.u64le();
  if (mask & MASK_CU_LIMIT) config.computeUnitLimit = reader.u32le();
  for (let bit = 3; bit < 32; bit++) if (mask & (1 << bit)) reader.skip(4);
  const headers: [number, number, number][] = [];
  for (let i = 0; i < instructionCount; i++) headers.push([reader.u8(), reader.u8(), reader.u16le()]);
  const instructions = headers.map(([programIdIndex, accountCount, dataLength]) => {
    const accounts = reader.bytesOf(accountCount);
    return { programIdIndex, accounts, data: reader.bytesOf(dataLength) };
  });
  reader.skip(64 * numRequiredSignatures);
  return { version: 1, numRequiredSignatures, accountKeys, instructions, config };
}

function parseLegacyOrV0(reader: Reader): MessageView {
  const signatures = reader.shortVec();
  reader.skip(64 * signatures);
  let version: 'legacy' | 0 = 'legacy';
  if (reader.peek() & 0x80) {
    const v = reader.u8() & 0x7f;
    if (v !== 0) throw new WireFormatError(`unsupported message version ${v}`);
    version = 0;
  }
  const numRequiredSignatures = reader.u8();
  reader.skip(2);
  const accountKeys = keys(reader, reader.shortVec());
  reader.skip(32); // recent blockhash
  const count = reader.shortVec();
  const instructions: CompiledInstructionView[] = [];
  for (let i = 0; i < count; i++) {
    const programIdIndex = reader.u8();
    const accounts = reader.bytesOf(reader.shortVec());
    instructions.push({ programIdIndex, accounts, data: reader.bytesOf(reader.shortVec()) });
  }
  if (version === 0) {
    const lookups = reader.shortVec();
    for (let i = 0; i < lookups; i++) {
      reader.skip(32);
      reader.skip(reader.shortVec());
      reader.skip(reader.shortVec());
    }
  }
  return { version, numRequiredSignatures, accountKeys, instructions };
}

/** Parses a serialized transaction (as RPC `getBlock` returns it with `encoding: 'base64'`). */
export function parseWireTransaction(bytes: Uint8Array): MessageView {
  if (bytes.length === 0) throw new WireFormatError('empty transaction');
  const reader = new Reader(bytes);
  const view = bytes[0] === V1_VERSION_BYTE ? parseV1(reader) : parseLegacyOrV0(reader);
  if (!reader.done) throw new WireFormatError(`${bytes.length - reader.position} trailing bytes`);
  if (view.accountKeys.length === 0) throw new WireFormatError('transaction without accounts');
  return view;
}
