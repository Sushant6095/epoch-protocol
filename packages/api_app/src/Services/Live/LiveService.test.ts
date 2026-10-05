import { nameIndex } from '../Activity/ValidatorNames';
import { type FeeIndexLiveRow, type LiveRepository, type LiveSlotRow } from './LiveRepository';
import { LiveService, weightedMedian } from './LiveService';

const IST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;
const A = '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS';
const B = 'A1vqhA2fS6K7CvHsJKX1ACcHJFEmyRg4KuR5pctHANy4';
const C = 'GnC339vkyXRm1jRX69dt9mapPPu2LbzXfSDoxc91qta6';
const NOW = Date.parse('2026-10-03T13:30:00Z');

function liveRow(patch: Partial<FeeIndexLiveRow> = {}): FeeIndexLiveRow {
  return {
    epoch: 1048,
    estimate: 9_400,
    leaders: 812,
    slotsWithFees: 200_000,
    pricedTxs: 31_000_000,
    firstSlot: 452_736_000,
    processedSlot: 452_937_400,
    watermarkSlot: 452_937_390,
    tipSlot: 452_937_403,
    stakeEpoch: 1048,
    source: 'grpc',
    endpoint: 'solami',
    status: 'streaming',
    stride: 1,
    lastSlotAt: new Date(NOW - 1_000),
    updatedAt: new Date(NOW - 500),
    ...patch,
  };
}

const slotRow = (slot: number, median: number | null): LiveSlotRow => ({
  slot,
  epoch: 1048,
  leader: A,
  blockTime: new Date(Date.parse('2026-10-03T12:48:20Z')),
  medianCuPrice: median,
  p25CuPrice: median,
  p75CuPrice: median,
  p90CuPrice: median,
  pricedTxs: median === null ? 0 : 132,
  unpricedTxs: 101,
  leaderPaidTxs: 0,
  failedTxs: 31,
  source: 'grpc',
  recordedAt: new Date(NOW),
});

function fakeRepo(overrides: Partial<LiveRepository> = {}): LiveRepository {
  return {
    latestLive: async () => liveRow(),
    liveFor: async (epoch) => (epoch === 1048 ? liveRow() : null),
    lastFinal: async () => ({
      epoch: 1047,
      value: 9_120,
      postedSignature: null,
      computedAt: new Date(NOW - 3_600_000),
    }),
    finalFor: async (epoch) =>
      epoch === 1047 ? { epoch, value: 9_120, postedSignature: 'sig', computedAt: new Date(NOW - 3_600_000) } : null,
    recentSlots: async (limit) => [slotRow(452_937_400, 10_000), slotRow(452_937_399, null)].slice(0, limit),
    leaderStats: async () => [
      { leader: A, slots: 400, medianCuPrice: 7_000, pricedTxs: 50_000 },
      { leader: B, slots: 600, medianCuPrice: 8_000, pricedTxs: 70_000 },
      { leader: C, slots: 10, medianCuPrice: 1_000_000, pricedTxs: 900 },
      { leader: 'unstaked', slots: 3, medianCuPrice: 5, pricedTxs: 10 },
    ],
    stakes: async () => ({
      epoch: 1048,
      stakes: new Map([
        [A, 100_000_000_000_000_000n],
        [B, 150_000_000_000_000_000n],
        [C, 1_000_000_000n],
      ]),
    }),
    distribution: async () => ({
      slots: 7,
      buckets: [
        { bucket: 12, slots: 2 },
        { bucket: 14, slots: 5 },
      ],
      percentiles: { p10: 1_000, p25: 1_000, p50: 3_162, p75: 3_200, p90: 3_300 },
    }),
    ...overrides,
  };
}

const service = (repo: LiveRepository, info: { slot?: number } | null = { slot: 452_937_405 }) =>
  new LiveService({
    repo,
    epochInfo: async () =>
      info
        ? {
            epoch: 1048,
            slotIndex: (info.slot ?? 0) - 452_736_000,
            slotsInEpoch: 432_000,
            absoluteSlot: info.slot ?? 0,
          }
        : null,
    names: async () => nameIndex([{ name: 'Helius', vote: 'v1', identity: A }]),
    staleAfterMs: 20_000,
    now: () => NOW,
  });

describe('LiveService.summary', () => {
  it('reports a live stream: tip, processed slot, lag, epoch progress, estimate and the last final value', async () => {
    const summary = await service(fakeRepo()).summary();
    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      live: true,
      dataSource: 'Solami gRPC (Yellowstone)',
      tipSlot: 452_937_405,
      processedSlot: 452_937_400,
      lagSlots: 5,
      lagSeconds: 2,
      epoch: { number: 1048, firstSlot: 452_736_000, slotIndex: 201_405, slotsInEpoch: 432_000, progressPct: 46.62 },
      estimate: { epoch: 1048, value: 9_400, leaders: 812, coverageFromSlot: 452_736_000, sampled: false },
      lastFinal: { epoch: 1047, value: 9_120, postedSignature: null },
      stream: { source: 'grpc', endpoint: 'solami', status: 'streaming', gapSlots: 10, catchingUp: false },
      unit: 'µL/CU',
    });
    expect(summary.estimate?.coveragePct).toBe(100);
    expect(summary.asOf).toMatch(IST);
    expect(summary.stream.lastSlotAt).toMatch(IST);
  });

  it('never presents stale data as live: an old heartbeat is `offline`, an old last slot is not live', async () => {
    const stale = await service(
      fakeRepo({ latestLive: async () => liveRow({ updatedAt: new Date(NOW - 60_000) }) }),
    ).summary();
    expect(stale.live).toBe(false);
    expect(stale.stream.status).toBe('offline');
    expect(stale.estimate?.value).toBe(9_400);

    const stalled = await service(
      fakeRepo({ latestLive: async () => liveRow({ lastSlotAt: new Date(NOW - 45_000), status: 'reconnecting' }) }),
    ).summary();
    expect(stalled.live).toBe(false);
    expect(stalled.stream).toMatchObject({ status: 'reconnecting', secondsSinceLastSlot: 45 });
  });

  it('moves a cached tip forward by the time since it was read, so a stopped indexer shows growing lag', async () => {
    const stopped = liveRow({
      updatedAt: new Date(NOW - 40_000),
      lastSlotAt: new Date(NOW - 40_000),
      tipSlot: 452_937_405,
    });
    const summary = await new LiveService({
      repo: fakeRepo({ latestLive: async () => stopped }),
      epochInfo: async () => ({
        epoch: 1048,
        slotIndex: 201_300,
        slotsInEpoch: 432_000,
        absoluteSlot: 452_937_300,
        readAt: NOW - 40_000,
      }),
      names: async () => nameIndex([]),
      staleAfterMs: 20_000,
      now: () => NOW,
    }).summary();
    expect(summary.live).toBe(false);
    // 40 s since the read: 100 slots later. The indexer's own tip is not trusted while it is down.
    expect(summary.tipSlot).toBe(452_937_400);
    expect(summary.lagSlots).toBe(0);
    expect(summary.stream.status).toBe('offline');
  });

  it('answers before the indexer ever ran, and without the RPC', async () => {
    const empty = await service(
      fakeRepo({ latestLive: async () => null, lastFinal: async () => null }),
      null,
    ).summary();
    expect(empty).toMatchObject({ live: false, estimate: null, lastFinal: null, tipSlot: null, epoch: null });
    expect(empty.stream.status).toBe('offline');
    expect(empty.note).toContain('indexer_app');
  });

  it('labels hybrid, RPC Fast failover and sampled RPC runs', async () => {
    const label = async (patch: Partial<FeeIndexLiveRow>) =>
      (await service(fakeRepo({ latestLive: async () => liveRow(patch) })).summary()).dataSource;
    expect(await label({ source: 'hybrid' })).toBe('Solami gRPC (block meta) + Solami RPC (blocks)');
    expect(await label({ endpoint: 'rpc-fast' })).toBe('RPC Fast gRPC (failover)');
    expect(await label({ source: 'rpc', endpoint: 'api.mainnet-beta.solana.com' })).toBe(
      'RPC polling (api.mainnet-beta.solana.com)',
    );
    const sampled = await service(fakeRepo({ latestLive: async () => liveRow({ stride: 8 }) })).summary();
    expect(sampled.estimate?.sampled).toBe(true);
  });
});

describe('LiveService.slots', () => {
  it('maps live_slots rows with leader names and IST block times', async () => {
    const slots = await service(fakeRepo()).slots(60);
    expect(slots.live).toBe(true);
    expect(slots.slots[0]).toEqual({
      slot: 452_937_400,
      epoch: 1048,
      leader: A,
      leaderName: 'Helius',
      medianCuPrice: 10_000,
      p25CuPrice: 10_000,
      p75CuPrice: 10_000,
      p90CuPrice: 10_000,
      pricedTxs: 132,
      unpricedTxs: 101,
      leaderPaidTxs: 0,
      failedTxs: 31,
      time: '2026-10-03T18:18:20+05:30',
      source: 'grpc',
    });
    expect(slots.slots[1].medianCuPrice).toBeNull();
  });
});

describe('LiveService.leaders', () => {
  it('ranks by stake, weights by stake share and marks the leader whose median is the index', async () => {
    const result = await service(fakeRepo()).leaders(undefined, 200);
    expect(result).toMatchObject({ epoch: 1048, final: false, value: 8_000, setter: B, leaderCount: 4, live: true });
    expect(result.leaders.map((l) => [l.rank, l.identity, l.setsIndex])).toEqual([
      [1, B, true],
      [2, A, false],
      [3, C, false],
      [4, 'unstaked', false],
    ]);
    expect(result.leaders[1]).toMatchObject({ name: 'Helius', stakeSol: 100_000_000, weightPct: 40 });
    expect(result.leaders[3]).toMatchObject({ stakeSol: null, weightPct: 0 });
    expect(result.totalStakeSol).toBe(250_000_001);
  });

  it('serves a finished epoch with its final value', async () => {
    const result = await service(fakeRepo()).leaders(1047, 2);
    expect(result).toMatchObject({ epoch: 1047, final: true, value: 9_120, live: false });
    expect(result.leaders).toHaveLength(2);
  });
});

describe('LiveService.distribution', () => {
  it('fills empty buckets between the first and last and marks the index value', async () => {
    const result = await service(fakeRepo()).distribution(1048);
    expect(result.buckets).toEqual([
      { fromCuPrice: 1_000, toCuPrice: 1_778, slots: 2 },
      { fromCuPrice: 1_778, toCuPrice: 3_162, slots: 0 },
      { fromCuPrice: 3_162, toCuPrice: 5_623, slots: 5 },
    ]);
    expect(result).toMatchObject({ epoch: 1048, final: false, indexValue: 9_400, slots: 7, live: true });
    const finished = await service(fakeRepo()).distribution(1047);
    expect(finished).toMatchObject({ final: true, indexValue: 9_120, live: false });
  });
});

describe('weightedMedian', () => {
  it('is the stake-weighted median, ignoring unstaked leaders', () => {
    expect(
      weightedMedian([
        { leader: 'a', medianCuPrice: 7_000, stake: 100n },
        { leader: 'b', medianCuPrice: 8_000, stake: 150n },
        { leader: 'c', medianCuPrice: 1_000_000, stake: 1n },
        { leader: 'd', medianCuPrice: 1, stake: 0n },
      ])?.leader,
    ).toBe('b');
    expect(weightedMedian([])).toBeNull();
  });
});
