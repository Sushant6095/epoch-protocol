import { PublicKey } from '@solana/web3.js';

import { fromHex, hex, key, type RustAccountExample, toRustJson, vectors } from './__fixtures__/vectors';
import {
  ACCOUNT_SIZES,
  accountFilters,
  decodeAccount,
  decodeAdvance,
  decodeFeeIndex,
  decodeIndexBallot,
  decodeIndexOperators,
  decodeFeeQuote,
  decodeLenderShares,
  decodePool,
  decodeRevenueToken,
  decodeScoreConfig,
  decodeSwapPosition,
  decodeValidatorHistory,
  decodeValidatorPosition,
  decodeWithdrawRequest,
  type FeeIndexAccount,
  type IndexBallotAccount,
  indexBallotStatus,
  feeIndexHistory,
  feeIndexValueFor,
  FIELD_OFFSETS,
  fieldFilter,
  revenueHistory,
  revenueTokenBuybacksPaused,
  revenueTokenCloseMode,
  revenueTokenInTerm,
  revenueTokenMaxImpactBound,
  revenueTokenRedeemOpen,
  revenueTokenTermActive,
  trailingRevenue,
  type ValidatorPositionAccount,
} from './accounts';
import { PROGRAM_CONSTANTS } from './constants';
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
  RevenueToken: decodeRevenueToken,
  ValidatorHistory: decodeValidatorHistory,
  ScoreConfig: decodeScoreConfig,
  IndexOperators: decodeIndexOperators,
  IndexBallot: decodeIndexBallot,
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
      RevenueToken: 503,
      ValidatorHistory: 8352,
      ScoreConfig: 145,
      IndexOperators: 406,
      IndexBallot: 936,
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

describe('ValidatorPosition.revenueToken (the 32 bytes that were _reserved)', () => {
  const byLabel = (label: string): RustAccountExample =>
    vectors.accounts.ValidatorPosition.examples.find((e) => e.label === label)!;

  it('is null when all zeros and the key otherwise, after open_advance like the other tail fields', () => {
    expect(decodeValidatorPosition(fromHex(byLabel('open_advance_none').data)).revenueToken).toBeNull();
    const some = decodeValidatorPosition(fromHex(byLabel('open_advance_some').data));
    expect(some.revenueToken?.toBase58()).toBe(new PublicKey(new Uint8Array(32).fill(0xc3)).toBase58());
    // The account keeps its size: the field took the reserved bytes.
    expect(byLabel('open_advance_some').serializedLen).toBe(ACCOUNT_SIZES.ValidatorPosition);
  });
});

describe('RevenueToken', () => {
  const curve = decodeRevenueToken(fromHex(vectors.accounts.RevenueToken.examples[0].data));
  const graduated = decodeRevenueToken(fromHex(vectors.accounts.RevenueToken.examples[1].data));

  it('reads a fresh registration (no DAMM v2 pool yet, default buyback parameters)', () => {
    expect(curve.status).toBe('curve');
    expect(curve.dammPool).toBeNull();
    expect([curve.slicesPerEpoch, curve.windowSlots, curve.maxSlippageBps, curve.maxImpactBps, curve.flags]).toEqual([
      12, 9_000, 300, 100, 0,
    ]);
    expect(graduated.status).toBe('graduated');
    expect(graduated.dammPool).toBeInstanceOf(PublicKey);
  });

  it('mirrors the term gates', () => {
    const { startEpoch, termEndEpoch } = curve;
    expect(revenueTokenInTerm(curve, startEpoch - 1n)).toBe(false);
    expect(revenueTokenInTerm(curve, startEpoch)).toBe(true);
    expect(revenueTokenInTerm(curve, termEndEpoch - 1n)).toBe(true);
    expect(revenueTokenInTerm(curve, termEndEpoch)).toBe(false);
    // Release and commission cuts wait for the end of the term; so does redeem by default.
    expect(revenueTokenTermActive(curve, startEpoch - 1n)).toBe(true);
    expect(revenueTokenTermActive(curve, termEndEpoch)).toBe(false);
    expect(revenueTokenRedeemOpen(curve, termEndEpoch - 1n)).toBe(false);
    expect(revenueTokenRedeemOpen(curve, termEndEpoch)).toBe(true);
    // The graduated example has both flags set.
    expect(revenueTokenRedeemOpen(graduated, graduated.startEpoch)).toBe(true);
    expect(revenueTokenBuybacksPaused(graduated)).toBe(true);
    expect(revenueTokenBuybacksPaused(curve)).toBe(false);
    // The fee floor (from the Rust examples: 100 bps on the curve, 25 graduated) bounds max_impact_bps at twice it.
    expect([curve.feeFloorBps, graduated.feeFloorBps]).toEqual([100, 25]);
    expect(revenueTokenMaxImpactBound(curve)).toBe(200);
    expect(revenueTokenMaxImpactBound(graduated)).toBe(50);
    expect(revenueTokenMaxImpactBound({ ...curve, feeFloorBps: 600 })).toBe(1_000);
  });

  it('mirrors close_mode: spent after the term, or anything after the grace period', () => {
    const rt = decodeRevenueToken(fromHex(vectors.accounts.RevenueToken.examples[0].data));
    const end = rt.termEndEpoch;
    const dust = PROGRAM_CONSTANTS.MAX_CLOSE_DUST_LAMPORTS;
    const grace = PROGRAM_CONSTANTS.REDEEM_GRACE_EPOCHS;
    expect(revenueTokenCloseMode(rt, end - 1n, 0n)).toBeNull();
    expect(revenueTokenCloseMode(rt, end, dust)).toBe('spent');
    expect(revenueTokenCloseMode(rt, end, dust + 1n)).toBeNull();
    expect(revenueTokenCloseMode(rt, end + grace - 1n, 5n * 10n ** 9n)).toBeNull();
    expect(revenueTokenCloseMode(rt, end + grace, 5n * 10n ** 9n)).toBe('unclaimed');
    expect(revenueTokenCloseMode(rt, end + grace, 0n)).toBe('spent');
  });
});

describe('ValidatorHistory (zero-copy ring indexed by epoch % 64)', () => {
  const byLabel = (label: string) => vectors.accounts.ValidatorHistory.examples.find((e) => e.label === label)!;

  it('reads a fresh account as no entries', () => {
    const h = decodeValidatorHistory(fromHex(byLabel('fresh').data));
    expect(h.entries).toEqual([]);
    expect(h.version).toBe(1);
  });

  it('keeps the newest 64 epochs, oldest first, after the ring wrapped', () => {
    const h = decodeValidatorHistory(fromHex(byLabel('wrapped').data));
    expect(h.entries).toHaveLength(PROGRAM_CONSTANTS.HISTORY_LEN);
    expect(h.entries[0].epoch).toBe(1006n);
    expect(h.entries[63].epoch).toBe(1069n);
    expect(h.entries.every((e, i) => i === 0 || e.epoch === h.entries[i - 1].epoch + 1n)).toBe(true);
  });

  it('reads the all-ones sentinels as null and the oracle bit as a boolean', () => {
    const h = decodeValidatorHistory(fromHex(byLabel('wrapped').data));
    const e1007 = h.entries.find((e) => e.epoch === 1007n)!; // copied credits only
    expect(e1007.voteLamports).toBeNull();
    expect(e1007.mevCommissionBps).toBeNull();
    expect(e1007.rank).toBeNull();
    expect(e1007.superminority).toBeNull();
    expect(e1007.maxCredits).toBe(432_000n * 16n);
    const e1008 = h.entries.find((e) => e.epoch === 1008n)!; // 1008 % 7 == 0: the oracle wrote it
    expect(typeof e1008.superminority).toBe('boolean');
    expect(e1008.rank).not.toBeNull();
  });
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
      RevenueToken: { pool: 8, position: 40, vote: 72, operator: 104, mint: 136, dbcPool: 200 },
      ValidatorHistory: { vote: 8 },
      ScoreConfig: { pool: 8 },
      IndexOperators: { feeIndex: 8 },
      IndexBallot: { feeIndex: 8 },
    });
  });

  it('points at the field bytes in every serialized example (Some and None positions alike)', () => {
    for (const [name, fields] of Object.entries(FIELD_OFFSETS)) {
      for (const example of vectors.accounts[name].examples) {
        const data = fromHex(example.data);
        for (const [field, offset] of Object.entries(fields)) {
          const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
          const expected = base58Decode(example.fields[snake] as string);
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

describe('indexBallotStatus (IndexBallot::status)', () => {
  const ballot = (o: Partial<IndexBallotAccount> = {}) =>
    ({ epoch: 10n, consensusSlot: 0n, proposedSlot: 0n, ...o }) as IndexBallotAccount;
  const index = (o: Partial<FeeIndexAccount> = {}) =>
    ({ epoch: 9n, hasProposal: false, proposedEpoch: 0n, proposedSlot: 0n, ...o }) as FeeIndexAccount;

  it('follows the program: settled, voting, queued, proposed, vetoed', () => {
    expect(indexBallotStatus(ballot({ consensusSlot: 5n, proposedSlot: 5n }), index({ epoch: 10n }))).toBe('settled');
    expect(indexBallotStatus(ballot(), index({ epoch: 12n }))).toBe('settled'); // skipped over by a later final
    expect(indexBallotStatus(ballot(), index())).toBe('voting');
    expect(indexBallotStatus(ballot({ consensusSlot: 5n }), index())).toBe('queued');
    const pending = index({ hasProposal: true, proposedEpoch: 10n, proposedSlot: 7n });
    expect(indexBallotStatus(ballot({ consensusSlot: 5n, proposedSlot: 7n }), pending)).toBe('proposed');
    expect(indexBallotStatus(ballot({ consensusSlot: 5n, proposedSlot: 7n }), index())).toBe('vetoed');
    // Another proposal in the slot (a post_index of the same epoch at another slot) is not this ballot's.
    expect(indexBallotStatus(ballot({ consensusSlot: 5n, proposedSlot: 6n }), pending)).toBe('vetoed');
  });
});
