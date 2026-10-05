import { EventEmitter } from 'events';

import { Client } from 'pg';

import { decodeLivePayload, encodeLivePayload, LIVE_NOTIFY_CHANNEL, type LiveSlotPayload } from './LiveFeed';
import { type ListenClient, PgListener } from './PgListener';

const TEST_DB = process.env.TEST_DATABASE_URL;

class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect = false) {
    super();
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error('ECONNREFUSED');
  }
  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    return {};
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

const SLOT: LiveSlotPayload = {
  t: 'slot',
  slot: 452_937_393,
  epoch: 1048,
  leader: '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS',
  medianCuPrice: 10_000,
  p25CuPrice: 870,
  p75CuPrice: 312_500,
  p90CuPrice: 1_134_380,
  pricedTxs: 132,
  unpricedTxs: 101,
  leaderPaidTxs: 0,
  failedTxs: 31,
  blockTime: 1_791_031_700,
  source: 'grpc',
};

describe('LiveFeed payloads', () => {
  it('round-trips and stays far below the 8,000-byte NOTIFY limit', () => {
    const text = encodeLivePayload(SLOT);
    expect(Buffer.byteLength(text)).toBeLessThan(400);
    expect(decodeLivePayload(text)).toEqual(SLOT);
  });

  it('rejects anything that is not one of ours', () => {
    expect(decodeLivePayload(undefined)).toBeNull();
    expect(decodeLivePayload('not json')).toBeNull();
    expect(decodeLivePayload('{"t":"slot","slot":"1"}')).toBeNull();
    expect(decodeLivePayload('{"t":"other"}')).toBeNull();
    expect(decodeLivePayload('{"t":"epoch","epoch":1047,"value":9000}')).toEqual({
      t: 'epoch',
      epoch: 1047,
      value: 9000,
    });
  });

  it('refuses an oversized payload instead of letting Postgres fail the transaction', () => {
    expect(() => encodeLivePayload({ ...SLOT, leader: 'x'.repeat(9_000) })).toThrow(RangeError);
  });
});

describe('PgListener', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('LISTENs, forwards notifications for its channel and reconnects with backoff when the connection drops', async () => {
    const clients: FakeClient[] = [];
    const received: (string | undefined)[] = [];
    const states: boolean[] = [];
    const listener = new PgListener({
      channel: LIVE_NOTIFY_CHANNEL,
      onNotification: (payload) => received.push(payload),
      onState: (listening) => states.push(listening),
      createClient: () => {
        const client = new FakeClient(clients.length === 1);
        clients.push(client);
        return client;
      },
    });
    listener.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(clients[0].queries).toEqual(['LISTEN epoch_live']);
    expect(listener.isListening).toBe(true);

    clients[0].emit('notification', { channel: 'epoch_live', payload: 'a' });
    clients[0].emit('notification', { channel: 'other', payload: 'b' });
    expect(received).toEqual(['a']);

    clients[0].emit('error', new Error('terminating connection'));
    expect(listener.isListening).toBe(false);
    expect(clients[0].ended).toBe(true);
    // Second client fails to connect (1 s backoff), the third succeeds (2 s backoff).
    await jest.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(3);
    expect(listener.isListening).toBe(true);
    expect(states).toEqual([true, false, true]);

    await listener.stop();
    expect(clients[2].ended).toBe(true);
    expect(states).toEqual([true, false, true, false]);
  });

  it('rejects a channel name that would need quoting', () => {
    expect(() => new PgListener({ channel: 'epoch-live; DROP', onNotification: () => undefined })).toThrow();
  });
});

(TEST_DB ? describe : describe.skip)('PgListener against Postgres (TEST_DATABASE_URL)', () => {
  it('receives a pg_notify sent from another connection', async () => {
    const received: string[] = [];
    const listener = new PgListener({
      channel: LIVE_NOTIFY_CHANNEL,
      connectionString: TEST_DB,
      onNotification: (payload) => received.push(payload ?? ''),
    });
    const ready = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (listener.isListening) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    listener.start();
    await ready;
    const sender = new Client({ connectionString: TEST_DB });
    await sender.connect();
    try {
      await sender.query('SELECT pg_notify($1, $2)', [LIVE_NOTIFY_CHANNEL, encodeLivePayload(SLOT)]);
      const heard = () => received.map(decodeLivePayload).filter((p) => p?.t === 'slot' && p.slot === SLOT.slot);
      for (let i = 0; i < 100 && heard().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      // Other test files may notify on the same channel at the same time.
      expect(heard()).toEqual([SLOT]);
    } finally {
      await sender.end();
      await listener.stop();
    }
  });
});
