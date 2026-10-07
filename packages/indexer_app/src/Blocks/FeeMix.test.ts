import { addressToBytes, JITO_TIP_ACCOUNTS } from '@epoch/solana';

import { recordedFeeBlocks } from '../__fixtures__/mainnetFeeBlocks';
import { feeReward, FeeMixTally, LAMPORTS_PER_SIGNATURE, txFeeMix } from './FeeMix';
import { decodeRpcBlock } from './RpcBlockDecoder';

const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const SYSTEM = new Uint8Array(32);
const TIP = addressToBytes(JITO_TIP_ACCOUNTS[3]);
const ED25519 = addressToBytes('Ed25519SigVerify111111111111111111111111111');

/** System Program instruction data: u32 LE kind, u64 LE lamports (+ anything after). */
function systemIx(kind: number, lamports: bigint, extra = 0): Uint8Array {
  const data = Buffer.alloc(12 + extra);
  data.writeUInt32LE(kind, 0);
  data.writeBigUInt64LE(lamports, 4);
  return data;
}

describe('txFeeMix', () => {
  const keys = [key(1), key(2), SYSTEM, TIP, ED25519];

  it('splits meta.fee into 5,000 per signature and the rest as priority', () => {
    expect(
      txFeeMix({ signatures: 2, keys, instructions: [], innerInstructions: [], fee: 25_000n, failed: false }),
    ).toEqual({ baseLamports: 10_000n, priorityLamports: 15_000n, tipLamports: 0n });
  });

  it('counts precompile signatures into the base fee', () => {
    const ix = { programIdIndex: 4, accounts: [], data: Uint8Array.from([3, 0, 1, 2]) };
    expect(
      txFeeMix({ signatures: 1, keys, instructions: [ix], innerInstructions: [], fee: 21_000n, failed: false }),
    ).toEqual({ baseLamports: 20_000n, priorityLamports: 1_000n, tipLamports: 0n });
  });

  it('counts Transfer and TransferWithSeed into a tip account, top-level and inner', () => {
    const transfer = { programIdIndex: 2, accounts: [0, 3], data: systemIx(2, 1_000n) };
    const withSeed = { programIdIndex: 2, accounts: [0, 1, 3], data: systemIx(11, 500n, 40) };
    const elsewhere = { programIdIndex: 2, accounts: [0, 1], data: systemIx(2, 7n) };
    const notSystem = { programIdIndex: 1, accounts: [0, 3], data: systemIx(2, 9n) };
    const mix = txFeeMix({
      signatures: 1,
      keys,
      instructions: [transfer, elsewhere, notSystem],
      innerInstructions: [withSeed],
      fee: 5_000n,
      failed: false,
    });
    expect(mix.tipLamports).toBe(1_500n);
  });

  it('gives a failed transaction no tips (its transfers are rolled back) but keeps its fee', () => {
    const transfer = { programIdIndex: 2, accounts: [0, 3], data: systemIx(2, 1_000n) };
    expect(
      txFeeMix({ signatures: 1, keys, instructions: [transfer], innerInstructions: [], fee: 9_000n, failed: true }),
    ).toEqual({ baseLamports: 5_000n, priorityLamports: 4_000n, tipLamports: 0n });
  });

  it('resolves a tip account loaded from a lookup table (index past the static keys)', () => {
    const transfer = { programIdIndex: 1, accounts: [0, 2], data: systemIx(2, 42n) };
    const mix = txFeeMix({
      signatures: 1,
      keys: [key(1), SYSTEM, TIP],
      instructions: [transfer],
      innerInstructions: [],
      fee: 5_000n,
      failed: false,
    });
    expect(mix.tipLamports).toBe(42n);
  });

  it('never reports a negative priority fee', () => {
    expect(
      txFeeMix({ signatures: 2, keys, instructions: [], innerInstructions: [], fee: 5_000n, failed: false })
        .priorityLamports,
    ).toBe(0n);
    expect(
      txFeeMix({ signatures: 1, keys, instructions: [], innerInstructions: [], fee: null, failed: false })
        .priorityLamports,
    ).toBe(0n);
  });
});

describe('FeeMixTally', () => {
  it('derives streamed vote base fees from the Fee reward (base = 2 × (reward − priority))', () => {
    const tally = new FeeMixTally();
    tally.add({ baseLamports: 10_000n, priorityLamports: 100_000n, tipLamports: 0n }, false);
    // 3 votes the stream never sent: base 25,000 in all → reward = 100,000 + 25,000 / 2.
    const mix = tally.streamed(112_500n, 4);
    expect(mix).toMatchObject({ baseLamports: 25_000n, voteTxs: 3, nonVoteTxs: 1, baseFeeBasis: 'reward' });
  });

  it('estimates 5,000 per unseen vote without a usable reward', () => {
    const tally = new FeeMixTally();
    tally.add({ baseLamports: 10_000n, priorityLamports: 100_000n, tipLamports: 0n }, false);
    expect(tally.streamed(null, 4)).toMatchObject({ baseLamports: 25_000n, voteTxs: 3, baseFeeBasis: 'estimated' });
    // A reward that cannot explain the counted base fees is not used.
    expect(tally.streamed(1n, 4)).toMatchObject({ baseLamports: 25_000n, baseFeeBasis: 'estimated' });
  });

  it('checks counted blocks against the Fee reward', () => {
    const tally = new FeeMixTally();
    tally.add({ baseLamports: 10_000n, priorityLamports: 7n, tipLamports: 3n }, false);
    expect(tally.counted(5_007n)).toMatchObject({ rewardMatches: true, tipTxs: 1, baseFeeBasis: 'counted' });
    expect(tally.counted(5_008n).rewardMatches).toBe(false);
    expect(tally.counted(null).rewardMatches).toBeNull();
  });
});

describe('real mainnet blocks (epoch 1051, every transaction)', () => {
  const { blocks } = recordedFeeBlocks();

  it.each(blocks.map((b) => [b.slot, b] as const))('slot %d: matches the independent reference', (_slot, recorded) => {
    const decoded = decodeRpcBlock(recorded.slot, recorded.block);
    const ref = recorded.reference;
    expect(decoded.malformed).toBe(0);
    expect(decoded.votes).toBe(ref.votes);
    expect(decoded.feeMix).toEqual({
      baseLamports: BigInt(ref.base),
      priorityLamports: BigInt(ref.priority),
      tipLamports: BigInt(ref.tips),
      tipTxs: ref.tipTxs,
      voteTxs: ref.votes,
      nonVoteTxs: ref.nonVote,
      feeRewardLamports: BigInt(ref.reward as number),
      baseFeeBasis: 'counted',
      rewardMatches: true,
    });
    // The reference's two tip measures agree, and Agave's split explains the leader's reward exactly.
    expect(ref.tips).toBe(ref.tipsByBalance);
    expect(feeReward(BigInt(ref.base), BigInt(ref.priority))).toBe(BigInt(ref.reward as number));
    expect(ref.tips).toBeGreaterThan(0);
  });

  it('includes precompile signatures and a mix of legacy, v0 and v1 transactions', () => {
    expect(blocks.reduce((n, b) => n + b.reference.precompileSigs, 0)).toBeGreaterThan(0);
    const versions = new Set(blocks.flatMap((b) => b.block.transactions.map((t) => String(t.version))));
    expect(versions).toEqual(new Set(['legacy', '0', '1']));
  });

  it('gives the same totals when the votes are left out and the reward fills them in (the gRPC path)', () => {
    for (const recorded of blocks) {
      const counted = decodeRpcBlock(recorded.slot, recorded.block).feeMix;
      const streamed = new FeeMixTally();
      // Rebuild a tally from the non-vote transactions only, as the firehose sees the block.
      const nonVoteOnly = {
        ...recorded.block,
        transactions: recorded.block.transactions.filter((_t, i) => !isVoteAt(recorded.block, i)),
      };
      const partial = decodeRpcBlock(recorded.slot, nonVoteOnly).feeMix;
      streamed.baseLamports = partial.baseLamports;
      streamed.priorityLamports = partial.priorityLamports;
      streamed.tipLamports = partial.tipLamports;
      streamed.tipTxs = partial.tipTxs;
      streamed.nonVoteTxs = partial.nonVoteTxs;
      const mix = streamed.streamed(counted.feeRewardLamports, recorded.block.transactions.length);
      expect(mix).toMatchObject({
        baseLamports: counted.baseLamports,
        priorityLamports: counted.priorityLamports,
        tipLamports: counted.tipLamports,
        voteTxs: counted.voteTxs,
        baseFeeBasis: 'reward',
      });
      expect(mix.baseLamports % LAMPORTS_PER_SIGNATURE).toBe(0n);
    }
  });
});

/** Whether transaction `i` of a recorded block is a simple vote (decoded on its own). */
function isVoteAt(block: Parameters<typeof decodeRpcBlock>[1], i: number): boolean {
  return decodeRpcBlock(0, { ...block, transactions: [block.transactions[i]] }).votes === 1;
}
