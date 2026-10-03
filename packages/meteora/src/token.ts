/**
 * SPL mint and token-account reads for a revenue token: supply (and so what was burned), decimals, the mint authority,
 * and how many accounts hold it. Layouts are decoded by hand (no spl-token dependency), from plain bytes.
 */
import { type Connection, type GetProgramAccountsFilter, PublicKey } from '@solana/web3.js';

import { TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from './constants';
import { fromBaseUnits } from './units';

export interface DecodedMint {
  /** Base58, or null when revoked (a fixed-supply token). */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Base units. */
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
}

export interface TokenMintInfo extends DecodedMint {
  mint: string;
  /** The program that owns the mint: SPL Token or Token-2022. */
  tokenProgram: string;
  /** Supply in UI units. */
  uiSupply: number;
}

const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

const optionalKey = (data: Uint8Array, offset: number): string | null =>
  view(data).getUint32(offset, true) === 1 ? new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58() : null;

/** Decodes the 82-byte SPL mint layout (Token-2022 mints share it; extensions follow). */
export function decodeMintAccount(data: Uint8Array): DecodedMint {
  if (data.length < 82) throw new RangeError(`mint account too short: ${data.length} bytes`);
  return {
    mintAuthority: optionalKey(data, 0),
    supply: view(data).getBigUint64(36, true),
    decimals: data[44],
    isInitialized: data[45] === 1,
    freezeAuthority: optionalKey(data, 46),
  };
}

/** Reads a mint account; null when it does not exist. */
export async function readTokenMint(params: {
  connection: Connection;
  mint: PublicKey | string;
}): Promise<TokenMintInfo | null> {
  const mint = new PublicKey(params.mint);
  const account = await params.connection.getAccountInfo(mint, 'confirmed');
  if (!account) return null;
  const decoded = decodeMintAccount(account.data);
  return {
    ...decoded,
    mint: mint.toBase58(),
    tokenProgram: account.owner.toBase58(),
    uiSupply: fromBaseUnits(decoded.supply, decoded.decimals),
  };
}

/** One token account read as a 40-byte slice from offset 32: owner (32) and amount (u64). */
export interface TokenAccountSlice {
  address: string;
  owner: string;
  amount: bigint;
}

export const decodeTokenAccountSlice = (address: string, slice: Uint8Array): TokenAccountSlice => ({
  address,
  owner: new PublicKey(slice.subarray(0, 32)).toBase58(),
  amount: view(slice).getBigUint64(32, true),
});

export interface TokenHolders {
  /** Token accounts with a balance above zero. */
  holders: number;
  /** The same, without the excluded accounts and owners (pool vaults, the escrow, the leftover receiver). */
  holdersExcluding: number;
}

/** Counts holders from decoded slices (pure: the RPC read is in `countTokenHolders`). */
export function tallyHolders(
  accounts: readonly TokenAccountSlice[],
  exclude: { accounts?: readonly string[]; owners?: readonly string[] } = {},
): TokenHolders {
  const skipAccounts = new Set(exclude.accounts ?? []);
  const skipOwners = new Set(exclude.owners ?? []);
  let holders = 0;
  let holdersExcluding = 0;
  for (const account of accounts) {
    if (account.amount === 0n) continue;
    holders += 1;
    if (!skipAccounts.has(account.address) && !skipOwners.has(account.owner)) holdersExcluding += 1;
  }
  return { holders, holdersExcluding };
}

/**
 * The RPC filter `tokenAccountState` (token accounts only, any size), which lets the RPC answer a Token-2022 query from
 * its mint index. web3.js types only memcmp and dataSize filters and maps filters with `'memcmp' in filter`, so the
 * filter is a String object: it passes that check and serializes as the plain `"tokenAccountState"` the RPC expects.
 */
export const TOKEN_ACCOUNT_STATE_FILTER = new String('tokenAccountState') as unknown as GetProgramAccountsFilter;

/**
 * Filters for every token account of `mint`, in the shape RPC nodes serve from their mint index: the mint at offset 0,
 * plus `dataSize: 165` for classic SPL token accounts or `tokenAccountState` for Token-2022 ones (they can carry
 * extensions, so their size varies).
 */
export function holderFilters(mint: PublicKey, tokenProgram: PublicKey): GetProgramAccountsFilter[] {
  const byMint: GetProgramAccountsFilter = { memcmp: { offset: 0, bytes: mint.toBase58() } };
  return tokenProgram.equals(TOKEN_PROGRAM_ID)
    ? [{ dataSize: TOKEN_ACCOUNT_SIZE }, byMint]
    : [byMint, TOKEN_ACCOUNT_STATE_FILTER];
}

/**
 * Every token account of `mint` with a balance (one `getProgramAccounts` on the mint's token program, filtered on the
 * mint, 40-byte slices). Heavy for popular tokens; cache the result.
 */
export async function countTokenHolders(params: {
  connection: Connection;
  mint: PublicKey | string;
  /** Default: SPL Token. Pass the mint's owner (`readTokenMint().tokenProgram`) for Token-2022 mints. */
  tokenProgram?: PublicKey | string;
  exclude?: { accounts?: readonly string[]; owners?: readonly string[] };
}): Promise<TokenHolders> {
  const mint = new PublicKey(params.mint);
  const program = new PublicKey(params.tokenProgram ?? TOKEN_PROGRAM_ID);
  const filters = holderFilters(mint, program);
  const accounts = await params.connection.getProgramAccounts(program, {
    commitment: 'confirmed',
    filters,
    dataSlice: { offset: 32, length: 40 },
  });
  return tallyHolders(
    accounts.map(({ pubkey, account }) => decodeTokenAccountSlice(pubkey.toBase58(), account.data)),
    params.exclude,
  );
}
