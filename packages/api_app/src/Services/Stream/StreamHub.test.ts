import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';

import { WebSocket, WebSocketServer } from 'ws';

import { EventBus, type PredictCallEvent, type StoredProgramEvent } from '../../Lib/EventBus';
import { predictCallToActivityEvent, toActivityEvent } from '../Activity/ActivityMapper';
import { EMPTY_NAMES, nameIndex } from '../Activity/ValidatorNames';
import { type SlotSource, StreamHub, type StreamHubOptions, VAULT_EVENTS } from './StreamHub';

const IST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;
const VOTE = 'FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/** A ws client that records every message and waits for the next one matching a predicate. */
class Client {
  readonly messages: Message[] = [];
  closed?: { code: number };
  private taken = new Set<number>();
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.messages.push(JSON.parse(raw.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
    ws.on('close', (code) => {
      this.closed = { code };
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static open(url: string, options: { origin?: string; autoPong?: boolean } = {}): Promise<Client> {
    const ws = new WebSocket(url, options);
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** The first message not taken yet that matches. */
  async next(match: (message: Message) => boolean = () => true, timeoutMs = 2_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.messages.findIndex((m, i) => !this.taken.has(i) && match(m));
      if (index >= 0) {
        this.taken.add(index);
        return this.messages[index];
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching message; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  frames(channel: string): Message[] {
    return this.messages.filter((m) => m.channel === channel);
  }

  async closedWithin(timeoutMs: number): Promise<{ code: number } | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await sleep(10);
    return this.closed;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const event = (name: StoredProgramEvent['name'], data: StoredProgramEvent['data'], blockTime?: string) =>
  ({
    signature: `sig-${name}`,
    ix: 0,
    slot: 1,
    epoch: 1,
    blockTime: blockTime ?? new Date().toISOString(),
    name,
    data,
  }) as StoredProgramEvent;

const call: PredictCallEvent = {
  id: 7,
  marketId: 'm',
  label: 'Fee Index above 1,500 · epoch 1045',
  address: 'wallet',
  side: 'yes',
  points: 50,
  createdAt: new Date().toISOString(),
};

/** Mainnet-like slots: one slot per read, leaders change every 4 slots. */
function fakeSlots(): SlotSource & { reads: () => number; leaderReads: () => number } {
  let slot = 375_840_000;
  let reads = 0;
  let leaderReads = 0;
  return {
    getEpochInfo: async () => {
      reads++;
      slot++;
      return { epoch: 870, slotIndex: slot - 375_840_000, slotsInEpoch: 432_000, absoluteSlot: slot };
    },
    getSlotLeaders: async (start, limit) => {
      leaderReads++;
      return Array.from({ length: limit }, (_, i) => `leader-${Math.floor((start + i) / 4)}`);
    },
    reads: () => reads,
    leaderReads: () => leaderReads,
  };
}

describe('StreamHub', () => {
  let server: Server;
  let hub: StreamHub;
  let bus: EventBus;
  let clients: Client[];
  let url: string;

  async function setup(options: Partial<StreamHubOptions> = {}): Promise<void> {
    bus = new EventBus();
    hub = new StreamHub({
      bus,
      corsOrigins: '*',
      slotIntervalMs: 20,
      activity: {
        fromProgramEvent: async (e) =>
          toActivityEvent(e, nameIndex([{ name: 'Kestrel Nodes', vote: VOTE, identity: 'id' }])),
        fromPredictCall: predictCallToActivityEvent,
      },
      ...options,
    });
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hub.attach(server);
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/stream`;
  }

  async function connect(query = '', options: { origin?: string; autoPong?: boolean } = {}): Promise<Client> {
    const client = await Client.open(`${url}${query}`, options);
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.ws.terminate();
    await hub.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('greets, subscribes from the URL, and pushes activity rows from the bus', async () => {
    await setup();
    const client = await connect('?channels=activity');
    expect(await client.next((m) => m.type === 'hello')).toEqual({ type: 'hello', channels: ['activity'] });
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({ type: 'subscribed', channels: ['activity'] });

    bus.emit('programEvent', event('Accrued', { epoch: '9' })); // not an activity row
    bus.emit('programEvent', event('Swept', { vote: VOTE, gross: '1', remitted: '10000000000' }));
    bus.emit('predictCall', call);
    const sweep = await client.next((m) => m.channel === 'activity');
    expect(sweep).toEqual({
      channel: 'activity',
      data: {
        id: 'sig-Swept:0',
        kind: 'sweep',
        text: 'Kestrel Nodes · repaid at source',
        amountSol: 10,
        value: null,
        unit: 'SOL',
        signature: 'sig-Swept',
      },
      at: expect.stringMatching(IST),
    });
    expect((await client.next((m) => m.channel === 'activity')).data).toMatchObject({
      id: 'predict:7',
      unit: 'points',
      text: 'Fee Index above 1,500 · epoch 1045 · YES',
    });
    expect(client.frames('activity')).toHaveLength(2);
  });

  it('keeps old events (a backfill after downtime) out of the live channel', async () => {
    await setup();
    const client = await connect('?channels=activity');
    await client.next((m) => m.type === 'subscribed');
    bus.emit('programEvent', event('Deposited', { tranche: 'senior', assets: '1' }, '2020-01-01T00:00:00.000Z'));
    bus.emit('programEvent', event('Deposited', { tranche: 'junior', assets: '2000000000' }));
    expect((await client.next((m) => m.channel === 'activity')).data.text).toBe('Junior tranche · deposit');
  });

  it('unsubscribes, answers pings and reports bad messages', async () => {
    await setup();
    const client = await connect();
    await client.next((m) => m.type === 'hello');
    client.send({ op: 'subscribe', channels: ['nope', 'activity'] });
    expect(await client.next((m) => m.type === 'error')).toEqual({
      type: 'error',
      message: 'Unknown or unavailable channel: nope (available: activity)',
    });
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({ type: 'subscribed', channels: ['activity'] });

    client.send({ op: 'unsubscribe', channels: ['activity'] });
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({ type: 'subscribed', channels: [] });
    bus.emit('predictCall', call);

    client.send('not json');
    expect((await client.next((m) => m.type === 'error')).message).toMatch(/must be JSON/);
    client.send({ op: 'dance' });
    expect((await client.next((m) => m.type === 'error')).message).toMatch(/Unknown message/);
    client.send({ op: 'ping' });
    expect(await client.next((m) => m.type === 'pong')).toEqual({ type: 'pong' });
    expect(client.frames('activity')).toHaveLength(0);
  });

  it('closes a socket that floods messages or sends one over the size cap', async () => {
    await setup({ maxPayloadBytes: 256 });
    const flooder = await connect();
    for (let i = 0; i < 60; i++) flooder.send({ op: 'ping' });
    expect(await flooder.closedWithin(1_000)).toEqual({ code: 1008 });

    const big = await connect();
    big.send({ op: 'subscribe', channels: ['x'.repeat(300)] });
    expect(await big.closedWithin(1_000)).toEqual({ code: 1009 });
  });

  it('checks the Origin against API_CORS_ORIGINS', async () => {
    await setup({ corsOrigins: 'http://localhost:3000, https://epoch.example' });
    await expect(connect('', { origin: 'https://evil.example' })).rejects.toThrow(/403/);
    const allowed = await connect('', { origin: 'https://epoch.example' });
    expect((await allowed.next()).type).toBe('hello');
    // Not a browser (no Origin header): allowed.
    expect((await (await connect()).next()).type).toBe('hello');
    expect(hub.clientCount).toBe(2);
  });

  it('leaves upgrades on other paths to their own handlers', async () => {
    await setup();
    const other = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/other')
        other.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ other: true })));
    });
    const client = await Client.open(url.replace('/v1/stream', '/other'));
    clients.push(client);
    expect(await client.next()).toEqual({ other: true });
    expect(hub.clientCount).toBe(0);
    other.close();
  });

  it('polls the slot only while someone subscribes, with the leader and its name', async () => {
    const slots = fakeSlots();
    await setup({
      slots,
      names: async () => nameIndex([{ name: 'Leader Validator', vote: 'v', identity: 'leader-93960000' }]),
    });
    const client = await connect();
    expect((await client.next((m) => m.type === 'hello')).channels).toEqual(['slot', 'activity']);
    await sleep(80);
    expect(slots.reads()).toBe(0);

    client.send({ op: 'subscribe', channels: ['slot'] });
    const first = await client.next((m) => m.channel === 'slot');
    expect(first).toEqual({
      channel: 'slot',
      data: {
        slot: 375_840_001,
        epoch: 870,
        slotIndex: 1,
        slotsInEpoch: 432_000,
        leader: 'leader-93960000',
        leaderName: 'Leader Validator',
        source: 'rpc',
      },
      at: expect.stringMatching(IST),
    });
    const later = await client.next((m) => m.channel === 'slot' && m.data.slot >= 375_840_004);
    expect(later.data).toMatchObject({ leader: 'leader-93960001', leaderName: null });
    // One leader read covers 100 slots.
    expect(slots.leaderReads()).toBe(1);

    // A second subscriber gets the last slot right away.
    const second = await connect('?channels=slot');
    expect((await second.next((m) => m.channel === 'slot')).data.slot).toBeGreaterThan(375_840_000);

    client.send({ op: 'unsubscribe', channels: ['slot'] });
    second.ws.close();
    await client.next((m) => m.type === 'subscribed' && m.channels.length === 0);
    await sleep(60);
    const reads = slots.reads();
    await sleep(100);
    expect(slots.reads()).toBe(reads);
  });

  it('follows Solami’s pushed slots while they flow, and polls again when they stop', async () => {
    const slots = fakeSlots();
    let push: ((slot: number) => void) | undefined;
    let feedSubscriptions = 0;
    await setup({
      slots,
      slotFeed: {
        onSlot: (listener) => {
          feedSubscriptions++;
          push = listener;
          return () => (push = undefined);
        },
      },
      slotFeedQuietMs: 150,
      names: async () => nameIndex([{ name: 'Leader Validator', vote: 'v', identity: 'leader-93960002' }]),
    });
    const client = await connect('?channels=slot');
    // The first frame comes from a poll (it also reads the epoch info that places pushed slots).
    const polled = await client.next((m) => m.channel === 'slot');
    expect(polled.data).toMatchObject({ slot: 375_840_001, source: 'rpc' });
    expect(feedSubscriptions).toBe(1);

    // Pushed slots go out as they arrive, placed in the epoch and named; the poll stands by.
    push?.(375_840_010);
    const pushed = await client.next((m) => m.channel === 'slot' && m.data.source === 'grpc');
    expect(pushed.data).toEqual({
      slot: 375_840_010,
      epoch: 870,
      slotIndex: 10,
      slotsInEpoch: 432_000,
      leader: 'leader-93960002',
      leaderName: 'Leader Validator',
      source: 'grpc',
    });
    const reads = slots.reads();
    for (let slot = 375_840_011; slot <= 375_840_015; slot++) {
      push?.(slot);
      await sleep(15);
    }
    // An older slot (a late push) never sends the channel backwards.
    push?.(375_840_012);
    await client.next((m) => m.channel === 'slot' && m.data.slot === 375_840_015);
    expect(slots.reads()).toBe(reads);
    expect(client.frames('slot').map((f) => f.data.slot)).toEqual([
      375_840_001, 375_840_010, 375_840_011, 375_840_012, 375_840_013, 375_840_014, 375_840_015,
    ]);

    // A slot past the epoch's end belongs to the next epoch.
    push?.(375_840_000 + 432_000 + 3);
    const next = await client.next((m) => m.channel === 'slot' && m.data.epoch === 871);
    expect(next.data).toMatchObject({ slotIndex: 3, source: 'grpc' });

    // The feed goes quiet: polling resumes.
    await sleep(250);
    expect(slots.reads()).toBeGreaterThan(reads);
  });

  it('pushes vault and feeIndex on subscribe and after the events that change them', async () => {
    let vaultVersion = 0;
    let feeIndexVersion = 0;
    const vault = jest.fn(async () => ({ tvlSol: 100 + vaultVersion++ }));
    const feeIndex = jest.fn(async () => ({ final: { epoch: 1042, value: 1284 + feeIndexVersion++ } }));
    await setup({ providers: { vault, feeIndex }, vaultDebounceMs: 30, feeIndexDebounceMs: 10 });

    const client = await connect('?channels=vault,feeIndex');
    expect((await client.next((m) => m.type === 'hello')).channels).toEqual(['activity', 'vault', 'feeIndex']);
    expect((await client.next((m) => m.channel === 'vault')).data).toEqual({ tvlSol: 100 });
    expect((await client.next((m) => m.channel === 'feeIndex')).data).toEqual({ final: { epoch: 1042, value: 1284 } });

    // A second subscriber is served from the cached value: no event changed it.
    const second = await connect('?channels=vault');
    expect((await second.next((m) => m.channel === 'vault')).data).toEqual({ tvlSol: 100 });
    expect(vault).toHaveBeenCalledTimes(1);

    // Three pool events in a burst → one push after the quiet time.
    bus.emit('programEvent', event('Deposited', { tranche: 'senior', assets: '1' }));
    bus.emit('programEvent', event('Swept', { vote: VOTE, remitted: '0', gross: '1' }));
    bus.emit('programEvent', event('ScoreUpdated', { vote: VOTE, score: 50 })); // not a pool change
    bus.emit('programEvent', event('WithdrawProcessed', { tranche: 'junior', assets: '1' }));
    expect((await client.next((m) => m.channel === 'vault')).data).toEqual({ tvlSol: 101 });
    expect((await second.next((m) => m.channel === 'vault')).data).toEqual({ tvlSol: 101 });
    expect(vault).toHaveBeenCalledTimes(2);

    bus.emit('programEvent', event('IndexFinalized', { epoch: '1043', value: '1330', slot: '1' }));
    bus.emit('programEvent', event('IndexProposed', { epoch: '1044', value: '1301', slot: '1' }));
    expect((await client.next((m) => m.channel === 'feeIndex')).data.final.value).toBe(1285);
    expect(feeIndex).toHaveBeenCalledTimes(2);
    await sleep(80);
    expect(client.frames('vault')).toHaveLength(2);
  });

  it('counts a treasury claim as a pool change (it adds to cash and income)', () => {
    expect(VAULT_EVENTS.has('TreasuryClaimed')).toBe(true);
  });

  it('reports a provider error to the subscriber', async () => {
    await setup({
      providers: {
        vault: async () => {
          throw new Error("The Epoch program isn't deployed on this API yet: set EPOCH_PROGRAM_ID");
        },
      },
    });
    const client = await connect('?channels=vault');
    expect(await client.next((m) => m.type === 'error')).toEqual({
      type: 'error',
      channel: 'vault',
      message: "The Epoch program isn't deployed on this API yet: set EPOCH_PROGRAM_ID",
    });
    // A provider set later (the VaultService) makes it work without a restart.
    hub.setProvider('vault', async () => ({ tvlSol: 5 }));
    client.send({ op: 'unsubscribe', channels: ['vault'] });
    client.send({ op: 'subscribe', channels: ['vault'] });
    expect((await client.next((m) => m.channel === 'vault')).data).toEqual({ tvlSol: 5 });
  });

  it('terminates sockets that miss a pong and closes everything on close()', async () => {
    await setup({ heartbeatMs: 40, slots: fakeSlots(), names: async () => EMPTY_NAMES });
    const silent = await connect('', { autoPong: false });
    const healthy = await connect();
    expect(await silent.closedWithin(1_000)).toBeDefined();
    expect(healthy.closed).toBeUndefined();
    expect(hub.clientCount).toBe(1);

    await hub.close();
    expect(await healthy.closedWithin(1_000)).toBeDefined();
    expect(hub.clientCount).toBe(0);
  });
});
