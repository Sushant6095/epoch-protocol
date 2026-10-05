import { isSimpleVote, priorityFeeOf } from '../Decoding/PriorityFee';
import { parseWireTransaction } from '../Decoding/WireTransaction';
import { type RpcBlock } from '../Rpc/SolanaRpc';
import { type DecodedBlock, type TxFeeInput } from './BlockFees';

/** The pubkey credited with the block's fees (the leader, unless it redirected its block revenue: SIMD-0232). */
export function feeRewardPubkey(rewards: readonly { pubkey: string; rewardType?: string | null }[] | undefined) {
  return rewards?.find((reward) => reward.rewardType === 'Fee')?.pubkey ?? null;
}

/** An RPC getBlock (base64, maxSupportedTransactionVersion 1) reduced to the Fee Index inputs. */
export function decodeRpcBlock(slot: number, block: RpcBlock): DecodedBlock {
  const txs: TxFeeInput[] = [];
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
    if (isSimpleVote(view)) {
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
      failed: entry.meta?.err !== null && entry.meta?.err !== undefined,
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
  };
}
