import { readFileSync } from 'fs';
import { join } from 'path';

import { type EpochDb, PostgresConnectionManager, runMigrations } from '@epoch/pg_models';
import { PublicKey } from '@solana/web3.js';
import { TransactionRollbackError } from 'drizzle-orm';

import { FakeGrpc, fixtureUpdate, YELLOWSTONE_PROGRAM } from '../../__fixtures__/YellowstoneFakes';
import { EventBus, type StoredProgramEvent } from '../../Lib/EventBus';
import {
  type IngestRpc,
  isRateLimited,
  type LogsListener,
  RpcAnswerError,
  type SignatureInfo,
  type TransactionLogs,
} from '../../Sources/ProgramLogsSource';
import { SolamiStream } from '../../Sources/SolamiStream';
import { cursorName, ProgramEventIngester, type ProgramEventIngesterOptions } from './ProgramEventIngester';
import { MemoryEventStore, PgEventStore } from './ProgramEventStore';

const PROGRAM = new PublicKey(new Uint8Array(32).fill(9));
const OTHER = new PublicKey(new Uint8Array(32).fill(5));
const T0 = Date.UTC(2026, 9, 3, 0, 0, 0);

// Real event bytes: `Event::data` written by the program crate (packages/epoch-sdk/src/__fixtures__/rust-vectors.json).
const VECTORS = new Map(
  (
    JSON.parse(readFileSync(join(__dirname, '../../../../epoch-sdk/src/__fixtures__/rust-vectors.json'), 'utf8')) as {
      events: { name: string; label: string; data: string; fields: Record<string, unknown> }[];
    }
  ).events.map((v) => [`${v.name}:${v.label}`, v]),
);
const vector = (name: string, label = 'a') => {
  const found = VECTORS.get(`${name}:${label}`);
  if (!found) throw new Error(`no vector ${name}:${label}`);
  return found;
};
/** A `Program data:` payload, as Anchor's emit! logs it. */
const data = (name: string, label = 'a') => Buffer.from(vector(name, label).data, 'hex').toString('base64');

/** Logs of one top-level Epoch instruction that emitted `payloads`. */
const epochLogs = (...payloads: string[]) => [
  `Program ${PROGRAM.toBase58()} invoke [1]`,
  'Program log: Instruction: Sweep',
  ...payloads.map((payload) => `Program data: ${payload}`),
  `Program ${PROGRAM.toBase58()} consumed 21000 of 200000 compute units`,
  `Program ${PROGRAM.toBase58()} success`,
];
/** Another program writing its own `Program data:` line in the same transaction. */
const otherLogs = (payload: string) => [
  `Program ${OTHER.toBase58()} invoke [1]`,
  `Program data: ${payload}`,
  `Program ${OTHER.toBase58()} success`,
];

interface FakeTx {
  signature: string;
  slot: number;
  /** Unix seconds. */
  blockTime: number;
  err?: unknown;
  logs: string[];
}

const tx = (n: number, logs: string[], extra: Partial<FakeTx> = {}): FakeTx => ({
  signature: `sig${n}`,
  slot: 1_000 + n,
  blockTime: T0 / 1_000 + n,
  logs,
  ...extra,
});

/** The program's transactions (oldest first) behind getSignaturesForAddress / getTransaction / logsSubscribe. */
class FakeRpc implements IngestRpc {
  chain: FakeTx[] = [];
  readonly listeners = new Map<number, LogsListener>();
  readonly signatureCalls: { before?: string; until?: string; limit: number }[] = [];
  readonly transactionCalls: string[] = [];
  readonly signatureFailures: Error[] = [];
  readonly transactionFailures: Error[] = [];
  readonly missing = new Set<string>();
  /** getTransaction answers a JSON-RPC error for these. */
  readonly answerErrors = new Set<string>();
  readonly removed: number[] = [];
  reconnects = 0;
  private nextId = 1;

  async getSignaturesForAddress(
    _address: PublicKey,
    options: { before?: string; until?: string; limit: number },
  ): Promise<SignatureInfo[]> {
    this.signatureCalls.push(options);
    const failure = this.signatureFailures.shift();
    if (failure) throw failure;
    const newestFirst = [...this.chain].reverse();
    const start = options.before ? newestFirst.findIndex((t) => t.signature === options.before) + 1 : 0;
    const out: SignatureInfo[] = [];
    for (const t of newestFirst.slice(start)) {
      if (t.signature === options.until || out.length >= options.limit) break;
      out.push({ signature: t.signature, slot: t.slot, err: t.err ?? null, blockTime: t.blockTime });
    }
    return out;
  }

  async getTransaction(signature: string): Promise<TransactionLogs | null> {
    this.transactionCalls.push(signature);
    const failure = this.transactionFailures.shift();
    if (failure) throw failure;
    if (this.answerErrors.has(signature)) {
      throw new RpcAnswerError(-32015, 'Transaction version (2) is not supported by the requesting client.');
    }
    const found = this.chain.find((t) => t.signature === signature);
    if (!found || this.missing.has(signature)) return null;
    return { slot: found.slot, blockTime: found.blockTime, meta: { err: found.err ?? null, logMessages: found.logs } };
  }

  onLogs(_address: PublicKey, listener: LogsListener): number {
    const id = this.nextId++;
    this.listeners.set(id, listener);
    return id;
  }

  async removeOnLogsListener(id: number): Promise<void> {
    this.removed.push(id);
    this.listeners.delete(id);
  }

  reconnect(): void {
    this.reconnects++;
  }

  /** The websocket delivers a transaction's logs. */
  deliver(t: FakeTx): void {
    for (const listener of this.listeners.values()) {
      listener({ signature: t.signature, err: t.err ?? null, logs: t.logs }, { slot: t.slot });
    }
  }
}

function build(rpc: FakeRpc, options: Partial<ProgramEventIngesterOptions> = {}) {
  const store = options.store ?? new MemoryEventStore();
  const bus = new EventBus();
  const emitted: StoredProgramEvent[] = [];
  bus.on('programEvent', (event) => emitted.push(event));
  const invalidated: string[] = [];
  const sleeps: number[] = [];
  const clock = { now: T0 + 60_000 };
  const ingester = new ProgramEventIngester({
    programId: PROGRAM,
    enabled: true,
    rpc,
    store,
    bus,
    epochOfSlot: async (slot) => Math.floor(slot / 1_000),
    invalidate: (name) => invalidated.push(name),
    backfillLimit: 100,
    pageSize: 2,
    pollIntervalMs: 3_600_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock.now,
    ...options,
  });
  return { ingester, store, bus, emitted, invalidated, sleeps, clock };
}

const ids = (events: readonly StoredProgramEvent[]) => events.map((e) => `${e.signature}:${e.ix}:${e.name}`);
const CURSOR = cursorName(PROGRAM);

describe('ProgramEventIngester', () => {
  it('backfills oldest first, skipping failed transactions and other programs’ data', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [
      tx(1, epochLogs(data('Deposited'))),
      tx(2, epochLogs(data('Swept')), { err: { InstructionError: [0, { Custom: 6000 }] } }),
      tx(3, [...otherLogs(data('Swept', 'b')), ...epochLogs(data('Swept'), data('IndexProposed'))]),
      tx(4, epochLogs()),
      tx(1_005, epochLogs(data('AdvanceOpened'))),
    ];
    const { ingester, store, emitted, invalidated } = build(rpc);

    // Five transactions read (the failed one and the one without events included), four events.
    expect(await ingester.catchUp()).toBe(5);
    expect(ids(emitted)).toEqual([
      'sig1:0:Deposited',
      'sig3:0:Swept',
      'sig3:1:IndexProposed',
      'sig1005:0:AdvanceOpened',
    ]);
    expect(invalidated).toEqual(['Deposited', 'Swept', 'IndexProposed', 'AdvanceOpened']);
    // The failed transaction is skipped from its signature entry, without a getTransaction call.
    expect(rpc.transactionCalls).toEqual(['sig1', 'sig3', 'sig4', 'sig1005']);
    // Pages of 2, newest first, back to the start of the program's history.
    expect(rpc.signatureCalls.map((c) => c.before ?? '-')).toEqual(['-', 'sig4', 'sig2']);

    const [deposit, sweep] = emitted;
    expect(deposit).toMatchObject({
      slot: 1_001,
      epoch: 1,
      blockTime: new Date(T0 + 1_000).toISOString(),
      data: { owner: vector('Deposited').fields.owner, tranche: 'junior', assets: vector('Deposited').fields.assets },
    });
    expect(sweep.data.remitted).toBe(vector('Swept').fields.remitted);
    expect(emitted[3]).toMatchObject({ slot: 2_005, epoch: 2 });
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 2_005, signature: 'sig1005' });
    expect(ids(await store.query({ order: 'asc' }))).toEqual(ids(emitted));
  });

  it('resumes from the cursor and reads only newer transactions', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [tx(1, epochLogs(data('Deposited'))), tx(2, epochLogs(data('Swept')))];
    const store = new MemoryEventStore();
    await build(rpc, { store }).ingester.catchUp();

    rpc.chain.push(tx(3, epochLogs(data('AdvanceRepaid'))), tx(4, epochLogs(data('Accrued'))));
    rpc.signatureCalls.length = 0;
    rpc.transactionCalls.length = 0;
    const restarted = build(rpc, { store });
    expect(await restarted.ingester.catchUp()).toBe(2);
    expect(rpc.signatureCalls[0]).toMatchObject({ until: 'sig2' });
    expect(rpc.transactionCalls).toEqual(['sig3', 'sig4']);
    expect(ids(restarted.emitted)).toEqual(['sig3:0:AdvanceRepaid', 'sig4:0:Accrued']);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_004, signature: 'sig4' });
    expect(await restarted.ingester.catchUp()).toBe(0);
  });

  it('reads at most backfillLimit transactions on a first start, then everything after the cursor', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [1, 2, 3, 4, 5].map((n) => tx(n, epochLogs(data('Deposited', n % 2 ? 'a' : 'b'))));
    const { ingester, emitted, store } = build(rpc, { backfillLimit: 3 });
    expect(await ingester.catchUp()).toBe(3);
    expect(ids(emitted)).toEqual(['sig3:0:Deposited', 'sig4:0:Deposited', 'sig5:0:Deposited']);

    rpc.chain.push(...[6, 7, 8, 9].map((n) => tx(n, epochLogs(data('Swept')))));
    expect(await ingester.catchUp()).toBe(4);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_009, signature: 'sig9' });
  });

  it('with backfillLimit 0 starts after the newest transaction', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [tx(1, epochLogs(data('Deposited'))), tx(2, epochLogs(data('Swept')))];
    const { ingester, emitted, store } = build(rpc, { backfillLimit: 0 });
    expect(await ingester.catchUp()).toBe(0);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_002, signature: 'sig2' });
    rpc.chain.push(tx(3, epochLogs(data('AdvanceRepaid'))));
    expect(await ingester.catchUp()).toBe(1);
    expect(ids(emitted)).toEqual(['sig3:0:AdvanceRepaid']);

    // A program without any transaction yet: everything that comes later is new.
    const empty = new FakeRpc();
    const fresh = build(empty, { backfillLimit: 0 });
    await fresh.ingester.catchUp();
    expect(await fresh.store.getCursor(CURSOR)).toEqual({ slot: 0, signature: null });
    empty.chain.push(tx(1, epochLogs(data('Deposited'))));
    expect(await fresh.ingester.catchUp()).toBe(1);
  });

  it('dedupes across backfill, live and poll, and never moves the cursor from live events', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [tx(1, epochLogs(data('Deposited')))];
    const { ingester, emitted, store, clock } = build(rpc);
    ingester.start();
    await ingester.idle();
    expect(rpc.listeners.size).toBe(1);
    expect(ids(emitted)).toEqual(['sig1:0:Deposited']);

    // Live: tx2 arrives over the websocket; failed and foreign-only transactions are ignored.
    const live = tx(2, epochLogs(data('Swept'), data('AdvanceRepaid')));
    clock.now = T0 + 90_000;
    rpc.deliver(live);
    rpc.deliver(tx(3, epochLogs(data('Swept')), { err: 'boom' }));
    rpc.deliver(tx(4, otherLogs(data('Deposited'))));
    await ingester.idle();
    expect(ids(emitted).slice(1)).toEqual(['sig2:0:Swept', 'sig2:1:AdvanceRepaid']);
    expect(emitted[1]).toMatchObject({ slot: 1_002, epoch: 1, blockTime: new Date(T0 + 90_000).toISOString() });
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_001, signature: 'sig1' });

    // Poll: tx2 (already delivered) is not read again; tx5 (missed by the websocket) is.
    rpc.chain.push(live, tx(5, epochLogs(data('WithdrawProcessed'))));
    rpc.transactionCalls.length = 0;
    expect(await ingester.catchUp()).toBe(2);
    expect(rpc.transactionCalls).toEqual(['sig5']);
    expect(ids(emitted).slice(3)).toEqual(['sig5:0:WithdrawProcessed']);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_005, signature: 'sig5' });

    // The websocket delivering tx5 late adds nothing.
    rpc.deliver(rpc.chain[2]);
    await ingester.idle();
    expect(emitted).toHaveLength(4);
    expect(await store.query()).toHaveLength(4);
    await ingester.stop();
  });

  it('backs off on HTTP 429 and gives up on errors that persist', async () => {
    expect(isRateLimited(new Error('429 Too Many Requests: {"jsonrpc":"2.0"}'))).toBe(true);
    expect(isRateLimited(new Error('fetch failed'))).toBe(false);

    const rpc = new FakeRpc();
    rpc.chain = [tx(1, epochLogs(data('Deposited')))];
    rpc.transactionFailures.push(new Error('429 Too Many Requests: slow down'), new Error('429 Too Many Requests'));
    const { ingester, sleeps, emitted, store } = build(rpc);
    expect(await ingester.catchUp()).toBe(1);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(emitted).toHaveLength(1);

    rpc.chain.push(tx(2, epochLogs(data('Swept'))));
    rpc.signatureFailures.push(new Error('fetch failed'), new Error('fetch failed'), new Error('fetch failed'));
    await expect(ingester.catchUp()).rejects.toThrow('fetch failed');
    expect(sleeps.slice(2)).toEqual([500, 1_000]);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_001, signature: 'sig1' });
    expect(await ingester.catchUp()).toBe(1);
  });

  it('waits for a transaction the RPC cannot return yet, and skips it after three passes', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [
      tx(1, epochLogs(data('Deposited'))),
      tx(2, epochLogs(data('Swept'))),
      tx(3, epochLogs(data('Accrued'))),
    ];
    rpc.missing.add('sig2');
    const { ingester, emitted, store } = build(rpc);

    expect(await ingester.catchUp()).toBe(1);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_001, signature: 'sig1' });
    expect(await ingester.catchUp()).toBe(0);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_001, signature: 'sig1' });
    expect(await ingester.catchUp()).toBe(2); // third pass: sig2 skipped, sig3 read
    expect(ids(emitted)).toEqual(['sig1:0:Deposited', 'sig3:0:Accrued']);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_003, signature: 'sig3' });

    // One that turns up on the next pass is read normally.
    rpc.chain.push(tx(4, epochLogs(data('AdvanceRepaid'))));
    rpc.missing.add('sig4');
    expect(await ingester.catchUp()).toBe(0);
    rpc.missing.delete('sig4');
    expect(await ingester.catchUp()).toBe(1);
    expect(ids(emitted).at(-1)).toBe('sig4:0:AdvanceRepaid');
  });

  it('never stalls on a transaction the node keeps answering an error about', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [
      tx(1, epochLogs(data('Deposited'))),
      tx(2, epochLogs(data('Swept'))),
      tx(3, epochLogs(data('Accrued'))),
    ];
    rpc.answerErrors.add('sig2');
    const { ingester, emitted, store, sleeps } = build(rpc, { concurrency: 1 });
    expect(await ingester.catchUp()).toBe(1);
    expect(await ingester.catchUp()).toBe(0);
    expect(await store.getCursor(CURSOR)).toEqual({ slot: 1_001, signature: 'sig1' });
    expect(await ingester.catchUp()).toBe(2);
    expect(ids(emitted)).toEqual(['sig1:0:Deposited', 'sig3:0:Accrued']);
    // An answer about the transaction is not retried within a pass: one call per pass.
    expect(rpc.transactionCalls.filter((s) => s === 'sig2')).toHaveLength(3);
    expect(sleeps).toEqual([]);
  });

  it('resubscribes when the poll finds transactions the websocket never delivered', async () => {
    const rpc = new FakeRpc();
    const { ingester, clock } = build(rpc);
    clock.now = T0;
    ingester.start();
    await ingester.idle();
    expect([...rpc.listeners.keys()]).toEqual([1]);

    // Landed 20 s after we subscribed; two minutes later only the poll has seen it.
    rpc.chain.push(tx(20, epochLogs(data('Deposited'))));
    clock.now = T0 + 120_000;
    expect(await ingester.catchUp()).toBe(1);
    expect(rpc.removed).toEqual([1]);
    expect(rpc.reconnects).toBe(1);
    expect([...rpc.listeners.keys()]).toEqual([2]);

    // Delivered live: no resubscription.
    const delivered = tx(200, epochLogs(data('Swept')));
    rpc.deliver(delivered);
    await ingester.idle();
    rpc.chain.push(delivered);
    clock.now = T0 + 400_000;
    await ingester.catchUp();
    expect(rpc.reconnects).toBe(1);

    await ingester.stop();
    expect(rpc.removed).toEqual([1, 2]);
    expect(ingester.started).toBe(false);
  });

  it('takes live events from Solami gRPC (Yellowstone fixtures), dedupes them, and falls back to logsSubscribe', async () => {
    // The fixture's program transactions, as the poll would list them later.
    const [swept, deposited] = [YELLOWSTONE_PROGRAM.updates[2], YELLOWSTONE_PROGRAM.updates[3]];
    const sweptSig = swept.signature as string;
    const depositedSig = deposited.signature as string;
    const rpc = new FakeRpc();
    let grpc: FakeGrpc | undefined;
    const stream = new SolamiStream({
      endpoint: { name: 'solami', url: 'https://grpc.solami.dev', token: 'not-a-real-key' },
      programId: PROGRAM.toBase58(),
      createStream: (_endpoints, options) => (grpc = new FakeGrpc(options)),
    });
    const { ingester, emitted, store, clock } = build(rpc, { stream, liveFallbackMs: 20 });
    clock.now = T0;
    ingester.start();
    await ingester.idle();
    const fake = grpc as FakeGrpc;
    expect(fake.request?.transactions.program.accountInclude).toEqual([PROGRAM.toBase58()]);

    // Streaming: no websocket; each update is parsed into events (another program's `Program data:` ignored).
    fake.status('streaming');
    expect(rpc.listeners.size).toBe(0);
    clock.now = T0 + 30_000;
    await fake.deliver(fixtureUpdate(2));
    await fake.deliver(fixtureUpdate(3));
    // A replayed copy (a reconnect) adds nothing.
    await fake.deliver(fixtureUpdate(2));
    await ingester.idle();
    expect(ids(emitted)).toEqual([`${sweptSig}:0:Swept`, `${sweptSig}:1:AdvanceRepaid`, `${depositedSig}:0:Deposited`]);
    expect(emitted[0]).toMatchObject({ slot: 453_600_001, blockTime: new Date(T0 + 30_000).toISOString() });

    // The poll lists both: neither is read again, and nothing is stored twice.
    rpc.chain = [
      { signature: sweptSig, slot: 453_600_001, blockTime: T0 / 1_000 + 29, logs: [] },
      { signature: depositedSig, slot: 453_600_002, blockTime: T0 / 1_000 + 29, logs: [] },
    ];
    await ingester.catchUp();
    expect(rpc.transactionCalls).toEqual([]);
    expect(await store.query()).toHaveLength(3);

    // Down for longer than liveFallbackMs: logsSubscribe takes over; back up: it is dropped again.
    fake.status('reconnecting');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect([...rpc.listeners.keys()]).toEqual([1]);
    fake.status('streaming');
    await ingester.idle();
    expect(rpc.removed).toEqual([1]);
    expect(rpc.listeners.size).toBe(0);

    // Refused for good (a revoked key): logsSubscribe at once.
    fake.refuse(new Error(`gRPC status: code: 'x', message: "api key revoked"`));
    await new Promise((resolve) => setImmediate(resolve));
    expect([...rpc.listeners.keys()]).toEqual([2]);
    expect(stream.state).toBe('failed');
    await ingester.stop();
    expect(rpc.removed).toEqual([1, 2]);
  });

  it('keeps ingesting when a bus listener throws', async () => {
    const rpc = new FakeRpc();
    rpc.chain = [tx(1, epochLogs(data('Deposited'), data('Swept')))];
    const { ingester, bus, emitted } = build(rpc);
    bus.on('programEvent', () => {
      throw new Error('listener bug');
    });
    expect(await ingester.catchUp()).toBe(1);
    expect(emitted).toHaveLength(2);
  });

  it('stays off when ingestion is disabled or the program is not configured', () => {
    const rpc = new FakeRpc();
    build(rpc, { enabled: false }).ingester.start();
    build(rpc, { programId: undefined }).ingester.start();
    expect(rpc.listeners.size).toBe(0);
    expect(rpc.signatureCalls).toHaveLength(0);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
(TEST_DB ? describe : describe.skip)('ProgramEventIngester on Postgres (TEST_DATABASE_URL)', () => {
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

  it('stores each event once across backfill, live and a restart, and keeps the cursor in indexer_cursors', () =>
    inRollback(async (db) => {
      const store = new PgEventStore(db);
      const rpc = new FakeRpc();
      rpc.chain = [
        tx(7_001, epochLogs(data('Deposited'), data('Swept'))),
        tx(7_002, epochLogs(data('IndexFinalized'))),
      ];
      const first = build(rpc, { store });
      expect(await first.ingester.catchUp()).toBe(2);

      const live = tx(7_003, epochLogs(data('SwapSettled')));
      first.ingester.start();
      await first.ingester.idle();
      rpc.deliver(live);
      await first.ingester.idle();
      await first.ingester.stop();
      expect(ids(first.emitted)).toEqual([
        'sig7001:0:Deposited',
        'sig7001:1:Swept',
        'sig7002:0:IndexFinalized',
        'sig7003:0:SwapSettled',
      ]);

      rpc.chain.push(live);
      const restarted = build(rpc, { store });
      expect(await restarted.ingester.catchUp()).toBe(1);
      expect(restarted.emitted).toEqual([]); // sig7003 was stored live: nothing new
      expect(await store.getCursor(CURSOR)).toEqual({ slot: 8_003, signature: 'sig7003' });
      const stored = await store.query({ order: 'asc' });
      expect(ids(stored)).toEqual(ids(first.emitted));
      // jsonb round trip: the i64 P&L stays a signed decimal string.
      expect(stored[3].data.takerPnl).toBe(vector('SwapSettled').fields.taker_pnl);
    }));
});
