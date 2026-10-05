import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';

import { WebSocket } from 'ws';

import { EventBus } from '../../Lib/EventBus';
import { predictCallToActivityEvent, toActivityEvent } from '../Activity/ActivityMapper';
import { EMPTY_NAMES } from '../Activity/ValidatorNames';
import { StreamHub } from './StreamHub';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/** A websocket that keeps every message. */
async function open(url: string): Promise<{ ws: WebSocket; messages: Message[] }> {
  const ws = new WebSocket(url);
  const messages: Message[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('StreamHub predict:panta channel', () => {
  let server: Server;
  let hub: StreamHub;
  let url = '';
  let reads = 0;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/stream`;
    hub = new StreamHub({
      bus: new EventBus(),
      corsOrigins: '*',
      slotIntervalMs: 60_000,
      activity: {
        fromProgramEvent: async (event) => toActivityEvent(event, EMPTY_NAMES),
        fromPredictCall: predictCallToActivityEvent,
      },
    });
    hub.attach(server);
  });

  afterAll(async () => {
    await hub.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('is offered once Panta provides it, sends the current prices on subscribe and pushes on refresh', async () => {
    expect(hub.channels).not.toContain('predict:panta');
    hub.setProvider('predict:panta', async () => ({ poweredBy: 'Panta', read: ++reads, markets: [] }));
    expect(hub.channels).toContain('predict:panta');

    const client = await open(`${url}?channels=predict:panta`);
    await until(() => client.messages.some((m) => m.channel === 'predict:panta'));
    expect(client.messages.find((m) => m.channel === 'predict:panta')).toMatchObject({
      channel: 'predict:panta',
      data: { poweredBy: 'Panta', read: 1 },
    });
    expect(hub.subscriberCount('predict:panta')).toBe(1);

    hub.refresh('predict:panta');
    await until(() => client.messages.filter((m) => m.channel === 'predict:panta').length === 2);
    expect(client.messages.filter((m) => m.channel === 'predict:panta').at(-1)).toMatchObject({ data: { read: 2 } });

    client.ws.close();
    await until(() => hub.subscriberCount('predict:panta') === 0);
  });
});
