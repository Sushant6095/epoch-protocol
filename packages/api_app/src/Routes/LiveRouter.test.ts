import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import {
  type EpochDb,
  epochFeeMix,
  epochIndex,
  epochStakes,
  feeIndexLive,
  liveSlots,
  PostgresConnectionManager,
  runMigrations,
  slotFeeMix,
  slotFees,
  solamiUsageReports,
} from '@epoch/pg_models';
import { TransactionRollbackError } from 'drizzle-orm';

import { getLiveService, LiveService, setLiveService } from '../Services/Live';
import { PgLiveRepository } from '../Services/Live/LiveRepository';
import { liveRouter } from './LiveRouter';

const TEST_DB = process.env.TEST_DATABASE_URL;
const A = '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS';
const B = 'A1vqhA2fS6K7CvHsJKX1ACcHJFEmyRg4KuR5pctHANy4';

interface Reply<T> {
  status: number;
  body: { ok: boolean; data: T; error?: { code: string } };
}

async function serve(): Promise<{ server: ExpressAppServer; get: <T>(path: string) => Promise<Reply<T>> }> {
  const server = new ExpressAppServer({ appName: 'live-router-test', port: 0 }).route('/v1/live', liveRouter);
  await server.start();
  const base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  return {
    server,
    get: async <T>(path: string) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: (await res.json()) as Reply<T>['body'] };
    },
  };
}

describe('/v1/live without Postgres', () => {
  const saved = process.env.DATABASE_URL;
  beforeAll(() => {
    delete process.env.DATABASE_URL;
    setLiveService(undefined);
  });
  afterAll(() => {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });

  it('answers 503 DATABASE_NOT_CONFIGURED and validates queries', async () => {
    const { server, get } = await serve();
    try {
      const summary = await get('/v1/live/summary');
      expect(summary.status).toBe(503);
      expect(summary.body.error?.code).toBe('DATABASE_NOT_CONFIGURED');
      expect((await get('/v1/live/slots?limit=0')).status).toBe(400);
      expect((await get('/v1/live/slots?limit=501')).status).toBe(400);
      expect((await get('/v1/live/epochs/abc/distribution')).status).toBe(400);
      expect(() => getLiveService()).toThrow('DATABASE_URL');
    } finally {
      await server.stop();
    }
  });
});

(TEST_DB ? describe : describe.skip)('/v1/live over Postgres (TEST_DATABASE_URL)', () => {
  // CI runs every package's test files in parallel against one database: the seed uses epochs no other test file uses
  // and lives in a transaction that is rolled back once the requests are answered.
  const EPOCH = 7_248;
  const S = EPOCH * 432_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });

  afterAll(async () => {
    setLiveService(undefined);
    await PostgresConnectionManager.close();
  });

  async function seed(db: EpochDb, now: number): Promise<void> {
    // Leader A with slot medians 100, 300 (median 200); leader B with 1000, 3000, 5000, 7001 (4000).
    await db.insert(slotFees).values([
      { slot: S + 1, epoch: EPOCH, leader: A, medianCuPrice: 100, txCount: 10 },
      { slot: S + 2, epoch: EPOCH, leader: A, medianCuPrice: 300, txCount: 10 },
      { slot: S + 3, epoch: EPOCH, leader: B, medianCuPrice: 1_000, txCount: 20 },
      { slot: S + 4, epoch: EPOCH, leader: B, medianCuPrice: 3_000, txCount: 20 },
      { slot: S + 5, epoch: EPOCH, leader: B, medianCuPrice: 5_000, txCount: 20 },
      { slot: S + 6, epoch: EPOCH, leader: B, medianCuPrice: 7_001, txCount: 20 },
    ]);
    await db.insert(epochStakes).values([
      { epoch: EPOCH, identity: A, stakeLamports: 3_000_000_000_000_000n },
      { epoch: EPOCH, identity: B, stakeLamports: 1_000_000_000_000_000n },
    ]);
    await db.insert(epochIndex).values({ epoch: EPOCH - 1, value: 9_120 });
    const block = {
      epoch: EPOCH,
      leader: B,
      p25CuPrice: 1,
      p75CuPrice: 9,
      p90CuPrice: 10,
      pricedTxs: 20,
      unpricedTxs: 3,
      leaderPaidTxs: 1,
      failedTxs: 2,
      source: 'grpc',
    };
    await db.insert(liveSlots).values([
      { ...block, slot: S + 5, blockTime: new Date(now - 2_400), medianCuPrice: 5_000 },
      { ...block, slot: S + 6, blockTime: new Date(now - 2_000), medianCuPrice: 7_001 },
    ]);
    // Fee composition (request #30) for the newest block only: S + 5 was indexed before the indexer recorded it.
    await db.insert(slotFeeMix).values({
      slot: S + 6,
      epoch: EPOCH,
      baseFeeLamports: 5_175_000n,
      priorityFeeLamports: 31_630_143n,
      tipLamports: 6_287_601n,
      tipTxs: 23,
      voteTxs: 1_005,
      nonVoteTxs: 30,
      feeRewardLamports: 34_217_643n,
      baseFeeBasis: 'reward',
      source: 'grpc',
    });
    const rollup = {
      blocks: 2,
      baseFeeLamports: 6_000_000n,
      priorityFeeLamports: 3_000_000n,
      tipLamports: 1_000_000n,
      tipTxs: 4,
      voteTxs: 2_000,
      nonVoteTxs: 60,
      feeRewardLamports: 6_000_000n,
      estimatedBlocks: 0,
    };
    await db.insert(epochFeeMix).values([
      { ...rollup, epoch: EPOCH, firstSlot: S + 5, lastSlot: S + 6 },
      { ...rollup, epoch: EPOCH - 1, firstSlot: S - 432_000, lastSlot: S - 1, blocks: 431_000 },
    ]);
    // What indexer_app writes every 10 s (a unique name: other test files may write their own rows in parallel).
    await db.insert(solamiUsageReports).values({
      component: 'route-test-indexer',
      report: {
        component: 'route-test-indexer',
        startedAt: now - 60_000,
        at: now - 1_000,
        grpc: {
          subscription: 'meta',
          endpoint: 'solami',
          status: 'streaming',
          compression: null,
          bytes: 123_456,
          updates: 789,
          reconnects: 0,
          lastUpdateAt: now - 1_000,
          lagSlots: 1,
        },
        rpc: [],
        beam: null,
        lastError: null,
      },
      updatedAt: new Date(now - 1_000),
    });
    await db.insert(feeIndexLive).values({
      epoch: EPOCH,
      estimate: 200,
      leaders: 2,
      slotsWithFees: 6,
      pricedTxs: 100,
      firstSlot: S + 1,
      processedSlot: S + 6,
      watermarkSlot: S + 6,
      tipSlot: S + 8,
      stakeEpoch: EPOCH,
      source: 'grpc',
      endpoint: 'solami',
      status: 'streaming',
      lastSlotAt: new Date(now - 1_000),
      updatedAt: new Date(now - 500),
    });
  }

  /** Seeds a snapshot transaction, serves /v1/live from it, then rolls it back. */
  const withSeed = (test: (get: <T>(path: string) => Promise<Reply<T>>) => Promise<void>) =>
    PostgresConnectionManager.getDb()
      .transaction(
        async (tx) => {
          const db = tx as unknown as EpochDb;
          await seed(db, Date.now());
          setLiveService(
            new LiveService({
              repo: new PgLiveRepository(db),
              epochInfo: async () => null,
              names: async () => ({ byVote: new Map(), byIdentity: new Map([[B, 'Helius']]) }),
              staleAfterMs: 20_000,
            }),
          );
          const { server, get } = await serve();
          try {
            await test(get);
          } finally {
            setLiveService(undefined);
            await server.stop();
          }
          tx.rollback();
        },
        { isolationLevel: 'repeatable read' },
      )
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

  it('GET /summary', () =>
    withSeed(async (get) => {
      const { status, body } = await get<Record<string, unknown>>('/v1/live/summary');
      expect(status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        data: {
          live: true,
          processedSlot: S + 6,
          tipSlot: S + 8,
          lagSlots: 2,
          estimate: { epoch: EPOCH, value: 200 },
          lastFinal: { epoch: EPOCH - 1, value: 9_120 },
          stream: { status: 'streaming', endpoint: 'solami' },
          fees: {
            epoch: EPOCH,
            blocks: 2,
            baseLamports: 6_000_000,
            priorityLamports: 3_000_000,
            tipsLamports: 1_000_000,
            totalSol: 0.01,
            sharePct: { base: 60, priority: 30, tips: 10 },
          },
          lastEpochFees: { epoch: EPOCH - 1, blocks: 431_000 },
        },
      });
    }));

  it('GET /slots, newest first', () =>
    withSeed(async (get) => {
      const { body } = await get<{ slots: Record<string, unknown>[] }>('/v1/live/slots?limit=2');
      expect(body.data.slots).toEqual([
        expect.objectContaining({
          slot: S + 6,
          leaderName: 'Helius',
          medianCuPrice: 7_001,
          leaderPaidTxs: 1,
          fees: {
            baseLamports: 5_175_000,
            priorityLamports: 31_630_143,
            tipsLamports: 6_287_601,
            tipTxs: 23,
            rewardLamports: 34_217_643,
            basis: 'reward',
          },
        }),
        expect.objectContaining({ slot: S + 5, medianCuPrice: 5_000, fees: null }),
      ]);
      const one = await get<{ slots: Record<string, unknown>[] }>('/v1/live/slots?limit=1');
      expect(one.body.data.slots.map((s) => s.slot)).toEqual([S + 6]);
    }));

  it('GET /leaders computes per-leader medians in SQL exactly like the indexer (⌊(a+b)/2⌋)', () =>
    withSeed(async (get) => {
      const { body } = await get<{ leaders: Record<string, unknown>[]; value: number; setter: string }>(
        `/v1/live/leaders?epoch=${EPOCH}`,
      );
      expect(body.data.leaders).toEqual([
        expect.objectContaining({ rank: 1, identity: A, slots: 2, medianCuPrice: 200, weightPct: 75, setsIndex: true }),
        expect.objectContaining({ rank: 2, identity: B, slots: 4, medianCuPrice: 4_000, name: 'Helius' }),
      ]);
      expect(body.data).toMatchObject({ value: 200, setter: A, final: false });
    }));

  it('GET /solami: each component’s Solami usage from solami_usage, plus the API’s own', () =>
    withSeed(async (get) => {
      const { status, body } = await get<{
        components: { name: string; stale: boolean }[];
        grpc: Record<string, unknown>[];
        inUse: string[];
      }>('/v1/live/solami');
      expect(status).toBe(200);
      expect(body.data.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'route-test-indexer', stale: false }),
          expect.objectContaining({ name: 'api', stale: false }),
        ]),
      );
      expect(body.data.grpc).toContainEqual(
        expect.objectContaining({ component: 'route-test-indexer', status: 'streaming', bytes: 123_456, lagSlots: 1 }),
      );
      expect(body.data.inUse).toContain('grpc');
    }));

  it('GET /epochs/:epoch/distribution', () =>
    withSeed(async (get) => {
      const { body } = await get<Record<string, unknown>>(`/v1/live/epochs/${EPOCH}/distribution`);
      expect(body.data).toMatchObject({
        epoch: EPOCH,
        slots: 6,
        percentiles: { p10: 100, p25: 300, p50: 1_000, p75: 5_000, p90: 7_001 },
        indexValue: 200,
      });
      const buckets = (body.data as { buckets: { fromCuPrice: number; slots: number }[] }).buckets;
      expect(buckets[0]).toEqual({ fromCuPrice: 100, toCuPrice: 178, slots: 1 });
      expect(buckets.reduce((sum, b) => sum + b.slots, 0)).toBe(6);
    }));
});
