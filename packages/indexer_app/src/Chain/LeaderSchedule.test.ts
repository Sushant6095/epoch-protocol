import { LEADER_CHUNK, LeaderResolver, LeaderSchedule } from './LeaderSchedule';
import { fetchStakeSnapshot } from './StakeSnapshots';

const A = '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS';
const B = 'A1vqhA2fS6K7CvHsJKX1ACcHJFEmyRg4KuR5pctHANy4';

function rpc(fail = false) {
  const calls: [number, number][] = [];
  return {
    calls,
    getSlotLeaders: async (start: number, limit: number) => {
      calls.push([start, limit]);
      if (fail) throw new Error('-32005: Rate limited');
      return Array.from({ length: limit }, (_, i) => ((start + i) % 8 < 4 ? A : B));
    },
  };
}

describe('LeaderSchedule', () => {
  it('fetches aligned chunks once, answers from the cache, and prefetches the next chunk', async () => {
    const source = rpc();
    const schedule = new LeaderSchedule(source);
    expect(schedule.leaderOf(452_937_393)).toBeUndefined();
    expect(await schedule.ensure(452_937_393)).toBe(A);
    expect(source.calls).toEqual([[452_936_000, LEADER_CHUNK]]);
    expect(schedule.leaderOf(452_936_004)).toBe(B);
    // 75% into the chunk: the next one is fetched in the background.
    schedule.leaderOf(452_936_000 + 3_500);
    await new Promise((r) => setImmediate(r));
    expect(source.calls).toEqual([
      [452_936_000, LEADER_CHUNK],
      [452_940_000, LEADER_CHUNK],
    ]);
    // Epochs (432,000 slots) are whole numbers of chunks, so no chunk spans two epochs' schedules.
    expect(432_000 % LEADER_CHUNK).toBe(0);
  });

  it('backs off after a failure instead of asking on every slot', async () => {
    let now = 0;
    const source = rpc(true);
    const schedule = new LeaderSchedule(source, () => now);
    expect(await schedule.ensure(10)).toBeUndefined();
    schedule.leaderOf(11);
    await new Promise((r) => setImmediate(r));
    expect(source.calls).toHaveLength(1);
    now = 10_000;
    schedule.leaderOf(12);
    await new Promise((r) => setImmediate(r));
    expect(source.calls).toHaveLength(2);
  });
});

describe('LeaderResolver', () => {
  const schedule = (leader?: string) => ({ leaderOf: () => leader, ensure: async () => leader });

  it('prefers the schedule, counting a Fee reward credited to someone else', () => {
    const resolver = new LeaderResolver(schedule(A), () => new Map([['voteA', A]]));
    expect(resolver.now(1, A)).toBe(A);
    expect(resolver.now(1, 'voteA')).toBe(A);
    expect(resolver.rewardMismatches).toBe(0);
    expect(resolver.now(1, 'collector')).toBe(A);
    expect(resolver.rewardMismatches).toBe(1);
  });

  it('falls back to the Fee reward, mapping a vote-account collector (SIMD-0232) to its identity', async () => {
    const resolver = new LeaderResolver(schedule(undefined), () => new Map([['voteB', B]]));
    expect(resolver.now(1, 'voteB')).toBe(B);
    expect(await resolver.resolve(1, A)).toBe(A);
    expect(await resolver.resolve(1, null)).toBeUndefined();
    expect(resolver.fromRewards).toBe(2);
  });
});

describe('fetchStakeSnapshot', () => {
  it('sums activated stake per identity (current and delinquent) and maps votes to identities', async () => {
    const snapshot = await fetchStakeSnapshot(
      {
        getVoteAccounts: async () => ({
          current: [
            { votePubkey: 'v1', nodePubkey: A, activatedStake: 13_000_000_000_000_000 },
            { votePubkey: 'v2', nodePubkey: A, activatedStake: 5 },
          ],
          delinquent: [
            { votePubkey: 'v3', nodePubkey: B, activatedStake: 7 },
            { votePubkey: 'v4', nodePubkey: 'nobody', activatedStake: 0 },
          ],
        }),
      },
      1048,
    );
    expect(snapshot.epoch).toBe(1048);
    expect(snapshot.byIdentity).toEqual(
      new Map([
        [A, 13_000_000_000_000_005n],
        [B, 7n],
      ]),
    );
    expect(snapshot.voteToIdentity.get('v4')).toBe('nobody');
  });
});
