import { type VoteState } from '@epoch/solana';
import { type VoteAccountInfo } from '@solana/web3.js';

import { clusterStats, creditsIn, scoreInputs, superminority } from './ScoreInputs';

const voter = (
  votePubkey: string,
  activatedStake: number,
  earnedLastEpoch: number,
  commission = 5,
): VoteAccountInfo => ({
  votePubkey,
  nodePubkey: `${votePubkey}-node`,
  activatedStake,
  epochVoteAccount: true,
  // [epoch, credits, prevCredits]: credits earned in 99 = earnedLastEpoch.
  epochCredits: [
    [98, 1_000, 500],
    [99, 1_000 + earnedLastEpoch, 1_000],
    [100, 1_000 + earnedLastEpoch + 10, 1_000 + earnedLastEpoch],
  ],
  commission,
  lastVote: 0,
});

const voteState = (overrides: Partial<VoteState> = {}): VoteState => ({
  version: 'v4',
  nodePubkey: 'node',
  authorizedWithdrawer: 'withdrawer',
  inflationRewardsCollector: null,
  blockRevenueCollector: null,
  inflationRewardsCommissionBps: 300,
  blockRevenueCommissionBps: 10_000,
  pendingDelegatorRewards: 0n,
  rootSlot: null,
  epochCredits: Array.from({ length: 40 }, (_, i) => ({
    epoch: BigInt(60 + i),
    credits: BigInt((i + 1) * 100),
    prevCredits: BigInt(i * 100),
  })),
  lastTimestamp: { slot: 0n, timestamp: 0n },
  ...overrides,
});

describe('cluster stats', () => {
  const snapshot = {
    epoch: 100,
    current: [voter('a', 600, 400_000), voter('b', 300, 380_000), voter('idle', 50, 0)],
    delinquent: [voter('d', 50, 1_000)],
  };

  it('averages last-epoch credits over voting validators that earned any', () => {
    const stats = clusterStats(snapshot);
    expect(stats.lastEpoch).toBe(99);
    expect(stats.averageCredits).toBe(390_000);
    expect(stats.delinquent).toEqual(new Set(['d']));
    expect(creditsIn(snapshot.current[1], 99)).toBe(380_000);
    expect(creditsIn(snapshot.current[1], 50)).toBe(0);
  });

  it('puts the fewest largest stakes holding more than a third in the superminority', () => {
    expect(superminority([voter('a', 600, 1), voter('b', 300, 1), voter('c', 100, 1)])).toEqual(new Set(['a']));
    // 30 + 30 = 60 of 150 is 40% > 1/3; 30 alone is exactly 20%.
    expect(
      superminority([voter('a', 30, 1), voter('b', 30, 1), voter('c', 30, 1), voter('d', 30, 1), voter('e', 30, 1)]),
    ).toEqual(new Set(['a', 'b']));
    expect(superminority([voter('z', 0, 1)])).toEqual(new Set());
  });
});

describe('scoreInputs', () => {
  const stats = clusterStats({
    epoch: 100,
    current: [voter('a', 600, 400_000), voter('b', 300, 380_000), voter('c', 300, 390_000, 8)],
    delinquent: [voter('d', 50, 1_000)],
  });

  it('measures credits against the cluster average and takes the higher commission', () => {
    expect(scoreInputs('b', stats, voteState(), 800)).toEqual({
      creditsRatioBps: Math.floor((380_000 / 390_000) * 10_000),
      commissionBps: 800, // MEV 8% beats inflation 3%
      epochsActive: 40,
      delinquent: false,
      superminority: false,
    });
    expect(scoreInputs('a', stats, voteState(), null)).toMatchObject({ commissionBps: 300, superminority: true });
  });

  it('falls back to getVoteAccounts when the vote account could not be read', () => {
    // 8% from getVoteAccounts, three epochs of history.
    expect(scoreInputs('c', stats, null, 0)).toMatchObject({ commissionBps: 800, epochsActive: 3 });
  });

  it('counts only epochs with credits as active and flags delinquency', () => {
    const state = voteState({
      epochCredits: [
        { epoch: 98n, credits: 10n, prevCredits: 10n },
        { epoch: 99n, credits: 20n, prevCredits: 10n },
      ],
    });
    expect(scoreInputs('d', stats, state, null)).toMatchObject({ epochsActive: 1, delinquent: true });
  });

  it('returns null for a vote account the data cluster does not know', () => {
    expect(scoreInputs('unknown', stats, null, null)).toBeNull();
  });

  it('clamps to the program types', () => {
    const lonely = clusterStats({ epoch: 100, current: [voter('x', 1, 900_000)], delinquent: [] });
    const tiny = clusterStats({ epoch: 100, current: [voter('x', 1, 1), voter('y', 1, 99_999)], delinquent: [] });
    expect(scoreInputs('x', lonely, null, 20_000)?.commissionBps).toBe(10_000);
    expect(scoreInputs('y', tiny, null, null)?.creditsRatioBps).toBe(19_999);
    const noCredits = clusterStats({ epoch: 100, current: [voter('x', 1, 0)], delinquent: [] });
    expect(scoreInputs('x', noCredits, null, null)?.creditsRatioBps).toBe(10_000);
  });
});
