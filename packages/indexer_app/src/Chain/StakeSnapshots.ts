import { type SolanaRpc } from '../Rpc/SolanaRpc';

export interface StakeSnapshot {
  epoch: number;
  /** Lamports of activated stake per validator identity (summed over its vote accounts). */
  byIdentity: Map<string, bigint>;
  /** Vote account → identity, to map a block-revenue collector set to the vote account (SIMD-0232). */
  voteToIdentity: Map<string, string>;
}

/** u64 stake from JSON: exact below 2^53; above it (no validator is near 9 M SOL… yet) at most a few lamports off. */
const lamports = (value: number): bigint => BigInt(Math.max(0, Math.round(value)));

/**
 * The epoch's stake distribution from getVoteAccounts (Solami RPC). Called while `epoch` is the cluster's current
 * epoch, so `activatedStake` is that epoch's stake; delinquent validators keep their stake and their slots.
 */
export async function fetchStakeSnapshot(
  rpc: Pick<SolanaRpc, 'getVoteAccounts'>,
  epoch: number,
): Promise<StakeSnapshot> {
  const { current, delinquent } = await rpc.getVoteAccounts();
  const byIdentity = new Map<string, bigint>();
  const voteToIdentity = new Map<string, string>();
  for (const account of [...current, ...delinquent]) {
    voteToIdentity.set(account.votePubkey, account.nodePubkey);
    if (account.activatedStake <= 0) continue;
    byIdentity.set(account.nodePubkey, (byIdentity.get(account.nodePubkey) ?? 0n) + lamports(account.activatedStake));
  }
  return { epoch, byIdentity, voteToIdentity };
}
