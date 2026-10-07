import { base58ToBytes } from '@epoch/solana';

import { isSimpleVote, priorityFeeOf } from '../Decoding/PriorityFee';
import { parseWireTransaction } from '../Decoding/WireTransaction';
import { type RpcBlock, type RpcBlockTransaction } from '../Rpc/SolanaRpc';
import { type DecodedBlock, type TxFeeInput } from './BlockFees';
import { type FeeMixInstruction, FeeMixTally, isSystemProgram, touchesTipAccount, txFeeMix } from './FeeMix';

/** The pubkey credited with the block's fees (the leader, unless it redirected its block revenue: SIMD-0232). */
export function feeRewardPubkey(rewards: readonly { pubkey: string; rewardType?: string | null }[] | undefined) {
  return rewards?.find((reward) => reward.rewardType === 'Fee')?.pubkey ?? null;
}

/** The block's Fee reward in lamports, or null when it has none. */
export function feeRewardLamports(
  rewards: readonly { lamports: number; rewardType?: string | null }[] | undefined,
): bigint | null {
  const reward = rewards?.find((r) => r.rewardType === 'Fee');
  return reward ? BigInt(reward.lamports) : null;
}

/**
 * The lookup-table addresses of one transaction, and its System Program inner instructions (the only inner instructions
 * that can move a tip), whose base58 data is decoded only when asked (transactions that touch a tip account).
 */
function rpcExtras(meta: RpcBlockTransaction['meta']): {
  loaded: Uint8Array[];
  inner: (keys: readonly Uint8Array[]) => FeeMixInstruction[];
} {
  const loaded = [...(meta?.loadedAddresses?.writable ?? []), ...(meta?.loadedAddresses?.readonly ?? [])].map(
    base58ToBytes,
  );
  const inner = (keys: readonly Uint8Array[]): FeeMixInstruction[] => {
    const out: FeeMixInstruction[] = [];
    for (const group of meta?.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        if (!isSystemProgram(keys[ix.programIdIndex])) continue;
        out.push({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: base58ToBytes(ix.data) });
      }
    }
    return out;
  };
  return { loaded, inner };
}

/** An RPC getBlock (base64, maxSupportedTransactionVersion 1) reduced to the Fee Index inputs and the fee mix. */
export function decodeRpcBlock(slot: number, block: RpcBlock): DecodedBlock {
  const txs: TxFeeInput[] = [];
  const tally = new FeeMixTally();
  let votes = 0;
  let malformed = 0;
  for (const entry of block.transactions) {
    let view;
    try {
      view = parseWireTransaction(Buffer.from(entry.transaction[0], 'base64'));
    } catch {
      malformed++;
      continue;
    }
    const failed = entry.meta?.err !== null && entry.meta?.err !== undefined;
    const extras = rpcExtras(entry.meta);
    const keys = extras.loaded.length > 0 ? [...view.accountKeys, ...extras.loaded] : view.accountKeys;
    const vote = isSimpleVote(view);
    tally.add(
      txFeeMix({
        signatures: view.numRequiredSignatures,
        keys,
        instructions: view.instructions,
        innerInstructions: failed || !touchesTipAccount(keys) ? [] : extras.inner(keys),
        fee: entry.meta?.fee !== undefined ? BigInt(entry.meta.fee) : null,
        failed,
      }),
      vote,
    );
    if (vote) {
      votes++;
      continue;
    }
    txs.push({
      payer: view.accountKeys[0],
      price: priorityFeeOf({
        accountKeys: view.accountKeys,
        instructions: view.instructions,
        v1Config: view.version === 1 ? (view.config ?? {}) : undefined,
      }),
      failed,
    });
  }
  return {
    slot,
    parentSlot: block.parentSlot,
    blockTime: block.blockTime ?? null,
    rewardPubkey: feeRewardPubkey(block.rewards),
    txs,
    votes,
    malformed,
    feeMix: tally.counted(feeRewardLamports(block.rewards)),
  };
}
