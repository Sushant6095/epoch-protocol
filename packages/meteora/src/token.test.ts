import { PublicKey } from '@solana/web3.js';

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants';
import { decodeMintAccount, decodeTokenAccountSlice, holderFilters, tallyHolders } from './token';

const key = (seed: number): PublicKey => new PublicKey(new Uint8Array(32).fill(seed));

/** An 82-byte SPL mint: COption<authority>, supply, decimals, initialized, COption<freeze authority>. */
function mintBytes(opts: { authority?: PublicKey; supply: bigint; decimals: number; freeze?: PublicKey }): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  if (opts.authority) {
    view.setUint32(0, 1, true);
    data.set(opts.authority.toBytes(), 4);
  }
  view.setBigUint64(36, opts.supply, true);
  data[44] = opts.decimals;
  data[45] = 1;
  if (opts.freeze) {
    view.setUint32(46, 1, true);
    data.set(opts.freeze.toBytes(), 50);
  }
  return data;
}

function slice(owner: PublicKey, amount: bigint): Uint8Array {
  const data = new Uint8Array(40);
  data.set(owner.toBytes(), 0);
  new DataView(data.buffer).setBigUint64(32, amount, true);
  return data;
}

describe('decodeMintAccount', () => {
  it('reads a fixed-supply mint with no authorities', () => {
    expect(decodeMintAccount(mintBytes({ supply: 98_570_000_000n, decimals: 6 }))).toEqual({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 98_570_000_000n,
      decimals: 6,
      isInitialized: true,
    });
  });

  it('reads the authorities when set, from a slice of a larger buffer', () => {
    const bytes = mintBytes({ authority: key(9), supply: 1n, decimals: 9, freeze: key(8) });
    const padded = new Uint8Array(100);
    padded.set(bytes, 10);
    const decoded = decodeMintAccount(padded.subarray(10, 92));
    expect(decoded.mintAuthority).toBe(key(9).toBase58());
    expect(decoded.freezeAuthority).toBe(key(8).toBase58());
  });

  it('refuses a short account', () => {
    expect(() => decodeMintAccount(new Uint8Array(40))).toThrow(RangeError);
  });
});

describe('holderFilters', () => {
  const mint = key(1);

  it('asks for 165-byte accounts of the mint on SPL Token', () => {
    expect(holderFilters(mint, TOKEN_PROGRAM_ID)).toEqual([
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ]);
  });

  it('asks for token accounts of the mint on Token-2022, serialized as the RPC expects', () => {
    const filters = holderFilters(mint, TOKEN_2022_PROGRAM_ID);
    expect(JSON.parse(JSON.stringify(filters))).toEqual([
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
      'tokenAccountState',
    ]);
    // web3.js maps filters with `'memcmp' in filter`, which throws on a primitive string.
    expect(filters.map((filter) => 'memcmp' in filter)).toEqual([true, false]);
  });
});

describe('holders', () => {
  const vault = 'vault-account';
  const accounts = [
    decodeTokenAccountSlice(vault, slice(key(1), 90_000_000_000n)),
    decodeTokenAccountSlice('a', slice(key(2), 5n)),
    decodeTokenAccountSlice('b', slice(key(3), 0n)),
    decodeTokenAccountSlice('c', slice(key(4), 7n)),
    decodeTokenAccountSlice('d', slice(key(5), 1n)),
  ];

  it('decodes owner and amount from a 40-byte slice', () => {
    expect(accounts[1]).toEqual({ address: 'a', owner: key(2).toBase58(), amount: 5n });
  });

  it('counts accounts with a balance, then without the pool vault and excluded owners', () => {
    expect(tallyHolders(accounts)).toEqual({ holders: 4, holdersExcluding: 4 });
    expect(tallyHolders(accounts, { accounts: [vault], owners: [key(5).toBase58()] })).toEqual({
      holders: 4,
      holdersExcluding: 2,
    });
  });
});
