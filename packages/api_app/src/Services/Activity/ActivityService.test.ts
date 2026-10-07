import { type EpochDb, PostgresConnectionManager, predictCalls, predictMarkets, runMigrations } from '@epoch/pg_models';
import { TransactionRollbackError } from 'drizzle-orm';

import { type PredictCallEvent, type StoredProgramEvent } from '../../Lib/EventBus';
import { MemoryEventStore } from '../Program/ProgramEventStore';
import { ActivityService } from './ActivityService';
import { PgPredictCallSource, type PredictCallSource } from './PredictCallSource';
import { EMPTY_NAMES, nameIndex } from './ValidatorNames';

const VOTE = 'FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk';
const IST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;

const event = (
  slot: number,
  ix: number,
  blockTime: string | null,
  name: StoredProgramEvent['name'],
  data: StoredProgramEvent['data'],
): StoredProgramEvent => ({ signature: `sig${slot}`, ix, slot, epoch: 9, blockTime, name, data });

const call = (id: number, createdAt: string, side: 'yes' | 'no' = 'yes'): PredictCallEvent => ({
  id,
  marketId: 'm1',
  label: 'Fee Index above 1,500 · epoch 1045',
  address: 'wallet',
  side,
  points: 25,
  createdAt,
});

async function build(options: { configured?: boolean; calls?: PredictCallEvent[] | null } = {}) {
  const events = new MemoryEventStore();
  await events.insert([
    event(10, 0, '2026-10-03T00:00:10.000Z', 'Deposited', { tranche: 'senior', assets: '25000000000' }),
    event(12, 0, '2026-10-03T00:00:30.000Z', 'Accrued', { epoch: '9' }), // not shown
    event(12, 1, '2026-10-03T00:00:30.000Z', 'Swept', { vote: VOTE, gross: '9', remitted: '10000000000' }),
    event(14, 0, null, 'IndexFinalized', { epoch: '1042', value: '1284', slot: '14' }), // no block time
    event(15, 0, '2026-10-03T00:00:50.000Z', 'WithdrawCancelled', { reason: 0, seq: '1' }), // not shown
  ]);
  const predict: PredictCallSource | null =
    options.calls === null ? null : { recent: async (limit) => (options.calls ?? []).slice(0, limit) };
  const names = jest.fn(async () => nameIndex([{ name: 'Kestrel Nodes', vote: VOTE, identity: 'id' }]));
  const service = new ActivityService({
    program: { configured: options.configured ?? true, cluster: 'devnet' },
    events,
    predict,
    names,
  });
  return { service, names };
}

describe('ActivityService', () => {
  it('merges program events and Predict calls, newest first', async () => {
    const { service } = await build({
      calls: [call(2, '2026-10-03T00:00:40.000Z', 'no'), call(1, '2026-10-03T00:00:20.000Z')],
    });
    const feed = await service.feed(50);
    expect(feed).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      source: 'Epoch program events (devnet) and Predict calls',
    });
    expect(feed.asOf).toMatch(IST);
    expect(feed.events.map((e) => [e.id, e.text])).toEqual([
      // No block time: it takes the time of the newer event before it in slot order (slot 15, 00:00:50, not shown).
      ['sig14:0', 'Epoch 1042 Fee Index final'],
      ['predict:2', 'Fee Index above 1,500 · epoch 1045 · NO'],
      ['sig12:1', 'Kestrel Nodes · repaid at source'],
      ['predict:1', 'Fee Index above 1,500 · epoch 1045 · YES'],
      ['sig10:0', 'Senior tranche · deposit'],
    ]);
    expect((await service.feed(2)).events.map((e) => e.id)).toEqual(['sig14:0', 'predict:2']);
  });

  it('serves Predict calls alone when the program is not configured', async () => {
    const { service } = await build({ configured: false, calls: [call(1, '2026-10-03T00:00:20.000Z')] });
    const feed = await service.feed(50);
    expect(feed.events.map((e) => e.id)).toEqual(['predict:1']);
    expect(feed.source).toBe('Predict calls (the Epoch program is not configured on this API)');
  });

  it('serves program events alone without a database', async () => {
    const { service } = await build({ calls: null });
    const feed = await service.feed(50);
    expect(feed.source).toBe('Epoch program events (devnet)');
    expect(feed.events).toHaveLength(3);
  });

  it('answers 503 PROGRAM_NOT_CONFIGURED without the program and the database', async () => {
    const { service } = await build({ configured: false, calls: null });
    expect(service.available).toBe(false);
    await expect(service.feed(50)).rejects.toMatchObject({ code: 'PROGRAM_NOT_CONFIGURED', statusCode: 503 });
  });

  it('maps one bus event for the websocket, without looking up names for events it does not show', async () => {
    const { service, names } = await build();
    expect(await service.fromProgramEvent(event(20, 0, null, 'Accrued', { epoch: '9' }))).toBeNull();
    expect(names).not.toHaveBeenCalled();
    expect(await service.fromProgramEvent(event(21, 0, null, 'AdvanceRepaid', { vote: VOTE }))).toMatchObject({
      id: 'sig21:0',
      text: 'Kestrel Nodes · advance repaid',
    });
    expect(service.fromPredictCall(call(5, '2026-10-03T00:00:00.000Z')).id).toBe('predict:5');
  });

  it('drops keeper repeats of vote copies and unchanged refreshes, in the feed and on the websocket', async () => {
    const events = new MemoryEventStore();
    const copy = (slot: number) => event(slot, 0, null, 'VoteAccountCopied', { vote: VOTE, epoch: '9' });
    const refresh = (slot: number, score: number) =>
      event(slot, 1, null, 'ScoreRefreshed', {
        vote: VOTE,
        score,
        delinquent: false,
        superminority: false,
        hedged: false,
      });
    // Three keeper passes in one epoch: the score changes on the third.
    const passes = [copy(30), refresh(30, 8_700), copy(40), refresh(40, 8_700), copy(50), refresh(50, 8_600)];
    await events.insert(passes);
    const service = new ActivityService({
      program: { configured: true, cluster: 'devnet' },
      events,
      predict: null,
      names: async () => nameIndex([{ name: 'Kestrel Nodes', vote: VOTE, identity: 'id' }]),
    });
    expect((await service.feed(50)).events.map((e) => [e.id, e.text])).toEqual([
      ['sig50:1', 'Kestrel Nodes · score 86 from on-chain history'],
      ['sig30:1', 'Kestrel Nodes · score 87 from on-chain history'],
      ['sig30:0', 'Kestrel Nodes · vote account copied on chain'],
    ]);
    const live = await Promise.all(passes.map((e) => service.fromProgramEvent(e)));
    expect(live.map((row) => row?.id ?? null)).toEqual(['sig30:0', 'sig30:1', null, null, null, 'sig50:1']);
  });

  it('names validators by short key when the name lookup has nothing', async () => {
    const service = new ActivityService({
      program: { configured: true, cluster: 'devnet' },
      events: new MemoryEventStore(),
      predict: null,
      names: async () => EMPTY_NAMES,
    });
    expect((await service.fromProgramEvent(event(1, 0, null, 'AdvanceRepaid', { vote: VOTE })))?.text).toBe(
      'FzUN…AmMk · advance repaid',
    );
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgPredictCallSource (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  /** Runs `test` in a snapshot transaction that is always rolled back: parallel test files never see its rows. */
  const inRollback = (test: (db: EpochDb) => Promise<void>) =>
    PostgresConnectionManager.getDb()
      .transaction(
        async (tx) => {
          await test(tx as unknown as EpochDb);
          tx.rollback();
        },
        { isolationLevel: 'repeatable read' },
      )
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

  it('reads the newest calls with their market label', () =>
    inRollback(async (db) => {
      await db.delete(predictCalls);
      await db.delete(predictMarkets);
      await db.insert(predictMarkets).values({
        id: 'fi-1045-1500',
        epoch: 1045,
        kind: 'above',
        threshold: 1500,
        question: 'Will epoch 1045 close above 1,500?',
        label: 'Fee Index above 1,500 · epoch 1045',
        status: 'open',
      });
      await db.insert(predictCalls).values([
        { marketId: 'fi-1045-1500', address: 'a', side: 'yes', points: 10, epoch: 1044, createdAt: new Date(1_000) },
        { marketId: 'fi-1045-1500', address: 'b', side: 'NO', points: 50, epoch: 1044, createdAt: new Date(3_000) },
        { marketId: 'gone', address: 'c', side: 'yes', points: 25, epoch: 1044, createdAt: new Date(2_000) },
      ]);
      const calls = await new PgPredictCallSource(db).recent(10);
      expect(calls.map((c) => [c.label, c.side, c.points, c.createdAt])).toEqual([
        ['Fee Index above 1,500 · epoch 1045', 'no', 50, new Date(3_000).toISOString()],
        ['gone', 'yes', 25, new Date(2_000).toISOString()],
        ['Fee Index above 1,500 · epoch 1045', 'yes', 10, new Date(1_000).toISOString()],
      ]);
      expect(await new PgPredictCallSource(db).recent(1)).toHaveLength(1);
    }));
});
