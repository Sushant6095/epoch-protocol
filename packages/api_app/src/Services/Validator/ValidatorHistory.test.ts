import { epochEndMs, parseStakewizTime } from '../../Lib/EpochTimes';
import { type VoteAccount } from '../../Sources/SolanaDataSource';
import fixture from './__fixtures__/ntt-docomo.recorded.json';
import {
  buildHistorySnapshot,
  commissionAtEpochEnds,
  lastCommissionRaise,
  recordedStats,
  stakeStatsFromSeries,
} from './ValidatorHistory';

describe('buildHistorySnapshot', () => {
  it('keeps the last 10 commissions and 64 stakes per validator, oldest first', () => {
    const rows = [
      { vote: 'v', epoch: 1047, commissionBps: 500, activeStakeLamports: 3_000_000_000n },
      { vote: 'v', epoch: 1037, commissionBps: 1_000 },
      { vote: 'v', epoch: 1038, commissionBps: 700, activeStakeLamports: 2_400_000_000n },
      { vote: 'v', epoch: 983, activeStakeLamports: 1_000_000_000n },
      { vote: 'v', epoch: 984, activeStakeLamports: 1_600_000_000n, commissionBps: null },
      { vote: 'v', epoch: 1048, commissionBps: 10_000 },
      { vote: 'w', epoch: 1046, credits: 6_900_000 },
    ];
    const snapshot = buildHistorySnapshot(rows, 1047, 3);
    expect(snapshot.version).toBe(3);
    expect(snapshot.commission.get('v')).toEqual([
      { epoch: 1038, commissionPct: 7 },
      { epoch: 1047, commissionPct: 5 },
    ]);
    expect(snapshot.stake.get('v')).toEqual([
      { epoch: 984, sol: 2 },
      { epoch: 1038, sol: 2 },
      { epoch: 1047, sol: 3 },
    ]);
    expect(snapshot.commission.has('w')).toBe(false);
  });
});

describe('lastCommissionRaise', () => {
  const series = (pcts: number[]) => pcts.map((commissionPct, i) => ({ epoch: 100 + i, commissionPct }));

  it('finds the newest raise, also one taken back later', () => {
    expect(lastCommissionRaise(series([5, 5, 7, 7]))).toEqual({ epoch: 102, fromPct: 5, toPct: 7 });
    expect(lastCommissionRaise(series([5, 100, 5]))).toEqual({ epoch: 101, fromPct: 5, toPct: 100 });
    expect(lastCommissionRaise(series([7, 5, 5]))).toBeNull();
    expect(lastCommissionRaise([])).toBeNull();
  });
});

describe('recordedStats', () => {
  it("writes this epoch's figures for every staked validator and the credits of earlier epochs", () => {
    const accounts = [
      {
        votePubkey: 'a',
        nodePubkey: 'n',
        activatedStake: 2_500_000_000,
        commission: 5,
        inflationRewardsCommissionBps: 450,
        epochVoteAccount: true,
        epochCredits: [
          [1045, 100, 40],
          [1046, 160, 100],
          [1047, 170, 160],
        ],
        lastVote: 0,
      },
      { votePubkey: 'b', nodePubkey: 'm', activatedStake: 0, commission: 0, epochCredits: [], epochVoteAccount: false },
      { votePubkey: 'c', nodePubkey: 'o', activatedStake: 1, commission: 7, epochCredits: [], epochVoteAccount: true },
    ] as VoteAccount[];
    const rows = recordedStats(accounts, 1047, (vote) => (vote === 'a' ? 1_000 : null));
    expect(rows).toEqual([
      {
        vote: 'a',
        epoch: 1047,
        commissionBps: 450,
        mevCommissionBps: 1_000,
        activeStakeLamports: 2_500_000_000n,
        credits: 10,
      },
      { vote: 'a', epoch: 1045, credits: 60 },
      { vote: 'a', epoch: 1046, credits: 60 },
      { vote: 'c', epoch: 1047, commissionBps: 700, mevCommissionBps: null, activeStakeLamports: 1n, credits: 0 },
    ]);
  });
});

describe('backfill from Stakewiz (NTT DOCOMO GLOBAL, recorded)', () => {
  const starts = fixture.stakewizEpochs.map((e) => ({ epoch: e.epoch, startMs: parseStakewizTime(e.start) }));
  const clock = { epoch: 1047, startMs: parseStakewizTime('2026-10-01 15:41:02+02'), msPerEpoch: 115_700_000 };
  const endMs = (epoch: number) => epochEndMs(epoch, starts, clock);
  const changes = fixture.stakewizCommissionHistory.map((c) => ({
    bps: c.commission,
    atMs: parseStakewizTime(c.observed_at),
  }));

  it('reads the commission in force at the end of each epoch from the change log', () => {
    // 5% since 6 Dec 2025, 0% for nine hours on 21-22 Feb (inside epoch 930), then 5% again.
    const byEpoch = commissionAtEpochEnds(changes, [929, 930, 931, 1037, 1046], endMs);
    expect([...byEpoch]).toEqual([
      [929, 500],
      [930, 500],
      [931, 500],
      [1037, 500],
      [1046, 500],
    ]);
    // Before the first observation there is nothing to say.
    expect(commissionAtEpochEnds(changes, [700], endMs).size).toBe(0);
  });

  it('takes stake per epoch from the 30-epoch series, before the current epoch', () => {
    const rows = stakeStatsFromSeries(fixture.vote, fixture.stakewizTotalStakes, 1047);
    expect(rows).toHaveLength(29);
    expect(rows[0]).toEqual({ vote: fixture.vote, epoch: 1018, activeStakeLamports: 190_429_047_237_015n });
    expect(rows.at(-1)?.epoch).toBe(1046);
  });

  it('drops the zeros Stakewiz sends before a validator had stake', () => {
    const series = [
      { epoch: 3, stake: 0 },
      { epoch: 1, stake: 0 },
      { epoch: 2, stake: 0 },
      { epoch: 4, stake: 1.5 },
      { epoch: 5, stake: 0 },
    ];
    expect(stakeStatsFromSeries('v', series, 6).map((r) => [r.epoch, r.activeStakeLamports])).toEqual([
      [4, 1_500_000_000n],
      [5, 0n],
    ]);
    expect(stakeStatsFromSeries('v', [{ epoch: 1, stake: 0 }], 6)).toEqual([]);
  });
});
