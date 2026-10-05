import { bytesToAddress } from '@epoch/solana';

import { grpcUpdatesFor } from '../__fixtures__/yellowstone';
import { type RecordedBlock, recordedBlocks } from '../__fixtures__/mainnetBlocks';
import { slotMedianCuPrice } from '../Processors/FeeProcessor';
import { blockFees, type DecodedBlock, percentileSorted } from './BlockFees';
import { GrpcBlockAssembler } from './GrpcBlockAssembler';
import { decodeRpcBlock } from './RpcBlockDecoder';

const { blocks } = recordedBlocks();

function viaGrpc(recorded: RecordedBlock): DecodedBlock {
  const assembler = new GrpcBlockAssembler();
  let block: DecodedBlock | undefined;
  for (const update of grpcUpdatesFor(recorded)) {
    if (update.transaction) assembler.addTransaction(update.transaction);
    if (update.blockMeta) block = assembler.completeBlock(update.blockMeta);
  }
  if (!block) throw new Error('no block meta');
  return block;
}

describe('blockFees on real mainnet blocks', () => {
  it.each(blocks.map((b) => [b.slot, b] as const))(
    'slot %i: RPC getBlock path matches the independent reference',
    (_slot, recorded) => {
      const block = decodeRpcBlock(recorded.slot, recorded.block);
      expect(block.votes).toBe(recorded.reference.simpleVotes);
      expect(block.txs).toHaveLength(recorded.reference.nonVote);
      expect(block.malformed).toBe(0);
      expect(block.rewardPubkey).toBe(recorded.leader);
      expect(block.parentSlot).toBe(recorded.block.parentSlot);

      const fees = blockFees(recorded.slot, recorded.leader, block.txs);
      const ref = recorded.reference;
      expect(fees).toEqual({
        slot: recorded.slot,
        leader: recorded.leader,
        medianCuPrice: ref.medianCuPrice,
        p25CuPrice: ref.p25CuPrice,
        p75CuPrice: ref.p75CuPrice,
        p90CuPrice: ref.p90CuPrice,
        pricedTxs: ref.priced,
        unpricedTxs: ref.unpriced,
        leaderPaidTxs: ref.leaderPaid,
        failedTxs: ref.failedPriced,
      });
    },
  );

  it.each(blocks.map((b) => [b.slot, b] as const))(
    'slot %i: the Yellowstone firehose path (tx updates + block meta) gives the same result',
    (_slot, recorded) => {
      const rpc = blockFees(recorded.slot, recorded.leader, decodeRpcBlock(recorded.slot, recorded.block).txs);
      const grpcBlock = viaGrpc(recorded);
      expect(grpcBlock.votes).toBe(0);
      expect(grpcBlock.blockTime).toBe(recorded.block.blockTime);
      expect(grpcBlock.rewardPubkey).toBe(recorded.leader);
      expect(blockFees(recorded.slot, recorded.leader, grpcBlock.txs)).toEqual(rpc);
    },
  );

  it('the complete block reproduces the real slot median (10,000 µL/CU over 132 priced transactions)', () => {
    const complete = blocks.find((b) => b.complete) as RecordedBlock;
    expect(complete.reference.nonVote).toBe(complete.nonVoteInBlock);
    const fees = blockFees(complete.slot, complete.leader, decodeRpcBlock(complete.slot, complete.block).txs);
    expect(fees.medianCuPrice).toBe(10_000);
    expect(fees.pricedTxs).toBe(132);
  });

  it('agrees with FeeProcessor.slotMedianCuPrice, the methodology function the publisher’s inputs come from', () => {
    for (const recorded of blocks) {
      const block = decodeRpcBlock(recorded.slot, recorded.block);
      const priced = block.txs
        .filter((tx) => tx.price.cuPrice !== null)
        .map((tx) => ({ feePayer: bytesToAddress(tx.payer), cuPrice: tx.price.cuPrice as number }));
      expect(blockFees(recorded.slot, recorded.leader, block.txs).medianCuPrice ?? 0).toBe(
        slotMedianCuPrice(priced, recorded.leader),
      );
    }
  });

  it('excludes transactions paid by the slot leader, priced or not', () => {
    const recorded = blocks.find((b) => b.syntheticIndexes.length > 0) as RecordedBlock;
    const block = decodeRpcBlock(recorded.slot, recorded.block);
    const fees = blockFees(recorded.slot, recorded.leader, block.txs);
    expect(fees.leaderPaidTxs).toBe(2);
    // The same transactions paid by anyone else would be in the median.
    const elsewhere = blockFees(recorded.slot, '11111111111111111111111111111111', block.txs);
    expect(elsewhere.leaderPaidTxs).toBe(0);
    expect(elsewhere.pricedTxs).toBe(fees.pricedTxs + 2);
  });
});

describe('percentileSorted', () => {
  it('uses the nearest rank', () => {
    expect(percentileSorted([], 0.5)).toBeNull();
    expect(percentileSorted([1, 2, 3, 4], 0.25)).toBe(1);
    expect(percentileSorted([1, 2, 3, 4], 0.75)).toBe(3);
    expect(percentileSorted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('GrpcBlockAssembler', () => {
  it('ignores a transaction that arrives after its block meta, and drops partial slots on reset', () => {
    const recorded = blocks[2];
    const updates = grpcUpdatesFor(recorded);
    const assembler = new GrpcBlockAssembler();
    const tx = updates.find((u) => u.transaction)?.transaction;
    const meta = updates.find((u) => u.blockMeta)?.blockMeta;
    if (!tx || !meta) throw new Error('fixture');
    assembler.addTransaction(tx);
    expect(assembler.pendingSlots).toBe(1);
    expect(assembler.completeBlock(meta).txs).toHaveLength(1);
    assembler.addTransaction(tx);
    expect(assembler.lateTransactions).toBe(1);
    expect(assembler.pendingSlots).toBe(0);

    assembler.addTransaction({ ...tx, slot: String(recorded.slot + 5) });
    assembler.addTransaction({ ...tx, slot: String(recorded.slot + 9) });
    expect(assembler.dropBefore(recorded.slot + 9)).toEqual([recorded.slot + 5]);
    assembler.reset();
    expect(assembler.pendingSlots).toBe(0);
  });

  it('closes a block that had no non-vote transactions at all', () => {
    const recorded = blocks[0];
    const meta = grpcUpdatesFor(recorded).find((u) => u.blockMeta)?.blockMeta;
    if (!meta) throw new Error('fixture');
    const block = new GrpcBlockAssembler().completeBlock(meta);
    expect(block).toMatchObject({ slot: recorded.slot, txs: [], rewardPubkey: recorded.leader });
  });
});
