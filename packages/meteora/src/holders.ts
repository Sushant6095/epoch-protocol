/**
 * A revenue token's largest holders for the Launch page: `getTokenLargestAccounts` (the 20 largest token accounts),
 * then one read of those accounts for their owners, labelled when they are a pool vault, the escrow or a known party.
 */
import { type Connection, PublicKey } from '@solana/web3.js';

import { fromBaseUnits } from './units';

export interface TopHolder {
  /** The wallet (or program authority) owning the token account. */
  owner: string | null;
  tokenAccount: string;
  /** Base units, as a decimal string (exact). */
  amount: string;
  /** UI amount. */
  uiAmount: number;
  /** Share of the supply now (supply − burned), %. */
  sharePct: number;
  /** "Curve vault", "DAMM v2 pool", "Buyback escrow"… null for an ordinary holder. */
  label: string | null;
}

/** Labels by token account or by owner. */
export type HolderLabels = Readonly<Record<string, string>>;

/** Maps the largest accounts and their owners to `TopHolder`s (pure). */
export function mapTopHolders(input: {
  accounts: readonly { address: string; amount: bigint }[];
  owners: readonly (string | null)[];
  decimals: number;
  /** Supply now, base units (for the share). */
  supply: bigint;
  labels?: HolderLabels;
}): TopHolder[] {
  const labels = input.labels ?? {};
  return input.accounts
    .map((account, i) => {
      const owner = input.owners[i] ?? null;
      return {
        owner,
        tokenAccount: account.address,
        amount: account.amount.toString(),
        uiAmount: fromBaseUnits(account.amount, input.decimals),
        sharePct: input.supply > 0n ? Number((account.amount * 10_000_000n) / input.supply) / 100_000 : 0,
        label: labels[account.address] ?? (owner ? (labels[owner] ?? null) : null),
      };
    })
    .filter((holder) => holder.amount !== '0');
}

/**
 * The token's largest holders (at most 20, the RPC's limit), largest first. Two RPC calls. `supply` in base units is
 * the mint's supply now; when omitted it is read too.
 */
export async function readTopHolders(params: {
  connection: Connection;
  mint: PublicKey | string;
  decimals: number;
  supply?: bigint;
  labels?: HolderLabels;
  limit?: number;
}): Promise<TopHolder[]> {
  const { connection } = params;
  const mint = new PublicKey(params.mint);
  const [largest, supply] = await Promise.all([
    connection.getTokenLargestAccounts(mint, 'confirmed'),
    params.supply !== undefined
      ? Promise.resolve(params.supply)
      : connection.getTokenSupply(mint, 'confirmed').then((result) => BigInt(result.value.amount)),
  ]);
  const accounts = largest.value
    .slice(0, params.limit ?? 20)
    .map((row) => ({ address: row.address.toBase58(), amount: BigInt(row.amount) }));
  if (accounts.length === 0) return [];
  const infos = await connection.getMultipleAccountsInfo(
    accounts.map((account) => new PublicKey(account.address)),
    'confirmed',
  );
  const owners = infos.map((info) =>
    info && info.data.length >= 64 ? new PublicKey(info.data.subarray(32, 64)).toBase58() : null,
  );
  return mapTopHolders({ accounts, owners, decimals: params.decimals, supply, labels: params.labels });
}
