import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';

import { encodeLivePayload, type LiveSlotPayload } from '@epoch/pg_models';
import { WebSocket } from 'ws';

import { EventBus } from '../../Lib/EventBus';
import { predictCallToActivityEvent, toActivityEvent } from '../Activity/ActivityMapper';
import { EMPTY_NAMES } from '../Activity/ValidatorNames';
import { StreamHub } from '../Stream/StreamHub';
import { LiveFeed, type FeedHub } from './LiveFeed';
import { type LiveService } from './LiveService';

const SLOT: LiveSlotPayload = {
  t: 'slot',
  slot: 452_937_400,
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

function fakeService(): Pick<LiveService, 'summary' | 'slotFromPayload'> & { summaries: number } {
  const service = {
    summaries: 0,
    summary: async () => {
      service.summaries++;
      return { live: true, n: service.summaries } as never;
    },
    slotFromPayload: async (p: LiveSlotPayload) => ({ slot: p.slot, leaderName: 'Helius' }) as never,
  };
  return service;
}

function fakeHub(): FeedHub & { frames: [string, unknown][]; feeds: string[] } {
  const hub = {
    frames: [] as [string, unknown][],
    feeds: [] as string[],
    setFeed: (channel: string) => hub.feeds.push(channel),
    publish: (channel: string, data: unknown) => hub.frames.push([channel, data]),
  };
  return hub as never;
}

describe('LiveFeed', () => {
  it('turns NOTIFY payloads into `slots` frames in order and throttled `index:live` summaries', async () => {
    const hub = fakeHub();
    const service = fakeService();
    let notify: (payload: string | undefined) => void = () => undefined;
    let state: (on: boolean) => void = () => undefined;
    const feed = new LiveFeed({
      hub,
      service,
      indexThrottleMs: 30,
      listen: (onNotification, onState) => {
        notify = onNotification;
        state = onState;
        return { start: () => undefined, stop: async () => undefined };
      },
    });
    feed.start();
    expect(hub.feeds).toEqual(['slots', 'index:live']);

    notify(encodeLivePayload(SLOT));
    notify(encodeLivePayload({ ...SLOT, slot: SLOT.slot + 1 }));
    notify('garbage');
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.frames).toEqual([
      ['slots', { slot: 452_937_400, leaderName: 'Helius' }],
      ['slots', { slot: 452_937_401, leaderName: 'Helius' }],
    ]);

    // Three estimates inside the throttle window → one summary push.
    const index = encodeLivePayload({
      t: 'index',
      epoch: 1048,
      estimate: 9_400,
      leaders: 812,
      slotsWithFees: 1,
      pricedTxs: 1,
      firstSlot: 1,
      processedSlot: 1,
      watermarkSlot: 1,
      tipSlot: 1,
      stakeEpoch: 1048,
      source: 'grpc',
      endpoint: 'solami',
      status: 'streaming',
      stride: 1,
      lastSlotAt: 1,
    });
    notify(index);
    notify(index);
    notify(index);
    await new Promise((r) => setTimeout(r, 60));
    expect(hub.frames.filter(([c]) => c === 'index:live')).toHaveLength(1);

    // An epoch rollup and a LISTEN reconnect push the summary at once.
    notify(encodeLivePayload({ t: 'epoch', epoch: 1047, value: 9_120 }));
    await new Promise((r) => setTimeout(r, 5));
    state(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.frames.filter(([c]) => c === 'index:live').length).toBeGreaterThanOrEqual(2);
    await feed.stop();
  });
});

describe('StreamHub feed channels', () => {
  let server: Server;
  let hub: StreamHub;
  let url: string;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hub = new StreamHub({
      bus: new EventBus(),
      corsOrigins: '*',
      slotIntervalMs: 1_000,
      activity: {
        fromProgramEvent: async (e) => toActivityEvent(e, EMPTY_NAMES),
        fromPredictCall: predictCallToActivityEvent,
      },
    });
    hub.attach(server);
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/stream`;
  });

  afterAll(async () => {
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = async (query = '') => {
    const ws = new WebSocket(url + query);
    const messages: { type?: string; channel?: string; data?: unknown; channels?: string[] }[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return { ws, messages };
  };

  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('lists the feed channels once enabled, sends the index snapshot on subscribe and pushes to subscribers only', async () => {
    const before = await open();
    await settle();
    expect(before.messages[0]).toEqual({ type: 'hello', channels: ['activity'] });
    before.ws.close();

    hub.setFeed('slots');
    hub.setFeed('index:live', async () => ({ live: true, estimate: { value: 9_400 } }));
    const page = await open('?channels=slots,index:live');
    const other = await open('?channels=activity');
    await settle();
    expect(page.messages[0]).toEqual({ type: 'hello', channels: ['activity', 'slots', 'index:live'] });
    expect(page.messages).toContainEqual(
      expect.objectContaining({ channel: 'index:live', data: { live: true, estimate: { value: 9_400 } } }),
    );

    hub.publish('slots', { slot: 452_937_400 });
    hub.publish('index:live', { live: true, estimate: { value: 9_500 } });
    await settle();
    expect(page.messages).toContainEqual(expect.objectContaining({ channel: 'slots', data: { slot: 452_937_400 } }));
    expect(page.messages.filter((m) => m.channel === 'index:live').pop()?.data).toEqual({
      live: true,
      estimate: { value: 9_500 },
    });
    expect(other.messages.some((m) => m.channel === 'slots' || m.channel === 'index:live')).toBe(false);

    // A late subscriber gets the last pushed value, not a fresh read.
    const late = await open('?channels=index:live');
    await settle();
    expect(late.messages.find((m) => m.channel === 'index:live')?.data).toEqual({
      live: true,
      estimate: { value: 9_500 },
    });
    for (const c of [page, other, late]) c.ws.close();
  });
});
