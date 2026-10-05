import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';

import { WebSocket } from 'ws';

import { EventBus } from '../../Lib/EventBus';
import { predictCallToActivityEvent } from '../Activity/ActivityMapper';
import { StreamHub } from './StreamHub';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

const MINT = '2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby';
const IST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;

/** Opens a socket and collects its messages. */
async function open(
  url: string,
): Promise<{ ws: WebSocket; messages: Message[]; next: (match: (m: Message) => boolean) => Promise<Message> }> {
  const ws = new WebSocket(url);
  const messages: Message[] = [];
  const taken = new Set<number>();
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const next = async (match: (m: Message) => boolean): Promise<Message> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const index = messages.findIndex((m, i) => !taken.has(i) && match(m));
      if (index >= 0) {
        taken.add(index);
        return messages[index];
      }
      if (Date.now() > deadline) throw new Error(`no matching message; got ${JSON.stringify(messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { ws, messages, next };
}

describe('StreamHub keyed channels (`launch:<mint>`)', () => {
  let server: Server;
  let hub: StreamHub;
  let url: string;
  const sockets: WebSocket[] = [];
  const snapshot = jest.fn(async (mint: string) => ({ type: 'snapshot', mint }));

  beforeEach(async () => {
    hub = new StreamHub({
      bus: new EventBus(),
      corsOrigins: '*',
      slotIntervalMs: 1_000,
      activity: { fromProgramEvent: async () => null, fromPredictCall: predictCallToActivityEvent },
    });
    hub.registerTopic('launch', {
      validate: (key) => key === MINT || key.toLowerCase() === 'rreh' || key === 'broken' || /^mint\d+$/.test(key),
      canonical: (key) => (key.toLowerCase() === 'rreh' ? MINT : key),
      snapshot: async (key) => {
        if (key === 'broken') throw new Error('The launch RPC is down');
        return snapshot(key);
      },
    });
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hub.attach(server);
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/stream`;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await hub.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const connect = async (query = '') => {
    const client = await open(`${url}${query}`);
    sockets.push(client.ws);
    return client;
  };

  it('advertises the topic, sends the snapshot on subscribe, then what is published', async () => {
    const client = await connect();
    expect((await client.next((m) => m.type === 'hello')).channels).toContain('launch:<key>');
    // By symbol: the channel is the mint's.
    client.ws.send(JSON.stringify({ op: 'subscribe', channels: ['launch:rREH'] }));
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({
      type: 'subscribed',
      channels: [`launch:${MINT}`],
    });
    expect(await client.next((m) => m.channel === `launch:${MINT}`)).toEqual({
      channel: `launch:${MINT}`,
      data: { type: 'snapshot', mint: MINT },
      at: expect.stringMatching(IST),
    });
    expect(hub.topicSubscribers(`launch:${MINT}`)).toBe(1);

    hub.publish(`launch:${MINT}`, { type: 'trade', trade: { slot: 3_443 } });
    hub.publish('launch:someOtherMint', { type: 'trade' });
    expect((await client.next((m) => m.channel === `launch:${MINT}`)).data).toEqual({
      type: 'trade',
      trade: { slot: 3_443 },
    });

    client.ws.send(JSON.stringify({ op: 'unsubscribe', channels: ['launch:rreh'] }));
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({ type: 'subscribed', channels: [] });
    hub.publish(`launch:${MINT}`, { type: 'market' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.messages.filter((m) => m.channel === `launch:${MINT}`)).toHaveLength(2);
    expect(hub.topicSubscribers(`launch:${MINT}`)).toBe(0);
  });

  it('subscribes from the URL next to the plain channels', async () => {
    const client = await connect(`?channels=activity,launch:${MINT}`);
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({
      type: 'subscribed',
      channels: ['activity', `launch:${MINT}`],
    });
    expect((await client.next((m) => m.channel === `launch:${MINT}`)).data.type).toBe('snapshot');
  });

  it('refuses unknown keys and topics, and caps keyed channels per socket', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ op: 'subscribe', channels: ['launch:nope', 'nope:x'] }));
    expect((await client.next((m) => m.type === 'error')).message).toMatch(
      /Unknown channel or too many keyed channels.*launch:nope, nope:x/,
    );
    expect(await client.next((m) => m.type === 'subscribed')).toEqual({ type: 'subscribed', channels: [] });
    expect(snapshot).not.toHaveBeenCalled();

    const many = Array.from({ length: 9 }, (_, i) => `launch:mint${i}`);
    client.ws.send(JSON.stringify({ op: 'subscribe', channels: many }));
    expect((await client.next((m) => m.type === 'error')).message).toMatch(/at most 8\): launch:mint8$/);
    expect((await client.next((m) => m.type === 'subscribed')).channels).toEqual(many.slice(0, 8));
  });

  it('reports a snapshot that fails on the channel', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ op: 'subscribe', channels: ['launch:broken'] }));
    expect(await client.next((m) => m.type === 'error')).toEqual({
      type: 'error',
      channel: 'launch:broken',
      message: 'The launch RPC is down',
    });
  });
});
