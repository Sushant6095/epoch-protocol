import { PublicKey } from '@solana/web3.js';

import { BorshReader, BorshWriter, I64_MAX, I64_MIN, U64_MAX, u64ToLeBytes } from './borsh';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('BorshWriter / BorshReader', () => {
  it('round-trips every supported type, little-endian', () => {
    const key = new PublicKey(new Uint8Array(32).fill(9));
    const w = new BorshWriter();
    w.u8(0xab)
      .u16(0x1234)
      .u32(0xdeadbeef)
      .u64(U64_MAX)
      .i64(I64_MIN)
      .i64(-2n)
      .bool(true)
      .bool(false)
      .pubkey(key)
      .fixedBytes(Uint8Array.of(1, 2, 3), 3)
      .option<number>(null, (v) => w.u8(v))
      .option<number>(7, (v) => w.u8(v))
      .variant(['a', 'b', 'c'] as const, 'c', 'letter');
    const bytes = w.toBytes();
    expect(hex(bytes.subarray(0, 7))).toBe('ab3412efbeadde');
    expect(bytes.length).toBe(1 + 2 + 4 + 8 + 8 + 8 + 1 + 1 + 32 + 3 + 1 + 2 + 1);

    const r = new BorshReader(bytes);
    expect(r.u8()).toBe(0xab);
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.u64()).toBe(U64_MAX);
    expect(r.i64()).toBe(I64_MIN);
    expect(r.i64()).toBe(-2n);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.pubkey().equals(key)).toBe(true);
    expect(r.bytes(3)).toEqual(Uint8Array.of(1, 2, 3));
    expect(r.option(() => r.u8())).toBeNull();
    expect(r.option(() => r.u8())).toBe(7);
    expect(r.variant(['a', 'b', 'c'] as const, 'letter')).toBe('c');
    expect(r.remaining).toBe(0);
  });

  it('grows past its initial buffer', () => {
    const w = new BorshWriter();
    for (let i = 0; i < 100; i++) w.u64(BigInt(i));
    const r = new BorshReader(w.toBytes());
    for (let i = 0; i < 100; i++) expect(r.u64()).toBe(BigInt(i));
  });

  it('reads at an offset inside a larger buffer view', () => {
    const backing = new Uint8Array([0xff, 0xff, 0x01, 0x00, 0x02]);
    const r = new BorshReader(backing.subarray(1), 1);
    expect(r.u16()).toBe(1);
    expect(r.u8()).toBe(2);
  });

  it('rejects out-of-range values on write', () => {
    const w = new BorshWriter();
    expect(() => w.u8(256)).toThrow(RangeError);
    expect(() => w.u8(-1)).toThrow(RangeError);
    expect(() => w.u16(1.5)).toThrow(RangeError);
    expect(() => w.u32(2 ** 32)).toThrow(RangeError);
    expect(() => w.u64(-1n)).toThrow(RangeError);
    expect(() => w.u64(U64_MAX + 1n)).toThrow(RangeError);
    expect(() => w.u64(1 as unknown as bigint)).toThrow(TypeError);
    expect(() => w.i64(I64_MAX + 1n)).toThrow(RangeError);
    expect(() => w.bool(1 as unknown as boolean)).toThrow(TypeError);
    expect(() => w.fixedBytes(new Uint8Array(31), 32)).toThrow(RangeError);
    expect(() => w.variant(['a'], 'b' as 'a', 'letter')).toThrow(/Invalid letter/);
  });

  it('rejects what Rust borsh rejects on read', () => {
    expect(() => new BorshReader(Uint8Array.of(2)).bool('flag')).toThrow(/invalid bool 2 for flag/);
    expect(() => new BorshReader(Uint8Array.of(2, 0)).option(() => 0)).toThrow(/Option tag 2/);
    expect(() => new BorshReader(Uint8Array.of(3)).variant(['a', 'b'], 'letter')).toThrow(/unknown letter variant 3/);
    expect(() => new BorshReader(new Uint8Array(7)).u64('cash')).toThrow(/end of data reading cash at offset 0/);
    expect(() => new BorshReader(new Uint8Array(31)).pubkey()).toThrow(/end of data/);
    const r = new BorshReader(new Uint8Array(4));
    r.skip(3);
    expect(() => r.u16()).toThrow(/need 2, have 1/);
  });
});

describe('u64ToLeBytes', () => {
  it('encodes bigints and safe integers identically', () => {
    expect(hex(u64ToLeBytes(0n))).toBe('0000000000000000');
    expect(hex(u64ToLeBytes(1))).toBe('0100000000000000');
    expect(hex(u64ToLeBytes(0x0102030405060708n))).toBe('0807060504030201');
    expect(hex(u64ToLeBytes(U64_MAX))).toBe('ffffffffffffffff');
    expect(u64ToLeBytes(Number.MAX_SAFE_INTEGER)).toEqual(u64ToLeBytes(BigInt(Number.MAX_SAFE_INTEGER)));
  });

  it('rejects negatives, fractions, unsafe numbers and overflow', () => {
    expect(() => u64ToLeBytes(-1)).toThrow(RangeError);
    expect(() => u64ToLeBytes(1.5)).toThrow(RangeError);
    expect(() => u64ToLeBytes(2 ** 53)).toThrow(RangeError);
    expect(() => u64ToLeBytes(U64_MAX + 1n)).toThrow(RangeError);
  });
});
