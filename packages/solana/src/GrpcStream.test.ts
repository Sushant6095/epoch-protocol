import { type SubscribeRequest, type SubscribeUpdate } from '@triton-one/yellowstone-grpc';

import {
  channelOptions,
  type GeyserClient,
  type GrpcEndpoint,
  grpcErrorText,
  GrpcStream,
  type GrpcStreamState,
} from './GrpcStream';

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
});
