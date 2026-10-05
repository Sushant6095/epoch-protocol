import { PublicKey } from '@solana/web3.js';

import { base58Decode, base58Encode } from './base58';

describe('base58', () => {
  it('round-trips bytes, leading zeros included, and agrees with PublicKey', () => {
    const key = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
    expect(base58Encode(key.toBytes())).toBe(key.toBase58());
    expect(Array.from(base58Decode(key.toBase58()))).toEqual(Array.from(key.toBytes()));
    const zeros = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(zeros))).toEqual(zeros);
    expect(base58Encode(new Uint8Array())).toBe('');
    expect(base58Decode('')).toEqual(new Uint8Array());
    expect(base58Encode(Uint8Array.from([0]))).toBe('1');
  });

  it('decodes Anchor event data and refuses characters outside the alphabet', () => {
    // An Anchor CPI event starts with the event tag e4 45 a5 2e 51 cb 9a 1d.
    const tagged = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d, 7]);
    expect(base58Decode(base58Encode(tagged))).toEqual(tagged);
    expect(() => base58Decode('0OIl')).toThrow(RangeError);
  });
});
