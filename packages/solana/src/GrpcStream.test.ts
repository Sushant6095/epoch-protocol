import { type SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc';

import {
  channelOptions,
  countNativeBytes,
  type GeyserClient,
  geyserClient,
  type GrpcEndpoint,
  grpcErrorText,
  GrpcStream,
  type GrpcStreamState,
} from './GrpcStream';
import { SolamiUsage } from './SolamiUsage';

const slotUpdate = (slot: number): SubscribeUpdate =>
  ({ filters: ['s'], slot: { slot: String(slot), status: 1 }, createdAt: undefined }) as SubscribeUpdate;
const ping = (): SubscribeUpdate => ({ filters: [], ping: {}, createdAt: undefined }) as SubscribeUpdate;

type Script = { fail?: Error; updates?: SubscribeUpdate[]; error?: Error; firstAvailable?: string };

/** A fake Yellowstone client: each connection plays the next script (updates, then end or error). */
function fakeClients(scripts: Script[]) {
  const connections: { endpoint: string; request?: SubscribeRequest; destroyed: boolean }[] = [];
  const create = (endpoint: GrpcEndpoint): GeyserClient => {
    const script = scripts.shift() ?? { fail: new Error('no more scripts') };
    const record: { endpoint: string; request?: SubscribeRequest; destroyed: boolean } = {
      endpoint: endpoint.name,
      destroyed: false,
    };
    connections.push(record);
    return {
      connect: async () => {
        if (script.fail) throw script.fail;
      },
      subscribeReplayInfo: async () => ({ firstAvailable: script.firstAvailable }),
      subscribe: async (request) => {
        record.request = request;
        const updates = script.updates ?? [];
        return {
          destroy: () => {
            record.destroyed = true;
          },
          async *[Symbol.asyncIterator]() {
            for (const update of updates) yield update;
            if (script.error) throw script.error;
          },
        };
      },
    };
  };
  return { create, connections };
}

const ENDPOINTS: GrpcEndpoint[] = [
  { name: 'solami', url: 'https://grpc.solami.dev', token: 'secret' },
  { name: 'rpc-fast', url: 'https://example.invalid' },
];

describe('GrpcStream', () => {
  it('passes updates in order, skips pings, and resumes from the caller’s cursor after a drop', async () => {
    const { create, connections } = fakeClients([
      {
        firstAvailable: '90',
        updates: [slotUpdate(100), ping(), slotUpdate(101)],
        error: new Error('session expired'),
      },
      { firstAvailable: '95', updates: [slotUpdate(102)] },
    ]);
    const seen: number[] = [];
    const contexts: (number | undefined)[] = [];
    const stream = new GrpcStream(ENDPOINTS, { createClient: create, minReconnectDelayMs: 1 });
    let last = 99;
    await stream.run(
      ({ firstAvailableSlot }) => {
        contexts.push(firstAvailableSlot);
        return { fromSlot: String(last + 1) } as SubscribeRequest;
      },
      async (update) => {
        last = Number(update.slot?.slot);
        seen.push(last);
        if (last === 102) stream.stop();
      },
    );
    expect(seen).toEqual([100, 101, 102]);
    expect(contexts).toEqual([90, 95]);
    expect(connections.map((c) => [c.endpoint, c.request?.fromSlot])).toEqual([
      ['solami', '100'],
      ['solami', '102'],
    ]);
    expect(connections.every((c) => c.destroyed)).toBe(true);
    expect(stream.status.status).toBe('stopped');
  });

  it('fails over to the next endpoint when a connection fails before any data, then back to Solami first', async () => {
    const { create, connections } = fakeClients([
      { fail: new Error('connect timeout') },
      { updates: [slotUpdate(1)] },
      { updates: [slotUpdate(2)] },
    ]);
    const states: GrpcStreamState[] = [];
    const stream = new GrpcStream(ENDPOINTS, {
      createClient: create,
      minReconnectDelayMs: 1,
      onState: (state) => states.push(state),
    });
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const run = stream.run(
      () => ({}) as SubscribeRequest,
      (update) => {
        if (update.slot?.slot === '2') stream.stop();
      },
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await run;
    jest.useRealTimers();
    expect(connections.map((c) => c.endpoint)).toEqual(['solami', 'rpc-fast', 'solami']);
    expect(states.some((s) => s.status === 'streaming' && s.endpoint === 'rpc-fast')).toBe(true);
    expect(states.find((s) => s.lastError)?.lastError).toBe('connect timeout');
    // The token never appears in the state that is logged and exposed.
    expect(JSON.stringify(states)).not.toContain('secret');
  });

  it('gives up on errors the caller marks fatal (a refused firehose filter)', async () => {
    const refused = new Error('status: PermissionDenied, message: "unfiltered/firehose subscriptions are not allowed"');
    const { create } = fakeClients([{ error: refused }]);
    const stream = new GrpcStream(ENDPOINTS, {
      createClient: create,
      isFatal: (error) => /firehose/.test(String(error)),
    });
    await expect(
      stream.run(
        () => ({}) as SubscribeRequest,
        () => undefined,
      ),
    ).rejects.toBe(refused);
    expect(stream.status.status).toBe('stopped');
  });

  it('joins the native error’s cause chain (the gRPC status is never in the top-level message)', () => {
    const error = Object.assign(new Error('failed to open subscribe stream'), {
      cause: Object.assign(new Error(`gRPC status: code: 'x', message: "invalid api key"`), {
        cause: new Error(`code: 'x', message: "invalid api key"`),
      }),
    });
    expect(grpcErrorText(error)).toBe(
      `failed to open subscribe stream: gRPC status: code: 'x', message: "invalid api key"`,
    );
    expect(grpcErrorText('plain')).toBe('plain');
  });

  it('asks for compression only when configured', () => {
    expect(channelOptions()).not.toHaveProperty('grpcDefaultCompressionAlgorithm');
    expect(channelOptions('zstd')).toMatchObject({ grpcDefaultCompressionAlgorithm: 1 });
    expect(channelOptions('gzip')).toMatchObject({ grpcDefaultCompressionAlgorithm: 0 });
  });

  it('hands zstd to the native client as a valid setting (a wrong value is refused before any connection)', async () => {
    // Nothing listens on port 1: a valid configuration gets as far as dialing.
    const closed = { name: 'local', url: 'http://127.0.0.1:1' };
    const outcome = (client: GeyserClient) =>
      client.connect().then(
        () => 'connected',
        (error: unknown) => grpcErrorText(error),
      );
    expect(await outcome(geyserClient(closed, 'zstd'))).toMatch(/failed to connect/);
    expect(await outcome(geyserClient(closed, 'gzip'))).toMatch(/failed to connect/);
    const wrong = geyserClient(closed);
    (wrong as unknown as { _channelOptions: object })._channelOptions = {
      ...channelOptions(),
      grpcDefaultCompressionAlgorithm: 7,
    };
    expect(await outcome(wrong)).toMatch(/JsCompressionAlgorithm/);
  });

  it('counts bytes, updates and state for the usage report', async () => {
    const updates = [slotUpdate(100), ping(), slotUpdate(101)];
    const { create } = fakeClients([{ updates }]);
    const usage = new SolamiUsage('test');
    const stream = new GrpcStream(ENDPOINTS, {
      createClient: create,
      usage,
      subscription: 'slots',
      compression: 'zstd',
    });
    await stream.run(
      () => ({}) as SubscribeRequest,
      async (update) => {
        if (update.slot?.slot === '101') stream.stop();
      },
    );
    const bytes = updates.reduce((sum, u) => sum + SubscribeUpdate.encode(u).finish().length, 0);
    expect(usage.report().grpc).toMatchObject({
      subscription: 'slots',
      compression: 'zstd',
      endpoint: 'solami',
      status: 'stopped',
      bytes,
      updates: 3,
    });
  });

  it('reads byte counts from the native stream when it can, instead of re-encoding', async () => {
    const native = { read: async () => Buffer.alloc(42) as Uint8Array | null };
    const wrapper = { _napiDuplexStream: native };
    const seen: number[] = [];
    expect(countNativeBytes(wrapper, (n) => seen.push(n))).toBe(true);
    await native.read();
    await native.read();
    expect(seen).toEqual([42, 42]);
    expect(countNativeBytes({}, () => undefined)).toBe(false);
  });

  it('logs a refused key with what to change, and records it as the last error', async () => {
    const refused = Object.assign(new Error('failed to open subscribe stream'), {
      cause: new Error(
        `gRPC status: code: 'The request does not have valid authentication credentials', message: "invalid api key"`,
      ),
    });
    const { create } = fakeClients([{ fail: refused }]);
    const usage = new SolamiUsage('test');
    const stream = new GrpcStream([ENDPOINTS[0]], { createClient: create, usage, isFatal: () => true });
    await expect(
      stream.run(
        () => ({}) as SubscribeRequest,
        () => undefined,
      ),
    ).rejects.toBe(refused);
    expect(usage.report().lastError).toMatchObject({
      product: 'grpc',
      message: expect.stringContaining('refused SOLAMI_TOKEN'),
    });
  });
});
