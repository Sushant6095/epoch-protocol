import { randomBytes } from 'crypto';
import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import { base58Encode } from '@epoch/epoch-sdk';
import { PostgresConnectionManager, predictCalls, predictMarkets, runMigrations } from '@epoch/pg_models';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';

import { bus, type PredictCallEvent } from '../../Lib/EventBus';
import { predictRouter, sessionMiddleware } from '../../Routes/AccountRouters';
import { type PredictLeaderboard, type PredictSnapshot } from '../../types/Account.types';
import { type AccountServices, buildAccountServices, setAccountServices } from '../Account';
import { type FeeIndexOracle, type IndexValue } from './FeeIndexOracle';
import { marketId, marketLabel, marketQuestion } from './PredictMath';

/** A Fee Index the test moves by hand. */
class FakeOracle implements FeeIndexOracle {
  readonly epochSource = 'test epochs';
  current = 0;
  latest: IndexValue | null = null;
  readonly finals = new Map<number, number>();
  readonly proposed = new Map<number, number>();

  async currentEpoch(): Promise<number> {
    return this.current;
  }
  async latestFinal(): Promise<IndexValue | null> {
    return this.latest;
  }
  async finalValue(epoch: number): Promise<number | null> {
    return this.finals.get(epoch) ?? null;
  }
  async proposedValue(epoch: number): Promise<number | null> {
    return this.proposed.get(epoch) ?? null;
  }
}

const newWallet = (): string => base58Encode(randomBytes(32));
/** This file's markets live in [700,000, 800,000), so other tests' rows never mix in. */
const FROM = 700_000;
const TO = 800_000;

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('Predict in points mode (TEST_DATABASE_URL)', () => {
  const oracle = new FakeOracle();
  let services: AccountServices;
  const events: PredictCallEvent[] = [];
  let stopListening: () => void = () => undefined;

  const db = () => PostgresConnectionManager.getDb();
  const market = (epoch: number, threshold: number) => ({
    id: marketId(epoch, threshold),
    epoch,
    kind: 'above',
    threshold,
    question: marketQuestion(epoch, threshold),
    label: marketLabel(epoch, threshold),
    status: 'open',
  });
  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { statusCode: number; code: string; details: Record<string, unknown> };
    }
    throw new Error('expected a rejection');
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
    const inRange = and(gte(predictMarkets.epoch, FROM), lt(predictMarkets.epoch, TO));
    const old = await db().select({ id: predictMarkets.id }).from(predictMarkets).where(inRange);
    if (old.length)
      await db()
        .delete(predictCalls)
        .where(
          inArray(
            predictCalls.marketId,
            old.map((m) => m.id),
          ),
        );
    await db().delete(predictMarkets).where(inRange);
    services = buildAccountServices({
      env: { ...process.env, PREDICT_MARKETS_AHEAD: '2', PREDICT_POINTS_PER_EPOCH: '100', ALERTS_ENABLED: 'false' },
      roleLookups: { delegator: async () => false, lender: async () => false, operator: async () => false },
      oracle,
      chain: {
        validators: async () => ({ epoch: { epoch: 1, slotIndex: 0 }, rows: [] }),
        stakeAccounts: async () => [],
        inflationRewards: async () => [],
      },
    });
    stopListening = bus.on('predictCall', (event) => events.push(event));
  });

  afterAll(async () => {
    stopListening();
    await PostgresConnectionManager.close();
  });

  it('opens markets for the next epochs from the latest final value, once per epoch', async () => {
    const maker = services.jobs.marketMaker;
    oracle.current = 700_000;
    oracle.latest = null;
    expect(await maker.runOnce()).toEqual([]);

    oracle.latest = { epoch: 699_999, value: 1_284 };
    expect(await maker.runOnce()).toEqual(['fee-index-700001-above-1300', 'fee-index-700002-above-1300']);
    const [row] = await db().select().from(predictMarkets).where(eq(predictMarkets.id, 'fee-index-700001-above-1300'));
    expect(row).toMatchObject({
      epoch: 700_001,
      kind: 'above',
      threshold: 1_300,
      question: 'Will epoch 700001’s Fee Index close above 1,300 µL/CU?',
      label: 'Fee Index above 1,300 · epoch 700001',
      status: 'open',
      outcome: null,
    });
    expect(await maker.runOnce()).toEqual([]);

    oracle.current = 700_001;
    oracle.latest = { epoch: 700_000, value: 1_510 };
    expect(await maker.runOnce()).toEqual(['fee-index-700003-above-1500']);
  });

  it('lets parallel calls from one wallet spend at most its 100 points per epoch', async () => {
    oracle.current = 700_010;
    await db().insert(predictMarkets).values(market(700_012, 1_300));
    const wallet = newWallet();
    const before = events.length;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        services.predict.call(wallet, { marketId: 'fee-index-700012-above-1300', side: 'yes', points: 50 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ statusCode: 409, code: 'NOT_ENOUGH_POINTS', details: { pointsLeft: 0 } });
    }
    const calls = await db().select().from(predictCalls).where(eq(predictCalls.address, wallet));
    expect(calls.map((c) => [c.points, c.epoch])).toEqual([
      [50, 700_010],
      [50, 700_010],
    ]);
    expect(events.slice(before)).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      marketId: 'fee-index-700012-above-1300',
      label: 'Fee Index above 1,300 · epoch 700012',
      address: wallet,
      side: 'yes',
      points: 50,
    });

    // A new epoch brings a fresh 100 (unused points never carry over).
    oracle.current = 700_011;
    const snapshot = await services.predict.call(wallet, {
      marketId: 'fee-index-700012-above-1300',
      side: 'no',
      points: 100,
    });
    expect(snapshot.rules.pointsLeftThisEpoch).toBe(0);
  });

  it('refuses unknown markets, closed markets and calls over the budget', async () => {
    oracle.current = 700_040;
    await db()
      .insert(predictMarkets)
      .values([market(700_040, 1_000), market(700_041, 1_000)]);
    const wallet = newWallet();
    expect(await errorOf(services.predict.call(wallet, { marketId: 'nope', side: 'yes', points: 10 }))).toMatchObject({
      statusCode: 404,
    });
    expect(
      await errorOf(
        services.predict.call(wallet, { marketId: 'fee-index-700040-above-1000', side: 'yes', points: 10 }),
      ),
    ).toMatchObject({
      statusCode: 409,
      code: 'MARKET_CLOSED',
      details: { closesAtEpoch: 700_040, currentEpoch: 700_040 },
    });
    await services.predict.call(wallet, { marketId: 'fee-index-700041-above-1000', side: 'yes', points: 25 });
    await services.predict.call(wallet, { marketId: 'fee-index-700041-above-1000', side: 'no', points: 50 });
    expect(
      await errorOf(
        services.predict.call(wallet, { marketId: 'fee-index-700041-above-1000', side: 'yes', points: 50 }),
      ),
    ).toMatchObject({ statusCode: 409, code: 'NOT_ENOUGH_POINTS', details: { pointsLeft: 25 } });
  });

  it('builds the page: markets newest first with pool, share, players and the now-line; my calls and points', async () => {
    const [w1, w2] = [newWallet(), newWallet()];
    oracle.current = 700_020;
    oracle.proposed.set(700_019, 1_330);
    const settled = (epoch: number, threshold: number, outcome: string, resolvedValue: number) => ({
      ...market(epoch, threshold),
      status: 'settled',
      outcome,
      resolvedValue,
      resolvedAt: new Date(),
    });
    await db()
      .insert(predictMarkets)
      .values([
        market(700_021, 1_500),
        market(700_020, 1_250),
        market(700_019, 1_300),
        market(700_018, 1_200),
        settled(700_017, 1_200, 'yes', 1_284),
        settled(700_017, 1_250, 'refunded', 1_250),
        settled(700_016, 1_200, 'no', 1_100),
      ]);
    await db()
      .insert(predictCalls)
      .values([
        { marketId: 'fee-index-700020-above-1250', address: w1, side: 'no', points: 100, epoch: 700_019 },
        { marketId: 'fee-index-700021-above-1500', address: w1, side: 'yes', points: 50, epoch: 700_020 },
        { marketId: 'fee-index-700021-above-1500', address: w2, side: 'no', points: 25, epoch: 700_020 },
        { marketId: 'fee-index-700020-above-1250', address: w2, side: 'yes', points: 60, epoch: 700_019 },
      ]);

    const page = await services.predict.snapshot(w1);
    expect(page).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      source: 'api_app Predict in points mode',
      rules: {
        mode: 'points',
        pointsPerEpoch: 100,
        callSizesPoints: [10, 25, 50, 100],
        pointsLeftThisEpoch: 50,
        feeBps: 0,
        leaderboardEpochs: 30,
        ageGate: '18+',
        regions: 'where allowed',
      },
      payoutFormula:
        'payout = a * (P + a) / (s * P + a)  // a = points called, P = pool in points, s = chosen side share; no fee in points mode',
    });
    expect(page.asOf).toMatch(/\+05:30$/);
    expect(page.note).toContain('Points have no cash value');
    const ours = page.markets.filter((m) => m.closesAtEpoch >= 700_016 && m.closesAtEpoch <= 700_021);
    expect(ours.map((m) => [m.closesAtEpoch, m.status, m.nowNote])).toEqual([
      [700_021, 'open', null],
      [700_020, 'closed', 'Epoch 700020 is running; its index is posted when it ends'],
      [700_019, 'closed', 'Proposed 1,330 µL/CU, in its dispute window'],
      [700_018, 'closed', 'Waiting for epoch 700018’s Fee Index'],
      [700_017, 'settled', 'Final 1,284 µL/CU: YES'],
      [700_017, 'settled', 'Final 1,250 µL/CU: nobody called the winning side, calls refunded'],
    ]);
    // Settled more than 3 epochs before the current one: off the page.
    expect(page.markets.find((m) => m.closesAtEpoch === 700_016)).toBeUndefined();
    expect(ours[0]).toEqual({
      id: 'fee-index-700021-above-1500',
      question: 'Will epoch 700021’s Fee Index close above 1,500 µL/CU?',
      yesShare: 0.6667,
      poolPoints: 75,
      players: 2,
      closesAtEpoch: 700_021,
      status: 'open',
      nowNote: null,
      answerSource: 'Epoch Fee Index, final value after its dispute window',
    });
    expect(ours[3]).toMatchObject({ yesShare: 0.5, poolPoints: 0, players: 0 });
    expect(page.myCalls).toEqual([
      {
        label: 'Fee Index above 1,500 · epoch 700021',
        side: 'yes',
        points: 50,
        status: 'open',
        estPayoutPoints: 75, // 50 + 50 × 25 / 50
        netPoints: null,
      },
      {
        label: 'Fee Index above 1,250 · epoch 700020',
        side: 'no',
        points: 100,
        status: 'settling',
        estPayoutPoints: 160, // 100 + 100 × 60 / 100
        netPoints: null,
      },
    ]);

    const anonymous = await services.predict.snapshot();
    expect(anonymous.rules.pointsLeftThisEpoch).toBeNull();
    expect(anonymous.myCalls).toEqual([]);
  });

  it('settles from the final value in one go: proportional shares, refunds, idempotent; then ranks wallets', async () => {
    const [alice, bob, carol, dave] = [newWallet(), newWallet(), newWallet(), newWallet()];
    oracle.current = 700_032;
    await db()
      .insert(predictMarkets)
      .values([market(700_030, 1_300), market(700_031, 1_300), market(700_029, 1_300)]);
    await db()
      .insert(predictCalls)
      .values([
        { marketId: 'fee-index-700030-above-1300', address: alice, side: 'yes', points: 100, epoch: 700_028 },
        { marketId: 'fee-index-700030-above-1300', address: bob, side: 'yes', points: 50, epoch: 700_028 },
        { marketId: 'fee-index-700030-above-1300', address: carol, side: 'no', points: 100, epoch: 700_028 },
        { marketId: 'fee-index-700030-above-1300', address: dave, side: 'no', points: 10, epoch: 700_028 },
        { marketId: 'fee-index-700031-above-1300', address: alice, side: 'no', points: 25, epoch: 700_029 },
        { marketId: 'fee-index-700029-above-1300', address: carol, side: 'no', points: 50, epoch: 700_027 },
        { marketId: 'fee-index-700029-above-1300', address: dave, side: 'no', points: 10, epoch: 700_027 },
      ]);
    oracle.finals.set(700_030, 1_400); // YES
    oracle.finals.set(700_029, 1_500); // YES, but nobody called it: refunded
    // 700_031 has no final value yet (proposed or vetoed): it waits.

    const settled = await services.jobs.resolver.runOnce();
    expect(settled.filter((s) => s.marketId.includes('-7000')).map((s) => [s.marketId, s.outcome])).toEqual([
      ['fee-index-700029-above-1300', 'refunded'],
      ['fee-index-700030-above-1300', 'yes'],
    ]);
    const payouts = async (id: string) =>
      Object.fromEntries(
        (await db().select().from(predictCalls).where(eq(predictCalls.marketId, id))).map((c) => [
          `${c.address === alice ? 'alice' : c.address === bob ? 'bob' : c.address === carol ? 'carol' : 'dave'}`,
          c.payoutPoints,
        ]),
      );
    // W = 150, L = 110: alice 100 + floor(100 × 110 / 150) = 173, bob 50 + floor(36.67) = 86
    expect(await payouts('fee-index-700030-above-1300')).toEqual({ alice: 173, bob: 86, carol: 0, dave: 0 });
    expect(await payouts('fee-index-700029-above-1300')).toEqual({ carol: 50, dave: 10 });
    expect(await payouts('fee-index-700031-above-1300')).toEqual({ alice: null });
    const [m30] = await db().select().from(predictMarkets).where(eq(predictMarkets.id, 'fee-index-700030-above-1300'));
    expect(m30).toMatchObject({ status: 'settled', outcome: 'yes', resolvedValue: 1_400 });
    expect(m30.resolvedAt).toBeInstanceOf(Date);

    // Idempotent: a rerun (or a second process) changes nothing.
    expect((await services.jobs.resolver.runOnce()).filter((s) => s.marketId.includes('-7000'))).toEqual([]);
    expect(await services.jobs.resolver.settle('fee-index-700030-above-1300', 1_000)).toBeNull();
    expect(await payouts('fee-index-700030-above-1300')).toEqual({ alice: 173, bob: 86, carol: 0, dave: 0 });

    const mine = await services.predict.snapshot(carol);
    expect(mine.myCalls.map((c) => [c.label, c.status, c.netPoints])).toEqual([
      ['Fee Index above 1,300 · epoch 700029', 'refunded', 0],
      ['Fee Index above 1,300 · epoch 700030', 'lost', -100],
    ]);

    const board = await services.predict.leaderboard(30);
    expect(board).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      epochs: 30,
      source: 'api_app Predict in points mode',
    });
    const rows = board.rows.filter((r) =>
      [alice, bob, carol, dave].some((w) => r.walletShort === `${w.slice(0, 4)}…${w.slice(-4)}`),
    );
    expect(
      rows.map(({ walletShort, netPoints, hitPct, calls }) => [walletShort.slice(0, 4), netPoints, hitPct, calls]),
    ).toEqual([
      [alice.slice(0, 4), 73, 100, 1],
      [bob.slice(0, 4), 36, 100, 1],
      [dave.slice(0, 4), -10, 0, 2],
      [carol.slice(0, 4), -100, 0, 2],
    ]);
    expect(board.rows.map((r) => r.rank)).toEqual(board.rows.map((_, i) => i + 1));
  });

  describe('over HTTP', () => {
    let server: ExpressAppServer;
    let base = '';

    beforeAll(async () => {
      setAccountServices(services);
      server = new ExpressAppServer({ appName: 'predict-test', port: 0 })
        .use(sessionMiddleware)
        .route('/v1/predict', predictRouter);
      await server.start();
      base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await server.stop();
      setAccountServices(undefined);
    });

    it('reads markets publicly, needs the session to call, validates the body', async () => {
      oracle.current = 700_050;
      await db().insert(predictMarkets).values(market(700_051, 1_300));
      const wallet = newWallet();
      const { token } = await services.sessions.create(wallet, 1, 'jest');
      const cookie = `epoch_session=${token}`;
      const json = async <T = PredictSnapshot>(res: Response) => ({
        status: res.status,
        body: (await res.json()) as { ok: boolean; data: T; error: { code: string } },
      });
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}/v1/predict/calls`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }).then((res) => json(res));

      const anonymous = await json(await fetch(`${base}/v1/predict/markets`));
      expect(anonymous.status).toBe(200);
      expect(anonymous.body.data.rules.pointsLeftThisEpoch).toBeNull();
      const signedIn = await json(await fetch(`${base}/v1/predict/markets`, { headers: { cookie } }));
      expect(signedIn.body.data.rules.pointsLeftThisEpoch).toBe(100);

      const call = { marketId: 'fee-index-700051-above-1300', side: 'yes', points: 25 };
      expect((await post(call)).body.error.code).toBe('UNAUTHORIZED');
      expect((await post({ ...call, points: 30 }, { cookie })).status).toBe(400);
      expect((await post({ ...call, side: 'maybe' }, { cookie })).status).toBe(400);
      const made = await post(call, { cookie, origin: 'http://localhost:3000' });
      expect(made.status).toBe(200);
      expect(made.body.data.rules.pointsLeftThisEpoch).toBe(75);
      expect(made.body.data.myCalls[0]).toMatchObject({ side: 'yes', points: 25, status: 'open', estPayoutPoints: 25 });

      const board = await json<PredictLeaderboard>(await fetch(`${base}/v1/predict/leaderboard?epochs=30`));
      expect(board.status).toBe(200);
      expect(board.body.data.epochs).toBe(30);
      expect((await json(await fetch(`${base}/v1/predict/leaderboard?epochs=0`))).status).toBe(400);
    });
  });
});
