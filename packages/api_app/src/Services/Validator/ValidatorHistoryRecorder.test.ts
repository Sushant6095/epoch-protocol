import { SnapshotCache } from '../../Lib/SnapshotCache';
import { type StakewizSource } from '../../Sources/ExternalSources';
import { type VoteAccount } from '../../Sources/SolanaDataSource';
import { type MarketData } from '../MarketData';
import fixture from './__fixtures__/ntt-docomo.recorded.json';
import { ValidatorHistoryRecorder } from './ValidatorHistoryRecorder';
import { MemoryValidatorHistoryStore } from './ValidatorHistoryStore';

const NTT = fixture.vote;
const cache = <T>(name: string, value: T) => new SnapshotCache(name, 60_000, async () => value);

const voteAccount = (votePubkey: string, stakeSol: number, bps: number): VoteAccount => ({
  votePubkey,
  nodePubkey: `${votePubkey}-node`,
  activatedStake: stakeSol * 1e9,
  commission: bps / 100,
  inflationRewardsCommissionBps: bps,
  epochVoteAccount: true,
  epochCredits: [
    [1046, 7_000_000, 100_000],
    [1047, 9_000_000, 7_000_000],
  ],
  lastVote: 0,
});

function fakeMarket(accounts: VoteAccount[]): MarketData {
  return {
    epochInfo: cache('epochInfo', {
      epoch: 1047,
      slotIndex: 400_000,
      slotsInEpoch: 432_000,
      absoluteSlot: 452_704_000,
    }),
    voteAccounts: cache('voteAccounts', { current: accounts, delinquent: [] }),
    kobe: cache('kobe', new Map([[NTT, { vote_account: NTT, mev_commission_bps: 1_000, running_jito: true }]])),
    stakewiz: cache('stakewiz', new Map()),
    secondsPerSlot: async () => 0.268,
  } as unknown as MarketData;
}

function fakeStakewiz(failing: ReadonlySet<string> = new Set()) {
  const api = {
    getCommissionHistory: jest.fn(async (vote: string) => {
      if (failing.has(vote)) throw new Error('HTTP 502');
      return vote === NTT ? fixture.stakewizCommissionHistory : [];
    }),
    getTotalStakes: jest.fn(async (vote: string) => (vote === NTT ? fixture.stakewizTotalStakes : [])),
    getEpochHistory: jest.fn(async () => fixture.stakewizEpochs),
  };
  return { api, source: api as unknown as StakewizSource };
}

describe('ValidatorHistoryRecorder', () => {
  it('records this epoch, then backfills commission and stake from Stakewiz once', async () => {
    const store = new MemoryValidatorHistoryStore();
    const stakewiz = fakeStakewiz();
    const recorder = new ValidatorHistoryRecorder(
      fakeMarket([voteAccount(NTT, 196_541.7, 500), voteAccount('NewValidator', 100, 0)]),
      stakewiz.source,
      store,
      { backfill: true, pauseMs: 0 },
    );
    await recorder.run();

    const snapshot = recorder.latest;
    // Nine finished epochs from the change log (5% at each epoch's end) and this epoch from getVoteAccounts.
    expect(snapshot?.commission.get(NTT)?.map((p) => p.epoch)).toEqual([
      1038, 1039, 1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047,
    ]);
    expect(new Set(snapshot?.commission.get(NTT)?.map((p) => p.commissionPct))).toEqual(new Set([5]));
    // 29 finished epochs of Stakewiz stake and the live one.
    const stake = snapshot?.stake.get(NTT) ?? [];
    expect(stake).toHaveLength(30);
    expect(stake[0]).toEqual({ epoch: 1018, sol: 190_429 });
    expect(stake.at(-1)).toEqual({ epoch: 1047, sol: 196_542 });
    expect(snapshot?.commission.get('NewValidator')).toEqual([{ epoch: 1047, commissionPct: 0 }]);

    const rows = await store.load(1046);
    expect(rows.find((r) => r.vote === NTT && r.epoch === 1046)).toEqual({
      vote: NTT,
      epoch: 1046,
      credits: 6_900_000,
      commissionBps: 500,
      activeStakeLamports: 195_695_974_097_746n,
    });
    expect(rows.find((r) => r.vote === NTT && r.epoch === 1047)).toMatchObject({
      commissionBps: 500,
      mevCommissionBps: 1_000,
      credits: 2_000_000,
    });
    expect(stakewiz.api.getCommissionHistory).toHaveBeenCalledTimes(2);
    expect(stakewiz.api.getEpochHistory).toHaveBeenCalledTimes(1);

    // The next run records again and asks Stakewiz nothing: NTT is covered, the new validator was tried.
    const version = snapshot?.version ?? 0;
    await recorder.run();
    expect(stakewiz.api.getCommissionHistory).toHaveBeenCalledTimes(2);
    expect(recorder.latest?.version).toBeGreaterThan(version);
  });

  it('stops the backfill after ten failures in a row and tries again on the next run', async () => {
    const votes = Array.from({ length: 12 }, (_, i) => `Validator${i}`);
    const stakewiz = fakeStakewiz(new Set(votes));
    const recorder = new ValidatorHistoryRecorder(
      fakeMarket(votes.map((vote) => voteAccount(vote, 10, 500))),
      stakewiz.source,
      new MemoryValidatorHistoryStore(),
      { backfill: true, pauseMs: 0 },
    );
    await recorder.run();
    expect(stakewiz.api.getCommissionHistory).toHaveBeenCalledTimes(10);
    await recorder.run();
    expect(stakewiz.api.getCommissionHistory).toHaveBeenCalledTimes(20);
    // What it could record from the chain is there regardless.
    expect(recorder.latest?.commission.get('Validator0')).toEqual([{ epoch: 1047, commissionPct: 5 }]);
  });

  it('reads an empty commission log as the commission it has now, from the first epoch with stake', async () => {
    const stakes = (from: number) =>
      Array.from({ length: 30 }, (_, i) => ({ epoch: 1047 - i, stake: 1047 - i >= from ? 100 : 0 }));
    const stakewiz = {
      getCommissionHistory: async () => [],
      getTotalStakes: async (vote: string) => (vote === 'Steady' ? stakes(1000) : stakes(1043)),
      getEpochHistory: async () => fixture.stakewizEpochs,
    } as unknown as StakewizSource;
    const recorder = new ValidatorHistoryRecorder(
      fakeMarket([voteAccount('Steady', 10, 800), voteAccount('Recent', 10, 300)]),
      stakewiz,
      new MemoryValidatorHistoryStore(),
      { backfill: true, pauseMs: 0 },
    );
    await recorder.run();
    expect(recorder.latest?.commission.get('Steady')?.map((p) => p.commissionPct)).toEqual(Array(10).fill(8));
    expect(recorder.latest?.commission.get('Recent')?.map((p) => p.epoch)).toEqual([1043, 1044, 1045, 1046, 1047]);
  });

  it('shows backfilled history every ~100 validators, not only at the end', async () => {
    const votes = Array.from({ length: 120 }, (_, i) => `Validator${i}`);
    // Every validator answers with NTT DOCOMO's recordings: 9 commission and 29 stake rows each.
    const stakewiz = {
      getCommissionHistory: async () => fixture.stakewizCommissionHistory,
      getTotalStakes: async () => fixture.stakewizTotalStakes,
      getEpochHistory: async () => fixture.stakewizEpochs,
    } as unknown as StakewizSource;
    const recorder = new ValidatorHistoryRecorder(
      fakeMarket(votes.map((vote) => voteAccount(vote, 10, 500))),
      stakewiz,
      new MemoryValidatorHistoryStore(),
      { backfill: true, pauseMs: 0 },
    );
    await recorder.run();
    // After recording, once after 112 validators (the eighth write of 500 rows), and at the end.
    expect(recorder.latest?.version).toBe(3);
    expect(recorder.latest?.commission.get('Validator119')).toHaveLength(10);
  });

  it('records without asking Stakewiz when the backfill is off, and does nothing without Postgres', async () => {
    const stakewiz = fakeStakewiz();
    const market = fakeMarket([voteAccount(NTT, 196_541.7, 500)]);
    const recorder = new ValidatorHistoryRecorder(market, stakewiz.source, new MemoryValidatorHistoryStore(), {
      backfill: false,
    });
    await recorder.run();
    expect(recorder.latest?.stake.get(NTT)).toEqual([{ epoch: 1047, sol: 196_542 }]);
    expect(stakewiz.api.getCommissionHistory).not.toHaveBeenCalled();

    const withoutDb = new ValidatorHistoryRecorder(market, stakewiz.source, undefined, { backfill: true });
    withoutDb.start();
    await withoutDb.run();
    expect(withoutDb.latest).toBeUndefined();
  });
});
