import { PublicKey } from '@solana/web3.js';

import { fromHex, hex, key, type RustAccountExample, toRustJson, vectors } from './__fixtures__/vectors';
import {
  ACCOUNT_SIZES,
  accountFilters,
  decodeAccount,
  decodeAdvance,
  decodeFeeIndex,
  decodeFeeQuote,
  decodeLenderShares,
  decodePool,
  decodeSwapPosition,
  decodeValidatorPosition,
  decodeWithdrawRequest,
  type FeeIndexAccount,
  feeIndexHistory,
  feeIndexValueFor,
  FIELD_OFFSETS,
  fieldFilter,
  revenueHistory,
  trailingRevenue,
  type ValidatorPositionAccount,
} from './accounts';
import { ACCOUNT_DISCRIMINATORS, ACCOUNT_NAMES, type AccountName } from './discriminators';
import { base58Decode } from './encoding';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

const DECODERS: Record<AccountName, (data: Uint8Array) => unknown> = {
  Pool: decodePool,
  LenderShares: decodeLenderShares,
  WithdrawRequest: decodeWithdrawRequest,
  ValidatorPosition: decodeValidatorPosition,
  Advance: decodeAdvance,
  FeeIndex: decodeFeeIndex,
  FeeQuote: decodeFeeQuote,
  SwapPosition: decodeSwapPosition,
};

const examples = ACCOUNT_NAMES.flatMap((name) =>
  vectors.accounts[name].examples.map((example) => [`${name} ${example.label}`, name, example] as const),
);

describe('account layout matches the program (8 + INIT_SPACE)', () => {
  it.each(ACCOUNT_NAMES)('%s size and discriminator', (name) => {
    const entry = vectors.accounts[name];
    expect(ACCOUNT_SIZES[name]).toBe(entry.size);
    expect(entry.size).toBe(8 + entry.initSpace);
    expect(hex(ACCOUNT_DISCRIMINATORS[name])).toBe(entry.discriminator);
    for (const example of entry.examples) expect(example.data.length / 2).toBe(entry.size);
  });

  it('has the sizes the program allocates', () => {
    expect({ ...ACCOUNT_SIZES }).toEqual({
      Pool: 374,
      LenderShares: 130,
      WithdrawRequest: 115,
      ValidatorPosition: 415,
      Advance: 196,
      FeeIndex: 486,
      FeeQuote: 151,
      SwapPosition: 133,
    });
  });
});

describe('decoders reproduce every field of the Rust-serialized accounts', () => {
  it.each(examples)('%s', (_label, name, example) => {
    const data = fromHex(example.data);
    const decoded = DECODERS[name](data);
    expect(toRustJson(decoded)).toEqual(example.fields);

    const generic = decodeAccount(data);
    expect(generic?.name).toBe(name);
    expect(toRustJson(generic?.account)).toEqual(example.fields);
  });

  it('decodes exactly the Borsh bytes, ignoring the allocation tail', () => {
    for (const [, name, example] of examples) {
      const data = fromHex(example.data);
      const trimmed = data.slice(0, example.serializedLen);
      expect(toRustJson(DECODERS[name](trimmed))).toEqual(example.fields);
      // One byte short of the serialized form must fail, not read garbage.
      expect(() => DECODERS[name](trimmed.slice(0, -1))).toThrow(RangeError);
    }
  });
});

describe('ValidatorPosition and its Option<Pubkey>', () => {
  const byLabel = (label: string): RustAccountExample =>
    vectors.accounts.ValidatorPosition.examples.find((e) => e.label === label)!;

  it('shifts every field after open_advance by 32 bytes when it is None', () => {
    const some = byLabel('open_advance_some');
    const none = byLabel('open_advance_none');
    expect(some.serializedLen).toBe(415);
    expect(none.serializedLen).toBe(383);
    expect(decodeValidatorPosition(fromHex(some.data)).openAdvance).toBeInstanceOf(PublicKey);
    expect(decodeValidatorPosition(fromHex(none.data)).openAdvance).toBeNull();
  });

  it('decodes a Some → None rewrite that left stale bytes in the tail', () => {
    const rewritten = byLabel('open_advance_none_over_some');
    const data = fromHex(rewritten.data);
    expect(hex(data.subarray(383))).not.toBe('00'.repeat(32)); // stale tail is really there
    const position = decodeValidatorPosition(data);
    expect(position.openAdvance).toBeNull();
    expect(position.status).toBe('defaulted');
    expect(toRustJson(position)).toEqual(rewritten.fields);
  });

  it.each(vectors.accounts.ValidatorPosition.examples.map((e) => [e.label, e] as const))(
    'revenue ring %s: history oldest → newest and trailing_revenue',
    (_label, example) => {
      const position: ValidatorPositionAccount = decodeValidatorPosition(fromHex(example.data));
      const pushed = example.pushedRevenue!.map(BigInt);
      expect(revenueHistory(position)).toEqual(pushed.slice(-Math.min(pushed.length, 10)));
      expect(trailingRevenue(position).toString()).toBe(example.trailingRevenue);
    },
  );
});

describe('FeeIndex history', () => {
  it.each(vectors.accounts.FeeIndex.examples.map((e) => [e.label, e] as const))('%s', (_label, example) => {
    const index: FeeIndexAccount = decodeFeeIndex(fromHex(example.data));
    const pushed = example.pushedHistory!.map((p) => ({ epoch: BigInt(p.epoch), value: BigInt(p.value) }));
    expect(feeIndexHistory(index)).toEqual(pushed.slice(-Math.min(pushed.length, 16)));
    for (const probe of example.valueFor!) {
      const got = feeIndexValueFor(index, BigInt(probe.epoch));
      expect(got === null ? null : got.toString()).toBe(probe.value);
    }
  });
});

describe('FIELD_OFFSETS', () => {
  it('has the computed offsets', () => {
    expect(JSON.parse(JSON.stringify(FIELD_OFFSETS))).toEqual({
      LenderShares: { pool: 8, owner: 40 },
      WithdrawRequest: { pool: 8, owner: 40 },
      ValidatorPosition: { pool: 8, vote: 40, operator: 104 },
      Advance: { pool: 8, vote: 40 },
      FeeQuote: { pool: 8, maker: 40 },
      SwapPosition: { quote: 8, taker: 40 },
    });
  });

  it('points at the field bytes in every serialized example (Some and None positions alike)', () => {
    for (const [name, fields] of Object.entries(FIELD_OFFSETS)) {
      for (const example of vectors.accounts[name].examples) {
        const data = fromHex(example.data);
        for (const [field, offset] of Object.entries(fields)) {
          const expected = base58Decode(example.fields[field] as string);
          expect(hex(data.subarray(offset, offset + 32))).toBe(hex(expected));
        }
      }
    }
  });
});

describe('getProgramAccounts filters', () => {
  it.each(ACCOUNT_NAMES)('accountFilters(%s) = discriminator memcmp + dataSize', (name) => {
    const [memcmp, size] = accountFilters(name);
    expect(memcmp).toEqual({ memcmp: { offset: 0, bytes: expect.any(String) } });
    expect(size).toEqual({ dataSize: ACCOUNT_SIZES[name] });
    if (!('memcmp' in memcmp)) throw new Error('expected memcmp');
    expect(hex(base58Decode(memcmp.memcmp.bytes))).toBe(vectors.accounts[name].discriminator);
  });

  it('fieldFilter builds a memcmp at the field offset', () => {
    const owner = key('Vote111111111111111111111111111111111111111');
    expect(fieldFilter('LenderShares', 'owner', owner)).toEqual({ memcmp: { offset: 40, bytes: owner.toBase58() } });
    expect(fieldFilter('ValidatorPosition', 'operator', owner)).toEqual({
      memcmp: { offset: 104, bytes: owner.toBase58() },
    });
    expect(fieldFilter('SwapPosition', 'quote', owner)).toEqual({ memcmp: { offset: 8, bytes: owner.toBase58() } });
  });

  it('fieldFilter throws for unsupported combinations', () => {
    const k = PublicKey.default;
    expect(() => fieldFilter('Pool', 'admin', k)).toThrow(/No fixed-offset pubkey field 'admin' on Pool/);
    expect(() => fieldFilter('FeeIndex', 'pool', k)).toThrow(/supported/);
    expect(() => fieldFilter('ValidatorPosition', 'openAdvance', k)).toThrow();
    expect(() => fieldFilter('ValidatorPosition', 'payout', k)).toThrow();
    expect(() => fieldFilter('LenderShares', 'toString', k)).toThrow();
    expect(() => fieldFilter('LenderShares', '__proto__', k)).toThrow();
    expect(() => fieldFilter('Nope' as AccountName, 'pool', k)).toThrow();
    expect(() => accountFilters('Nope' as AccountName)).toThrow(/Unknown account type/);
  });
});

describe('decoder errors', () => {
  const pool = fromHex(vectors.accounts.Pool.examples[0].data);

  it('rejects a wrong discriminator', () => {
    expect(() => decodeLenderShares(pool)).toThrow(/not a LenderShares account/);
    expect(() => decodePool(new Uint8Array(374))).toThrow(/discriminator mismatch/);
    expect(() => decodePool(pool.subarray(0, 7))).toThrow(/discriminator mismatch/);
  });

  it('rejects short data', () => {
    expect(() => decodePool(pool.subarray(0, 100))).toThrow(/unexpected end of data/);
  });

  it('rejects the bytes Borsh rejects (bool, enum)', () => {
    const badBool = pool.slice();
    badBool[8 + 96 + 59 + 2] = 2; // Pool.paused
    expect(() => decodePool(badBool)).toThrow(/invalid bool 2 for paused/);

    const lender = fromHex(vectors.accounts.LenderShares.examples[0].data);
    lender[72] = 2; // LenderShares.tranche
    expect(() => decodeLenderShares(lender)).toThrow(/unknown tranche variant 2/);
  });

  it('decodeAccount returns null for unknown discriminators and throws for malformed known ones', () => {
    expect(decodeAccount(new Uint8Array(500))).toBeNull();
    expect(decodeAccount(new Uint8Array(3))).toBeNull();
    expect(() => decodeAccount(pool.subarray(0, 50))).toThrow(RangeError);
  });

  it('does not alias the input buffer', () => {
    const data = fromHex(vectors.accounts.FeeIndex.examples[0].data);
    const index = decodeFeeIndex(data);
    const before = hex(index.inputsHash);
    data.fill(0);
    expect(hex(index.inputsHash)).toBe(before);
  });
});
