import { SubscribeUpdate } from '@epoch/solana';

import { parseWireTransaction } from '../Decoding/WireTransaction';
import { isSimpleVote } from '../Decoding/PriorityFee';
import { type RecordedBlock } from './mainnetBlocks';

/**
 * Yellowstone `SubscribeUpdate` fixtures built from the recorded RPC blocks: what the firehose request delivers for the
 * same slot (each non-vote transaction, then the block meta), passed through the real protobuf codec
 * (encode → decode) so field presence, u64-as-string and byte fields behave exactly as on the wire.
 */
export function grpcUpdatesFor(recorded: RecordedBlock, options: { includeVotes?: boolean } = {}): SubscribeUpdate[] {
  const slot = String(recorded.slot);
  const updates: SubscribeUpdate[] = [];
  recorded.block.transactions.forEach((entry, index) => {
    const raw = Buffer.from(entry.transaction[0], 'base64');
    const view = parseWireTransaction(raw);
    const isVote = isSimpleVote(view);
    if (isVote && !options.includeVotes) return;
    // legacy / v0 put the signatures first (after a 1-byte count); v1 puts them last.
    const signature =
      view.version === 1
        ? raw.subarray(raw.length - 64 * view.numRequiredSignatures).subarray(0, 64)
        : raw.subarray(1, 65);
    const config =
      view.version === 1
        ? {
            priorityFee: view.config?.priorityFeeLamports?.toString(),
            computeUnitLimit: view.config?.computeUnitLimit,
          }
        : undefined;
    updates.push(
      SubscribeUpdate.fromPartial({
        filters: ['fees'],
        transaction: {
          slot,
          transaction: {
            signature,
            isVote,
            index: String(index),
            transaction: {
              signatures: [signature],
              message: {
                header: {
                  numRequiredSignatures: view.numRequiredSignatures,
                  numReadonlySignedAccounts: 0,
                  numReadonlyUnsignedAccounts: 0,
                },
                accountKeys: view.accountKeys,
                recentBlockhash: new Uint8Array(32),
                instructions: view.instructions.map((ix) => ({
                  programIdIndex: ix.programIdIndex,
                  accounts: new Uint8Array(0),
                  data: ix.data,
                })),
                versioned: view.version !== 'legacy',
                addressTableLookups: [],
                config,
              },
            },
            meta: {
              err: entry.meta?.err ? { err: Buffer.from(JSON.stringify(entry.meta.err)) } : undefined,
              fee: String(entry.meta?.fee ?? 0),
            },
          },
        },
      }),
    );
  });
  updates.push(blockMetaUpdate(recorded));
  // The wire round trip.
  return updates.map((update) => SubscribeUpdate.decode(SubscribeUpdate.encode(update).finish()));
}

export function blockMetaUpdate(recorded: RecordedBlock, overrides: { rewardPubkey?: string | null } = {}) {
  const { block } = recorded;
  const pubkey = overrides.rewardPubkey === undefined ? block.rewards?.[0]?.pubkey : overrides.rewardPubkey;
  return SubscribeUpdate.fromPartial({
    filters: ['blocks'],
    blockMeta: {
      slot: String(recorded.slot),
      blockhash: block.blockhash,
      rewards: {
        rewards: pubkey ? [{ pubkey, lamports: String(block.rewards?.[0]?.lamports ?? 0), rewardType: 1 }] : [],
      },
      blockTime: block.blockTime !== null ? { timestamp: String(block.blockTime) } : undefined,
      blockHeight: block.blockHeight !== null ? { blockHeight: String(block.blockHeight) } : undefined,
      parentSlot: String(block.parentSlot),
      parentBlockhash: block.previousBlockhash,
      executedTransactionCount: String(recorded.transactionsInBlock),
    },
  });
}

export function slotStatusUpdate(slot: number, status: number, parent?: number): SubscribeUpdate {
  return SubscribeUpdate.fromPartial({
    filters: ['tip'],
    slot: { slot: String(slot), status, parent: parent !== undefined ? String(parent) : undefined },
  });
}
