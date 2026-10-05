import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import {
  type EpochDb,
  epochIndex,
  epochStakes,
  feeIndexLive,
  liveSlots,
  PostgresConnectionManager,
  runMigrations,
  slotFees,
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
        },
      });
    }));

  it('GET /slots, newest first', () =>
    withSeed(async (get) => {
      const { body } = await get<{ slots: Record<string, unknown>[] }>('/v1/live/slots?limit=2');
      expect(body.data.slots).toEqual([
        expect.objectContaining({ slot: S + 6, leaderName: 'Helius', medianCuPrice: 7_001, leaderPaidTxs: 1 }),
        expect.objectContaining({ slot: S + 5, medianCuPrice: 5_000 }),
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
