import { type FeeIndexAccount, type IndexBallotAccount } from '@epoch/epoch-sdk';
import { epochIndex, type EpochDb, PostgresConnectionManager, runMigrations } from '@epoch/pg_models';
import { PublicKey } from '@solana/web3.js';
import { TransactionRollbackError } from 'drizzle-orm';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import {
  type ComputedIndexSource,
  FeeIndexService,
  type FeeIndexReader,
  PgComputedIndexSource,
} from './FeeIndexService';
import { MemoryEventStore } from './ProgramEventStore';

const WINDOW = 1_000;

/** A FeeIndex account: `finals` oldest → newest; the last one is the current value, the rest are history. */
function account(
  finals: [number, number][],
  proposal?: { epoch: number; value: number; slot: number },
  finalizedSlot = 500,
): FeeIndexAccount {
  const current = finals[finals.length - 1];
  const history = finals.slice(0, -1).map(([epoch, value]) => ({ epoch: BigInt(epoch), value: BigInt(value) }));
  return {
    pool: PublicKey.default,
    publisher: PublicKey.default,
    bump: 255,
    epoch: BigInt(current?.[0] ?? 0),
    value: BigInt(current?.[1] ?? 0),
    inputsHash: new Uint8Array(32),
    finalizedSlot: current ? BigInt(finalizedSlot) : 0n,
    hasProposal: proposal !== undefined,
    proposedEpoch: BigInt(proposal?.epoch ?? 0),
    proposedValue: BigInt(proposal?.value ?? 0),
    proposedInputsHash: new Uint8Array(32),
    proposedSlot: BigInt(proposal?.slot ?? 0),
    disputeWindowSlots: BigInt(WINDOW),
    maxMoveBps: 2_000,
    history: [...history, ...Array.from({ length: 16 - history.length }, () => ({ epoch: 0n, value: 0n }))],
    historyHead: history.length,
    historyCount: history.length,
  };
}

let sigs = 0;
const indexEvent = (
  name: StoredProgramEvent['name'],
  slot: number,
  epoch: number,
  value: number,
): StoredProgramEvent => ({
  signature: `sig${++sigs}`,
  ix: 0,
  slot,
  epoch: null,
  blockTime: null,
  name,
  data:
    name === 'IndexVetoed'
      ? { epoch: String(epoch), value: String(value) }
      : { epoch: String(epoch), value: String(value), slot: String(slot) },
});

/** An open IndexBallot: three operators of weight 1; `votes` are the values cast by the first operators. */
function ballotAccount(
  epoch: number,
  votes: number[],
  overrides: Partial<IndexBallotAccount> = {},
): IndexBallotAccount {
  const operators = [1, 2, 3].map((n) => new PublicKey(new Uint8Array(32).fill(60 + n)));
  return {
    feeIndex: PublicKey.default,
    epoch: BigInt(epoch),
    bump: 253,
    payer: operators[0],
    round: 0,
    openedSlot: 900n,
    thresholdBps: 6_667,
    toleranceBps: 100,
    totalWeight: 3n,
    operatorCount: 3,
    votesCast: votes.length,
    votes: Array.from({ length: 8 }, (_, i) => ({
      operator: i < 3 ? operators[i] : PublicKey.default,
      weight: i < 3 ? 1 : 0,
      voted: i < votes.length,
      value: BigInt(votes[i] ?? 0),
      inputsHash: new Uint8Array(32).fill(i < votes.length ? i + 1 : 0),
      slot: i < votes.length ? 901n + BigInt(i) : 0n,
      deviationBps: 0,
      agrees: i < votes.length,
      late: false,
    })),
    medianValue: BigInt(votes[0] ?? 0),
    agreeingWeight: BigInt(votes.length),
    consensusSlot: 0n,
    consensusValue: 0n,
    consensusInputsHash: new Uint8Array(32),
    proposedSlot: 0n,
    ...overrides,
  };
}

async function build(options: {
  account?: FeeIndexAccount | null | Error;
  events?: StoredProgramEvent[];
  computed?: [number, number][] | null;
  configured?: boolean;
  ballots?: IndexBallotAccount[];
}) {
  const events = new MemoryEventStore();
  await events.insert(options.events ?? []);
  const program: FeeIndexReader = {
    configured: options.configured ?? true,
    feeIndex: async () => {
      if (options.account instanceof Error) throw options.account;
      return options.account ? { address: 'fee-index', account: options.account } : null;
    },
    indexBallots: async () =>
      (options.ballots ?? []).map((ballot) => ({ address: `ballot-${ballot.epoch}`, account: ballot })),
  };
  const rows = options.computed === undefined ? [] : options.computed;
  const computed: ComputedIndexSource | null =
    rows === null
      ? null
      : {
          list: async ({ from, to, limit }) =>
            rows
              .filter(([epoch]) => (from === undefined || epoch >= from) && (to === undefined || epoch <= to))
              .sort((a, b) => b[0] - a[0])
              .slice(0, limit)
              .map(([epoch, value]) => ({ epoch, value })),
        };
  return new FeeIndexService({ program, events, computed });
}

describe('FeeIndexService', () => {
  it('keeps a vetoed proposal visible until a new one is posted for its epoch', async () => {
    const vetoed = await build({
      account: account([[1042, 1284]]),
      events: [indexEvent('IndexProposed', 600, 1043, 1500), indexEvent('IndexVetoed', 700, 1043, 1500)],
    });
    expect(await vetoed.points({ limit: 5 })).toEqual([
      { epoch: 1043, value: 1500, status: 'vetoed' },
      { epoch: 1042, value: 1284, status: 'final' },
    ]);
    expect((await vetoed.latest()).proposed).toBeNull();

    const reproposed = await build({
      account: account([[1042, 1284]], { epoch: 1043, value: 1330, slot: 800 }),
      events: [
        indexEvent('IndexProposed', 600, 1043, 1500),
        indexEvent('IndexVetoed', 700, 1043, 1500),
        indexEvent('IndexProposed', 800, 1043, 1330),
      ],
    });
    expect(await reproposed.points({ limit: 1 })).toEqual([{ epoch: 1043, value: 1330, status: 'proposed' }]);
    expect((await reproposed.latest()).proposed).toEqual({ epoch: 1043, value: 1330, disputeEndsSlot: 800 + WINDOW });
  });

  it('shows an epoch still voting (median, then the queued agreed value); the stream carries its ballot', async () => {
    const voting = await build({ account: account([[1042, 1284]]), ballots: [ballotAccount(1043, [1300])] });
    expect(await voting.points({ limit: 2 })).toEqual([
      { epoch: 1043, value: 1300, status: 'voting' },
      { epoch: 1042, value: 1284, status: 'final' },
    ]);
    const { ballot } = await voting.stream();
    expect(ballot).toMatchObject({
      address: 'ballot-1043',
      programEpoch: 1043,
      status: 'voting',
      votesCast: 1,
      agreeingWeight: 1,
      agreeingBps: 3334,
      thresholdBps: 6_667,
      consensus: false,
      source: 'account',
    });
    expect(ballot?.votes.map((v) => v.voted)).toEqual([true, false, false]);

    const queued = await build({
      account: account([[1042, 1284]]),
      ballots: [ballotAccount(1043, [1300, 1302], { consensusSlot: 950n, consensusValue: 1300n })],
    });
    expect((await queued.points({ limit: 1 }))[0]).toEqual({ epoch: 1043, value: 1300, status: 'voting' });
    expect((await queued.stream()).ballot).toMatchObject({ status: 'queued', consensus: true, agreeingBps: 6667 });
  });

  it('a ballot reopened after a veto replaces the vetoed point; proposed, final and settled ballots do not', async () => {
    const events = [indexEvent('IndexProposed', 600, 1043, 1500), indexEvent('IndexVetoed', 700, 1043, 1500)];
    const reopened = await build({
      account: account([[1042, 1284]]),
      events,
      ballots: [ballotAccount(1043, [1310], { round: 1, openedSlot: 750n })],
    });
    expect((await reopened.points({ limit: 1 }))[0]).toEqual({ epoch: 1043, value: 1310, status: 'voting' });

    const notYet = await build({
      account: account([[1042, 1284]]),
      events,
      ballots: [ballotAccount(1043, [1500, 1500], { consensusSlot: 590n, consensusValue: 1500n, proposedSlot: 600n })],
    });
    expect((await notYet.points({ limit: 1 }))[0]).toEqual({ epoch: 1043, value: 1500, status: 'vetoed' });
    expect((await notYet.stream()).ballot).toMatchObject({ status: 'vetoed' });

    const proposed = await build({
      account: account([[1042, 1284]], { epoch: 1043, value: 1330, slot: 800 }),
      ballots: [ballotAccount(1043, [1330, 1331], { consensusSlot: 800n, consensusValue: 1330n, proposedSlot: 800n })],
    });
    expect((await proposed.points({ limit: 1 }))[0]).toEqual({ epoch: 1043, value: 1330, status: 'proposed' });

    const settled = await build({ account: account([[1042, 1284]]), ballots: [ballotAccount(1042, [1284])] });
    expect((await settled.points({ limit: 1 }))[0]).toEqual({ epoch: 1042, value: 1284, status: 'final' });
    expect((await settled.stream()).ballot).toBeNull();
  });

  it('trusts a veto newer than the proposal a cached account read still shows', async () => {
    const service = await build({
      account: account([[1042, 1284]], { epoch: 1043, value: 1330, slot: 800 }),
      events: [indexEvent('IndexProposed', 800, 1043, 1330), indexEvent('IndexVetoed', 810, 1043, 1330)],
    });
    expect((await service.points({ limit: 1 }))[0]).toEqual({ epoch: 1043, value: 1330, status: 'vetoed' });
  });

  it('marks the account value and its history final, and final is never replaced', async () => {
    const service = await build({
      account: account([
        [1040, 1190],
        [1041, 1250],
        [1042, 1284],
      ]),
      // A stale proposal event for an epoch the account has since finalized (with another value).
      events: [indexEvent('IndexProposed', 300, 1041, 1249), indexEvent('IndexFinalized', 400, 1039, 1260)],
    });
    expect(await service.points({ limit: 10 })).toEqual([
      { epoch: 1042, value: 1284, status: 'final' },
      { epoch: 1041, value: 1250, status: 'final' },
      { epoch: 1040, value: 1190, status: 'final' },
      // Older than the account's 16-epoch history: from its IndexFinalized event.
      { epoch: 1039, value: 1260, status: 'final' },
    ]);
  });

  it('lets program values win over computed ones; computed-only epochs carry no status', async () => {
    const service = await build({
      account: account([[1042, 1284]], { epoch: 1043, value: 1330, slot: 900 }),
      computed: [
        [1044, 1301],
        [1043, 1329],
        [1042, 1283],
        [1041, 1251],
      ],
    });
    const points = await service.points({ limit: 10 });
    expect(points).toEqual([
      { epoch: 1044, value: 1301 },
      { epoch: 1043, value: 1330, status: 'proposed' },
      { epoch: 1042, value: 1284, status: 'final' },
      { epoch: 1041, value: 1251 },
    ]);
    expect('status' in points[0]).toBe(false);
  });

  it('applies from, to and limit after the merge, newest first', async () => {
    const service = await build({
      account: account([
        [1040, 1190],
        [1041, 1250],
      ]),
      computed: [
        [1039, 1260],
        [1038, 1310],
        [1037, 1230],
      ],
    });
    expect((await service.points({ from: 1038, to: 1040, limit: 50 })).map((p) => p.epoch)).toEqual([1040, 1039, 1038]);
    expect((await service.points({ limit: 2 })).map((p) => p.epoch)).toEqual([1041, 1040]);
  });

  it('summarizes the last final value, the pending proposal and the 8-epoch average', async () => {
    const finals: [number, number][] = [
      [1033, 9999], // the 9th newest: outside the average
      [1034, 1170],
      [1035, 1230],
      [1036, 1310],
      [1037, 1260],
      [1038, 1190],
      [1039, 1250],
      [1040, 1300],
      [1041, 1284],
    ];
    const service = await build({ account: account(finals, { epoch: 1042, value: 1330, slot: 5_000 }) });
    expect(await service.latest()).toEqual({
      final: { epoch: 1041, value: 1284 },
      proposed: { epoch: 1042, value: 1330, disputeEndsSlot: 6_000 },
      avg8: Math.round((1170 + 1230 + 1310 + 1260 + 1190 + 1250 + 1300 + 1284) / 8),
    });
    const stream = await service.stream();
    expect(stream.points).toHaveLength(10);
    expect(stream.points[0]).toEqual({ epoch: 1042, value: 1330, status: 'proposed' });
    expect(stream.avg8).toBe(1249);
  });

  it('falls back to the stored events when the account cannot be read', async () => {
    const service = await build({
      account: new Error('RPC down'),
      events: [indexEvent('IndexFinalized', 400, 1042, 1284), indexEvent('IndexProposed', 500, 1043, 1330)],
    });
    expect(await service.points({ limit: 5 })).toEqual([
      { epoch: 1043, value: 1330, status: 'proposed' },
      { epoch: 1042, value: 1284, status: 'final' },
    ]);
    // Without the account the dispute window is unknown.
    expect((await service.latest()).proposed).toEqual({ epoch: 1043, value: 1330, disputeEndsSlot: null });
  });

  it('works before initialize_index and without the program', async () => {
    expect(await (await build({ account: null })).points({ limit: 5 })).toEqual([]);
    const dbOnly = await build({ configured: false, computed: [[1041, 1251]] });
    expect(await dbOnly.points({ limit: 5 })).toEqual([{ epoch: 1041, value: 1251 }]);
    expect(await dbOnly.latest()).toEqual({ final: null, proposed: null, avg8: null });
  });

  it('answers 503 PROGRAM_NOT_CONFIGURED without the program and the database', async () => {
    const service = await build({ configured: false, computed: null });
    expect(service.available).toBe(false);
    await expect(service.points({ limit: 5 })).rejects.toMatchObject({
      code: 'PROGRAM_NOT_CONFIGURED',
      statusCode: 503,
    });
    await expect(service.latest()).rejects.toMatchObject({ code: 'PROGRAM_NOT_CONFIGURED' });
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('PgComputedIndexSource (TEST_DATABASE_URL)', () => {
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

  it('reads epoch_index newest first within the range', () =>
    inRollback(async (db) => {
      await db.delete(epochIndex);
      await db.insert(epochIndex).values([
        { epoch: 1040, value: 1190 },
        { epoch: 1041, value: 1250 },
        { epoch: 1042, value: 1284 },
      ]);
      const source = new PgComputedIndexSource(db);
      expect(await source.list({ limit: 2 })).toEqual([
        { epoch: 1042, value: 1284 },
        { epoch: 1041, value: 1250 },
      ]);
      expect(await source.list({ from: 1040, to: 1041, limit: 50 })).toEqual([
        { epoch: 1041, value: 1250 },
        { epoch: 1040, value: 1190 },
      ]);
    }));
});
