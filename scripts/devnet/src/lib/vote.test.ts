import { Keypair } from '@solana/web3.js';

import { parseVoteHeader, VOTE_PROGRAM_ID, VOTE_STATE_V4, voteUpdateCommission } from './vote';

describe('parseVoteHeader', () => {
  it('reads the V4 header: withdrawer, collectors and commissions in bps', () => {
    const [node, withdrawer, inflation, block] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
    const data = new Uint8Array(3_762);
    const view = new DataView(data.buffer);
    view.setUint32(0, VOTE_STATE_V4, true);
    data.set(node.toBytes(), 4);
    data.set(withdrawer.toBytes(), 36);
    data.set(inflation.toBytes(), 68);
    data.set(block.toBytes(), 100);
    view.setUint16(132, 1_000, true);
    view.setUint16(134, 10_000, true);
    const h = parseVoteHeader(data);
    expect(h.nodePubkey.equals(node)).toBe(true);
    expect(h.authorizedWithdrawer.equals(withdrawer)).toBe(true);
    expect(h.inflationRewardsCollector?.equals(inflation)).toBe(true);
    expect(h.blockRevenueCollector?.equals(block)).toBe(true);
    expect([h.inflationRewardsCommissionBps, h.blockRevenueCommissionBps]).toEqual([1_000, 10_000]);
  });

  it('reads the V3 header (commission in percent, no collectors)', () => {
    const data = new Uint8Array(3_762);
    new DataView(data.buffer).setUint32(0, 2, true);
    data[68] = 7;
    const h = parseVoteHeader(data);
    expect(h.inflationRewardsCollector).toBeNull();
    expect(h.inflationRewardsCommissionBps).toBe(700);
  });

  it('refuses data too short for a vote account', () => {
    expect(() => parseVoteHeader(new Uint8Array(40))).toThrow(/not a vote account/);
  });
});

describe('voteUpdateCommission', () => {
  it('encodes instruction 5 with a u8 percent, vote writable and the withdrawer signing', () => {
    const vote = Keypair.generate().publicKey;
    const withdrawer = Keypair.generate().publicKey;
    const ix = voteUpdateCommission(vote, withdrawer, 9);
    expect(ix.programId.equals(VOTE_PROGRAM_ID)).toBe(true);
    expect([...ix.data]).toEqual([5, 0, 0, 0, 9]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [vote.toBase58(), false, true],
      [withdrawer.toBase58(), true, false],
    ]);
    expect(() => voteUpdateCommission(vote, withdrawer, 101)).toThrow(RangeError);
  });
});
