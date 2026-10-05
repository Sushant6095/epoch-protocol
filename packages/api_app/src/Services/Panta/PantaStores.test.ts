import { randomBytes } from 'crypto';

import { base58Encode } from '@epoch/epoch-sdk';
import {
  epochIndex,
  pantaMarkets,
  pantaTrades,
  PostgresConnectionManager,
  runMigrations,
  slotFees,
} from '@epoch/pg_models';
import { and, gte, inArray, lt } from 'drizzle-orm';

import { feeIndexRow } from '../../__fixtures__/PantaFakes';
import { type NewPantaTrade, PgIndexReads, PgPantaMarketReader, PgPantaTradeStore } from './PantaStores';

/** This file's rows: epochs in [800,000, 800,100) and wallets it makes up, so other tests' rows never mix in. */
const BASE = 800_000;
const wallet = (): string => base58Encode(randomBytes(32));
const signature = (): string => base58Encode(randomBytes(64));

const trade = (id: string, overrides: Partial<NewPantaTrade> = {}): NewPantaTrade => ({
  id,
  kind: 'buy',
  wallet: wallet(),
  marketId: base58Encode(randomBytes(32)),
  side: 'yes',
  amountUsdc: '20.00',
  amountUsdcBase: 20_000_000,
  feeUsdc: '0.40',
  expectedShares: '38.40',
  quoteId: 'qt_1',
  orderId: 'ord_1',
  messageHash: 'ab'.repeat(32),
  lastValidBlockHeight: 5_000,
  summary: 'Buy YES …',
  consentAt: new Date(),
  sessionAddress: null,
  country: 'IN',
  ...overrides,
});

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('Panta stores on Postgres (TEST_DATABASE_URL)', () => {
  const db = () => PostgresConnectionManager.getDb();
  const ids: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
    const range = (column: typeof pantaMarkets.epoch | typeof epochIndex.epoch | typeof slotFees.epoch) =>
      and(gte(column, BASE), lt(column, BASE + 100));
    await db().delete(pantaMarkets).where(range(pantaMarkets.epoch));
    await db().delete(epochIndex).where(range(epochIndex.epoch));
    await db().delete(slotFees).where(range(slotFees.epoch));
  });

  afterAll(async () => {
    if (ids.length) await db().delete(pantaTrades).where(inArray(pantaTrades.id, ids));
    await PostgresConnectionManager.close();
  });

  it('records a trade from consent to attribution', async () => {
    const store = new PgPantaTradeStore(db);
    const id = `ptr_${randomBytes(9).toString('base64url')}`;
    ids.push(id);
    const row = trade(id);
    await store.insert(row);
    expect(await store.get(id)).toMatchObject({
      ...row,
      status: 'built',
      reportStatus: 'pending',
      reportAttempts: 0,
      signature: null,
    });
    expect(await store.get('ptr_missing')).toBeNull();

    const sig = signature();
    expect(await store.markSubmitted(id, sig)).toBe(true);
    expect(await store.markSubmitted(id, signature())).toBe(false); // not built any more
    // The same signature cannot back a second trade.
    const twin = `ptr_${randomBytes(9).toString('base64url')}`;
    ids.push(twin);
    await store.insert(trade(twin));
    expect(await store.markSubmitted(twin, sig)).toBe(false);

    const since = new Date(Date.now() - 60_000);
    expect((await store.pending(since, 10)).map((t) => t.id)).toContain(id);
    await store.settle(id, 'confirmed');
    await store.recordReport(id, { status: 'pending', error: 'TX_NOT_FOUND: not yet' });
    await store.recordReport(id, { status: 'processed' });
    const done = await store.get(id);
    expect(done).toMatchObject({
      status: 'confirmed',
      reportStatus: 'processed',
      reportAttempts: 2,
      reportError: null,
    });
    expect(done?.confirmedAt).toBeInstanceOf(Date);
    expect(done?.reportedAt).toBeInstanceOf(Date);
    expect((await store.pending(since, 10)).map((t) => t.id)).not.toContain(id);

    const totals = await store.totals();
    expect(totals.trades).toBeGreaterThanOrEqual(1);
    expect(totals.attributed).toBeGreaterThanOrEqual(1);
    expect(totals.volumeUsdcBase).toBeGreaterThanOrEqual(20_000_000);
    expect(totals.lastTradeAt).toBeInstanceOf(Date);
  });

  it('marks an expired trade failed for attribution', async () => {
    const store = new PgPantaTradeStore(db);
    const id = `ptr_${randomBytes(9).toString('base64url')}`;
    ids.push(id);
    await store.insert(trade(id));
    await store.markSubmitted(id, signature());
    await store.settle(id, 'expired');
    expect(await store.get(id)).toMatchObject({
      status: 'expired',
      reportStatus: 'failed',
      reportError: 'transaction expired',
    });
  });

  it('reads our registered markets and their totals', async () => {
    const reader = new PgPantaMarketReader(db);
    const live = {
      ...feeIndexRow(BASE + 2, 1_300, base58Encode(randomBytes(32))),
      endTime: new Date(Date.now() + 3_600_000),
    };
    const older = feeIndexRow(BASE + 1, 1_250, base58Encode(randomBytes(32)));
    const { id: _a, ...liveRow } = live;
    const { id: _b, ...olderRow } = older;
    await db()
      .insert(pantaMarkets)
      .values([
        liveRow,
        olderRow,
        { ...olderRow, threshold: 9_999, status: 'planned', marketId: null, paidUsdcBase: null },
      ]);
    const recent = (await reader.recent(50)).filter((row) => row.epoch >= BASE && row.epoch < BASE + 100);
    expect(recent.map((row) => [row.epoch, row.threshold])).toEqual([
      [BASE + 2, 1_300],
      [BASE + 1, 1_250],
    ]);
    expect(await reader.byMarketId(live.marketId as string)).toMatchObject({ epoch: BASE + 2, threshold: 1_300 });
    const totals = await reader.totals(new Date());
    expect(totals.created).toBeGreaterThanOrEqual(2);
    expect(totals.live).toBeGreaterThanOrEqual(1);
    expect(totals.creationFeesPaidBase).toBeGreaterThanOrEqual(100_000_000);
  });

  it('reads the index history and the running epoch’s slot medians', async () => {
    const reads = new PgIndexReads(db);
    await db()
      .insert(epochIndex)
      .values([
        { epoch: BASE + 50, value: 1_200 },
        { epoch: BASE + 51, value: 1_300 },
      ]);
    const history = await reads.history(500);
    const ours = history.filter((row) => row.epoch >= BASE && row.epoch < BASE + 100);
    expect(ours).toEqual([
      { epoch: BASE + 51, value: 1_300 },
      { epoch: BASE + 50, value: 1_200 },
    ]);
    // slot_fees for a later epoch: the newest epoch there is the running one.
    const epoch = BASE + 99;
    await db()
      .insert(slotFees)
      .values(
        [100, 300, 200].map((medianCuPrice, i) => ({
          slot: epoch * 432_000 + i,
          epoch,
          leader: 'L',
          medianCuPrice,
          txCount: 1,
        })),
      );
    expect(await reads.running()).toEqual({ epoch, value: 200, slots: 3 });
  });
});
