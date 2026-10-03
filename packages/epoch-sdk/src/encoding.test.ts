import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';

import { ACCOUNT_DISCRIMINATORS } from './discriminators';
import { base58Decode, base58Encode, base64Decode, base64Encode, bytesEqual, bytesToHex, hexToBytes } from './encoding';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

/** Deterministic pseudo-random bytes (sha256 chain), so failures reproduce. */
function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let block = createHash('sha256').update(`seed:${seed}`).digest();
  for (let i = 0; i < length; i++) {
    if (i % 32 === 0 && i > 0) block = createHash('sha256').update(block).digest();
    out[i] = block[i % 32];
  }
  return out;
}

describe('base58', () => {
  it('matches the reference vectors', () => {
    const ascii = (s: string) => new Uint8Array(Buffer.from(s, 'ascii'));
    expect(base58Encode(new Uint8Array())).toBe('');
    expect(base58Encode(Uint8Array.of(0))).toBe('1');
    expect(base58Encode(Uint8Array.of(0, 0, 0))).toBe('111');
    expect(base58Encode(Uint8Array.of(57))).toBe('z');
    expect(base58Encode(Uint8Array.of(58))).toBe('21');
    expect(base58Encode(ascii('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58Encode(ascii('The quick brown fox jumps over the lazy dog.'))).toBe(
      'USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z',
    );
    expect(base58Encode(Uint8Array.of(0, 0, 0x28, 0x7f, 0xb4, 0xcd))).toBe('11233QC4');
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
  });

  it('agrees with PublicKey.toBase58 on 32-byte keys', () => {
    for (let seed = 0; seed < 300; seed++) {
      const key = bytes(seed, 32);
      if (seed % 3 === 0) key.fill(0, 0, seed % 7); // leading zero bytes
      expect(base58Encode(key)).toBe(new PublicKey(key).toBase58());
    }
  });

  it('round-trips arbitrary lengths, including 8-byte discriminators', () => {
    for (let length = 0; length <= 70; length++) {
      const data = bytes(length + 1000, length);
      if (length % 5 === 0) data.fill(0, 0, Math.min(length, 3));
      expect(bytesEqual(base58Decode(base58Encode(data)), data)).toBe(true);
    }
    for (const discriminator of Object.values(ACCOUNT_DISCRIMINATORS)) {
      const text = base58Encode(discriminator);
      expect(text.length).toBeGreaterThanOrEqual(10);
      expect(bytesEqual(base58Decode(text), discriminator)).toBe(true);
    }
  });

  it('rejects characters outside the alphabet', () => {
    for (const bad of ['0', 'O', 'I', 'l', '+', ' ', 'é']) expect(() => base58Decode(`abc${bad}`)).toThrow(/base58/);
  });
});

describe('base64', () => {
  it('matches Buffer for every length 0..96', () => {
    for (let length = 0; length <= 96; length++) {
      const data = bytes(length + 5000, length);
      const reference = Buffer.from(data).toString('base64');
      expect(base64Encode(data)).toBe(reference);
      expect(bytesEqual(base64Decode(reference), data)).toBe(true);
      expect(bytesEqual(base64Decode(reference.replace(/=+$/, '')), data)).toBe(true);
    }
  });

  it('rejects malformed input', () => {
    expect(() => base64Decode('abcde')).toThrow(/length/);
    expect(() => base64Decode('ab$d')).toThrow(/base64/);
    expect(() => base64Decode('ab-_')).toThrow(/base64/); // base64url is not what Solana logs use
  });
});

describe('hex', () => {
  it('round-trips and rejects bad input', () => {
    const data = bytes(7, 40);
    expect(bytesToHex(data)).toBe(Buffer.from(data).toString('hex'));
    expect(bytesEqual(hexToBytes(bytesToHex(data)), data)).toBe(true);
    expect(hexToBytes('00FFaa')).toEqual(Uint8Array.of(0, 255, 170));
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });
});
