import { PublicKey } from '@solana/web3.js';

import { addressToBytes, base58ToBytes, bytesToAddress } from './pubkeys';

describe('base58ToBytes', () => {
  it('decodes addresses like PublicKey does', () => {
    for (const address of [
      '11111111111111111111111111111111',
      'Vote111111111111111111111111111111111111111',
      '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    ]) {
      expect(Buffer.from(base58ToBytes(address))).toEqual(new PublicKey(address).toBuffer());
    }
  });

  it('decodes instruction data of any length, keeping leading zero bytes', () => {
    // A System Transfer of 1,000 lamports (u32 LE 2, u64 LE 1,000) as getBlock sends it (encoded with bs58).
    expect(Buffer.from(base58ToBytes('3Bxs4ffTu9T19DNF')).toString('hex')).toBe('02000000e803000000000000');
    expect(Array.from(base58ToBytes('11'))).toEqual([0, 0]);
    expect(Array.from(base58ToBytes(''))).toEqual([]);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base58ToBytes('0OIl')).toThrow('invalid base58 character');
  });

  it('round-trips with the address helpers', () => {
    const address = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe';
    expect(bytesToAddress(base58ToBytes(address))).toBe(address);
    expect(Buffer.from(base58ToBytes(address))).toEqual(addressToBytes(address));
  });
});
