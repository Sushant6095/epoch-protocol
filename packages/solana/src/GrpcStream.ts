import { Logger } from '@epoch/logger';
import Client, { type ChannelOptions, type SubscribeRequest, type SubscribeUpdate } from '@triton-one/yellowstone-grpc';

// The Yellowstone protobuf codecs and enums, so apps build requests and decode fixtures without their own dependency.
export {
  CommitmentLevel,
  SlotStatus,
  SubscribeRequest,
  SubscribeUpdate,
  SubscribeUpdateBlockMeta,
  SubscribeUpdateSlot,
  SubscribeUpdateTransaction,
  SubscribeUpdateTransactionInfo,
} from '@triton-one/yellowstone-grpc';

export interface GrpcEndpoint {
  name: string;
  url: string;
  /** Sent as the `x-token` metadata; never logged. */
  token?: string;
}

/** What GrpcStream needs from a Yellowstone client (the real one, or a fake in tests). */
export interface GeyserClient {
  connect(): Promise<void>;
  subscribeReplayInfo(): Promise<{ firstAvailable?: string }>;
  subscribe(request?: SubscribeRequest): Promise<AsyncIterable<SubscribeUpdate> & { destroy(error?: Error): unknown }>;
}

/** A Yellowstone client with the unary calls used by the key check (version, slot). */
export interface GeyserUnaryClient extends GeyserClient {
  getVersion(): Promise<{ version: string }>;
  getSlot(commitment?: number): Promise<{ slot: string }>;
}

/** The real client for one endpoint (call `connect()` first; the token goes on `x-token`). */
export function geyserClient(endpoint: GrpcEndpoint, compression?: 'zstd' | 'gzip'): GeyserUnaryClient {
  return new Client(endpoint.url, endpoint.token, channelOptions(compression)) as unknown as GeyserUnaryClient;
}

export interface SubscribeContext {
  endpoint: GrpcEndpoint;
  /** The oldest slot this endpoint can replay with `fromSlot`, when it reports one (SubscribeReplayInfo). */
  firstAvailableSlot?: number;
  /** 0 for the first connection, then one more for every reconnect. */
  attempt: number;
}

export type GrpcStreamStatus = 'connecting' | 'streaming' | 'reconnecting' | 'stopped';

export interface GrpcStreamState {
  status: GrpcStreamStatus;
  /** The endpoint in use or being tried. */
  endpoint: string;
  reconnects: number;
  lastError?: string;
}

export interface GrpcStreamOptions {
  /** Ask the server to compress the stream (and compress our requests). Default: none. */
  compression?: 'zstd' | 'gzip';
  /** No update at all (the server pings every few seconds) for this long → drop and reconnect. Default 60 s. */
  stallTimeoutMs?: number;
  /** Wait before reconnecting after a stream that delivered data ends. Default 1 s. */
  minReconnectDelayMs?: number;
  /** Errors that reconnecting cannot fix (a refused key or filter): `run()` rejects with them instead of retrying. */
  isFatal?: (error: unknown) => boolean;
  onState?: (state: GrpcStreamState) => void;
  /** Tests. */
  createClient?: (endpoint: GrpcEndpoint, channelOptions: ChannelOptions) => GeyserClient;
}

const logger = Logger.create('GrpcStream');

/**
 * The whole message of a native client error: the top level is generic ("failed to open subscribe stream"); the gRPC
 * status and the server's message (e.g. "invalid api key", "unfiltered/firehose subscriptions are not allowed…")
 * are in the `cause` chain.
 */
export function grpcErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    if (message && !parts.some((part) => part.includes(message))) parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(': ') || String(error);
}

/** The stream's keep-alive and size settings; compression only when asked for. */
export function channelOptions(compression?: 'zstd' | 'gzip'): ChannelOptions {
  return {
    grpcHttp2KeepAliveInterval: 15_000,
    grpcKeepAliveTimeout: 10_000,
    grpcKeepAliveWhileIdle: true,
    grpcTcpNodelay: true,
    grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
    ...(compression ? { grpcDefaultCompressionAlgorithm: compression === 'zstd' ? 1 : 0 } : {}),
  } as ChannelOptions;
}

/**
 * Yellowstone gRPC subscription with reconnect and endpoint failover (Solami primary, RPC Fast secondary).
 *
 * - Each connection asks the endpoint how far back it can replay (SubscribeReplayInfo) and hands that to
 *   `buildRequest`, which sets `fromSlot` from the caller's cursor, so a reconnect continues without a gap.
 * - Updates are handed to `onUpdate` one at a time, in order; the next one is read when the previous promise settles,
 *   so a slow consumer slows the stream down (the server then applies its backpressure policy).
 * - A stream that delivered data and then ended is retried on the primary first after `minReconnectDelayMs`; a
 *   connection that fails before any data moves to the next endpoint with exponential backoff (0.5 s → 30 s), which
 *   stays well under Solami's 100 reconnects per 10 s.
 * - Pings and pongs are not passed on. Silence for `stallTimeoutMs` counts as a dead stream.
 */
export class GrpcStream {
  private stopped = false;
  private active?: { destroy(error?: Error): unknown };
  private wake?: () => void;
  private state: GrpcStreamState;

  constructor(
    private readonly endpoints: GrpcEndpoint[],
    private readonly options: GrpcStreamOptions = {},
  ) {
    if (endpoints.length === 0) throw new Error('GrpcStream needs at least one endpoint');
    this.state = { status: 'connecting', endpoint: endpoints[0].name, reconnects: 0 };
  }

  get status(): GrpcStreamState {
    return { ...this.state };
  }

  async run(
    buildRequest: (context: SubscribeContext) => SubscribeRequest,
    onUpdate: (update: SubscribeUpdate) => Promise<void> | void,
  ): Promise<void> {
    let index = 0;
    let failures = 0;
    let attempt = 0;
    while (!this.stopped) {
      const endpoint = this.endpoints[index % this.endpoints.length];
      let delivered = false;
      this.setState({ status: attempt === 0 ? 'connecting' : 'reconnecting', endpoint: endpoint.name });
      try {
        const client = this.createClient(endpoint);
        await client.connect();
        const replay = await client.subscribeReplayInfo().catch(() => ({ firstAvailable: undefined }));
        const firstAvailableSlot = replay.firstAvailable ? Number(replay.firstAvailable) : undefined;
        const request = buildRequest({ endpoint, firstAvailableSlot, attempt });
        logger.info('subscribing', {
          endpoint: endpoint.name,
          attempt,
          fromSlot: request.fromSlot,
          firstAvailableSlot,
        });
        const stream = await client.subscribe(request);
        this.active = stream;
        if (this.stopped) break;
        const watchdog = this.watchdog(stream);
        try {
          for await (const update of stream) {
            watchdog.touch();
            if (!delivered) {
              delivered = true;
              failures = 0;
              this.setState({ status: 'streaming', endpoint: endpoint.name, lastError: undefined });
            }
            if (update.ping || update.pong) continue;
            await onUpdate(update);
            if (this.stopped) break;
          }
        } finally {
          watchdog.clear();
        }
        if (!this.stopped) this.setState({ lastError: 'stream ended' });
      } catch (error) {
        if (this.stopped) break;
        const text = grpcErrorText(error);
        this.setState({ lastError: text });
        if (this.options.isFatal?.(error)) {
          logger.error('stream refused; not retrying', text, { endpoint: endpoint.name });
          this.setState({ status: 'stopped' });
          throw error;
        }
        logger.warn('stream failed', { endpoint: endpoint.name, attempt, error: text });
      } finally {
        this.active?.destroy();
        this.active = undefined;
      }
      if (this.stopped) break;
      attempt++;
      let delay: number;
      if (delivered) {
        // It worked until it ended (session expiry, node restart, a stall): primary first, after a short pause.
        index = 0;
        delay = this.options.minReconnectDelayMs ?? 1_000;
      } else {
        failures++;
        index++;
        delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
      }
      this.setState({ status: 'reconnecting', reconnects: this.state.reconnects + 1 });
      await this.pause(delay);
    }
    this.setState({ status: 'stopped' });
  }

  /** Ends the current stream and the run loop. */
  stop(): void {
    this.stopped = true;
    this.active?.destroy();
    this.wake?.();
    this.setState({ status: 'stopped' });
  }

  private createClient(endpoint: GrpcEndpoint): GeyserClient {
    const options = channelOptions(this.options.compression);
    if (this.options.createClient) return this.options.createClient(endpoint, options);
    return new Client(endpoint.url, endpoint.token, options) as unknown as GeyserClient;
  }

  private watchdog(stream: { destroy(error?: Error): unknown }): { touch(): void; clear(): void } {
    const limit = this.options.stallTimeoutMs ?? 60_000;
    let last = Date.now();
    const timer = setInterval(
      () => {
        if (Date.now() - last > limit) stream.destroy(new Error(`no update for ${Math.round(limit / 1000)} s`));
      },
      Math.min(limit, 5_000),
    );
    timer.unref();
    return {
      touch: () => {
        last = Date.now();
      },
      clear: () => clearInterval(timer),
    };
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private setState(patch: Partial<GrpcStreamState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.({ ...this.state });
  }
}
