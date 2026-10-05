import { PublicKey } from '@solana/web3.js';

import { IdlCoder, type IdlLike } from './idlCoder';

const IDL: IdlLike = {
  instructions: [
    { name: 'do_it', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: 'payer' }, { name: 'pool' }] },
  ],
  events: [{ name: 'EvtThing', discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }],
  types: [
    {
      name: 'EvtThing',
      type: {
        kind: 'struct',
        fields: [
          { name: 'owner_key', type: 'pubkey' },
          { name: 'amount_in', type: 'u64' },
          { name: 'sqrt_price', type: 'u128' },
          { name: 'delta', type: 'i64' },
          { name: 'flag', type: 'bool' },
          { name: 'maybe', type: { option: 'u16' } },
          { name: 'list', type: { vec: 'u8' } },
          { name: 'pair', type: { array: ['u32', 2] } },
          { name: 'inner', type: { defined: { name: 'Inner' } } },
          { name: 'mode', type: { defined: { name: 'Mode' } } },
        ],
      },
    },
    { name: 'Inner', type: { kind: 'struct', fields: [{ name: 'label', type: 'string' }] } },
    { name: 'Mode', type: { kind: 'enum', variants: [{ name: 'ExactIn' }, { name: 'PartialFill' }] } },
  ],
};

const le = (value: bigint, bytes: number) =>
  Array.from({ length: bytes }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

describe('IdlCoder', () => {
  it('decodes an event struct from the IDL, camelCasing the field names', () => {
    const owner = new PublicKey(new Uint8Array(32).fill(5));
    const data = Uint8Array.from([
      ...[9, 9, 9, 9, 9, 9, 9, 9],
      ...owner.toBytes(),
      ...le(18_446_744_073_709_551_615n, 8),
      ...le((1n << 100n) + 7n, 16),
      ...le((1n << 64n) - 5n, 8), // -5 as i64
      1,
      ...[1, ...le(300n, 2)],
      ...[...le(3n, 4), 10, 20, 30],
      ...[...le(1n, 4), ...le(2n, 4)],
      ...[...le(2n, 4), 104, 105],
      1,
    ]);
    expect(new IdlCoder(IDL).decodeEvent(data)).toEqual({
      name: 'EvtThing',
      data: {
        ownerKey: owner.toBase58(),
        amountIn: 18_446_744_073_709_551_615n,
        sqrtPrice: (1n << 100n) + 7n,
        delta: -5n,
        flag: true,
        maybe: 300,
        list: [10, 20, 30],
        pair: [1, 2],
        inner: { label: 'hi' },
        mode: 'PartialFill',
      },
    });
  });

  it('returns null for other data, and names instructions by discriminator', () => {
    const coder = new IdlCoder(IDL);
    expect(coder.decodeEvent(Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]))).toBeNull();
    expect(coder.instruction(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0]))).toEqual({
      name: 'do_it',
      accounts: ['payer', 'pool'],
    });
    expect(coder.instruction(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(() => coder.decodeEvent(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9, 1]))).toThrow('ended early');
  });
});
