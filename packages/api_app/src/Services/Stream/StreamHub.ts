import { type IncomingMessage, type Server, STATUS_CODES } from 'http';
import { type Duplex } from 'stream';

import { GracefulShutdown } from '@epoch/common';
import { type EventName } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import { StreamClientMessageDto } from '../../dto/Stream.dto';
import { type EventBus, type PredictCallEvent, type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst } from '../../Lib/Stats';
import {
  type ActivityEvent,
  type SlotUpdate,
  type StreamChannel,
  type StreamFrame,
  type StreamServerMessage,
  type StreamTopicChannel,
} from '../../types/Activity.types';
import { EMPTY_NAMES, type NameIndex } from '../Activity/ValidatorNames';

const logger = Logger.create('StreamHub');

/** Every channel, in the order the server lists them. */
export const STREAM_CHANNELS: readonly StreamChannel[] = [
  'slot',
  'activity',
  'vault',
  'feeIndex',
  'slots',
  'index:live',
  'predict:panta',
];

/** Whether `name` is one of the fixed channels above (some of them contain a colon, like keyed channels do). */
const isFixedChannel = (name: string): name is StreamChannel => (STREAM_CHANNELS as readonly string[]).includes(name);

/** Program events that change the Pool: the `vault` channel pushes a fresh snapshot after them. */
export const VAULT_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  'Deposited',
  'WithdrawRequested',
  'WithdrawCancelled',
  'WithdrawProcessed',
  'Accrued',
  'AdvanceOpened',
  'Swept',
  'AdvanceRepaid',
  'AdvanceDefaulted',
  'BondPosted',
  'BondWithdrawn',
  'TreasuryClaimed',
]);

export const FEE_INDEX_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  'IndexProposed',
  'IndexFinalized',
  'IndexVetoed',
  // Operator consensus: every vote moves the ballot progress the frame carries.
  'IndexBallotOpened',
  'IndexVoteCast',
  'IndexConsensusReached',
  'IndexBallotSubmitted',
  'IndexBallotClosed',
]);

/** The `slot` channel's reads (mainnet). */
export interface SlotSource {
  getEpochInfo(): Promise<{ epoch: number; slotIndex: number; slotsInEpoch: number; absoluteSlot: number }>;
  /** Leader identities of `limit` consecutive slots from `startSlot`. */
  getSlotLeaders(startSlot: number, limit: number): Promise<string[]>;
}

/** Slots pushed by a stream (api_app's Solami gRPC): while it delivers, the `slot` channel follows it, not polling. */
export interface SlotFeed {
  /** Confirmed slots as they arrive; returns the unsubscribe. */
  onSlot(listener: (slot: number) => void): () => void;
}

/** Turns bus events into activity rows (ActivityService). */
export interface ActivityMapper {
  fromProgramEvent(event: StoredProgramEvent): Promise<ActivityEvent | null>;
  fromPredictCall(call: PredictCallEvent): ActivityEvent;
}

export type ProviderChannel = 'vault' | 'feeIndex' | 'predict:panta';
const PROVIDER_CHANNELS: readonly ProviderChannel[] = ['vault', 'feeIndex', 'predict:panta'];
/** Reads the channel's current value (the whole snapshot is pushed, not a diff). */
export type StreamProvider = () => Promise<unknown>;
/** Channels fed from outside the hub (the indexer's live feed over Postgres NOTIFY), pushed with `publish()`. */
export type FeedChannel = 'slots' | 'index:live';
const isFeedChannel = (channel: string): channel is FeedChannel => channel === 'slots' || channel === 'index:live';

/**
 * A family of keyed channels, `<topic>:<key>` (e.g. `launch:<mint>`): the server validates the key on subscribe, sends
 * the snapshot (when there is one) to the new subscriber, and forwards whatever `publish` sends to that channel.
 */
export interface StreamTopic {
  /** Whether `key` names something this server streams (e.g. a launch's mint or symbol). */
  validate(key: string): boolean;
  /** The canonical key for a valid one (e.g. symbol → mint); default the key itself. */
  canonical?(key: string): string;
  /** What a new subscriber gets first. */
  snapshot?(key: string): Promise<unknown>;
}

/** At most this many keyed channels per socket. */
const MAX_TOPIC_CHANNELS_PER_CLIENT = 8;

export interface StreamHubOptions {
  bus: EventBus;
  /** API_CORS_ORIGINS: `*` (any origin) or a comma-separated list the Origin header must match. */
  corsOrigins: string;
  /** STREAM_SLOT_INTERVAL_MS. */
  slotIntervalMs: number;
  /** Omitted → no `slot` channel. */
  slots?: SlotSource;
  /**
   * Pushed slots (Solami Yellowstone gRPC, confirmed): the `slot` channel sends each one as it arrives and polls
   * `slots` only while the feed is quiet (not configured, down, or refused).
   */
  slotFeed?: SlotFeed;
  /** Without a pushed slot for this long (at least two slot intervals) the `slot` channel polls again. Default 3 s. */
  slotFeedQuietMs?: number;
  /** Names the slot leader by identity. */
  names?: () => Promise<NameIndex>;
  activity: ActivityMapper;
  /**
   * `vault` (VaultService, built separately), `feeIndex` (FeeIndexService.stream) and `predict:panta` (PantaService,
   * pushed by its poller through `refresh`); a channel without one is off.
   */
  providers?: Partial<Record<ProviderChannel, StreamProvider>>;
  path?: string;
  /** Ping interval; a socket that misses a pong by the next one is terminated. Default 30 s. */
  heartbeatMs?: number;
  /** `vault` pushes wait for this quiet time after the last pool event (at most 5× it). Default 2 s. */
  vaultDebounceMs?: number;
  /** Index events of one transaction (finalize + propose) give one `feeIndex` push. Default 250 ms. */
  feeIndexDebounceMs?: number;
  /** Default 1,000. */
  maxClients?: number;
  /** Largest client message, bytes. Default 4 KiB. */
  maxPayloadBytes?: number;
  /** Program events older than this (a backfill after downtime) stay out of the live `activity` channel. Default 10 min. */
  activityMaxAgeMs?: number;
  now?: () => number;
}

interface Client {
  socket: WebSocket;
  channels: Set<StreamChannel>;
  /** Keyed channels (`launch:<mint>`). */
  topics: Set<StreamTopicChannel>;
  alive: boolean;
  windowStart: number;
  messages: number;
}

const LEADER_BATCH = 100;
/** A client that lets this much pile up unsent is too slow to keep. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MESSAGE_WINDOW_MS = 10_000;
const MESSAGES_PER_WINDOW = 50;
/** A provider value served to new subscribers without a re-read, unless an event made it stale. */
const PROVIDER_VALUE_MAX_AGE_MS = 15_000;
const ERROR_LOG_INTERVAL_MS = 60_000;
/** Without a pushed slot for this long (or two slot intervals) the `slot` channel polls again. */
const FEED_QUIET_MS = 3_000;
/** How often the epoch info behind pushed slots is re-read. */
const EPOCH_INFO_MAX_AGE_MS = 60_000;

/** Trailing debounce with a ceiling, so a steady stream of events still pushes every `maxWaitMs`. */
class Debouncer {
  private timer?: NodeJS.Timeout;
  private firstAt?: number;

  constructor(
    private readonly run: () => void,
    private readonly waitMs: number,
    private readonly maxWaitMs: number,
  ) {}

  trigger(): void {
    const now = Date.now();
    this.firstAt ??= now;
    clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(this.waitMs, this.firstAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.firstAt = undefined;
      this.run();
    }, delay);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.firstAt = undefined;
  }
}

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '').toLowerCase();

const rawToString = (data: RawData): string => {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
};

/** Answers an upgrade with a plain HTTP error and closes the socket (what `ws` does for a refused handshake). */
function refuse(socket: Duplex, status: number): void {
  const text = STATUS_CODES[status] ?? 'Error';
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
}

/** The request URL, or null when it doesn't parse. */
function requestUrl(url: string | undefined): URL | null {
  try {
    return new URL(url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

/** Channels named in `?channels=slot,activity`. */
function channelsParam(url: string | undefined): string[] {
  const value = requestUrl(url)?.searchParams.get('channels') ?? '';
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 16);
}

/**
 * WS /v1/stream (request #4): one websocket per page carrying the channels it subscribes to.
 *
 * - `slot`: MAINNET slot, epoch progress and leader, polled every STREAM_SLOT_INTERVAL_MS only while someone listens.
 * - `activity`: each new activity row (program events from the ingester, Predict calls), as `GET /v1/activity` maps them.
 * - `vault` / `feeIndex`: the provider's whole snapshot, pushed after the program events that change it and right
 *   after a client subscribes.
 * Protocol: see packages/api_app/README.md.
 */
export class StreamHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly path: string;
  private readonly allowedOrigins: ReadonlySet<string> | null;
  private readonly providers: Partial<Record<ProviderChannel, StreamProvider>>;
  private readonly now: () => number;
  private server?: Server;
  private heartbeat?: NodeJS.Timeout;
  /** Removes the bus listeners. */
  private busListeners: (() => void)[] = [];
  private activityQueue: Promise<void> = Promise.resolve();
  private shutdownRegistered = false;

  private slotTimer?: NodeJS.Timeout;
  private slotBusy = false;
  /** The last slot read and when (epoch ms). */
  private lastSlot?: { update: SlotUpdate; at: number };
  private leaders?: { start: number; identities: string[] };
  private lastSlotErrorLog = 0;
  /** Unsubscribes from the slot feed. */
  private feedOff?: () => void;
  /** When the feed last pushed a slot (epoch ms). */
  private lastFeedAt = 0;
  /** The last epoch info read: places pushed slots in their epoch. */
  private epochInfo?: { info: Awaited<ReturnType<SlotSource['getEpochInfo']>>; at: number };
  private epochInfoBusy = false;

  private readonly pushers: Record<ProviderChannel, Debouncer>;
  private readonly cached = new Map<ProviderChannel, { data: unknown; at: number; generation: number }>();
  private readonly inflight = new Map<ProviderChannel, { promise: Promise<unknown>; generation: number }>();
  private readonly generation: Record<ProviderChannel, number> = { vault: 0, feeIndex: 0, 'predict:panta': 0 };
  private readonly topics = new Map<string, StreamTopic>();
  /** Enabled feed channels: an optional snapshot for new subscribers, and the last value pushed. */
  private readonly feeds = new Map<FeedChannel, { snapshot?: StreamProvider; last?: { data: unknown; at: number } }>();

  constructor(private readonly options: StreamHubOptions) {
    this.path = options.path ?? '/v1/stream';
    this.now = options.now ?? Date.now;
    this.providers = { ...options.providers };
    const origins = options.corsOrigins.trim();
    this.allowedOrigins =
      origins === '*' || origins === '' ? null : new Set(origins.split(',').map(normalizeOrigin).filter(Boolean));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? 4 * 1024 });
    const vaultWait = options.vaultDebounceMs ?? 2_000;
    const indexWait = options.feeIndexDebounceMs ?? 250;
    this.pushers = {
      vault: new Debouncer(() => void this.pushAll('vault'), vaultWait, vaultWait * 5),
      feeIndex: new Debouncer(() => void this.pushAll('feeIndex'), indexWait, indexWait * 5),
      'predict:panta': new Debouncer(() => void this.pushAll('predict:panta'), 0, 0),
    };
  }

  /** Channels this server can serve now. */
  get channels(): StreamChannel[] {
    return STREAM_CHANNELS.filter((channel) => {
      if (channel === 'slot') return this.options.slots !== undefined;
      if (channel === 'activity') return true;
      if (isFeedChannel(channel)) return this.feeds.has(channel);
      return this.providers[channel] !== undefined;
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Sets or replaces a channel's provider (e.g. the VaultService once it exists). */
  setProvider(channel: ProviderChannel, provider: StreamProvider | undefined): void {
    this.providers[channel] = provider;
    this.invalidate(channel);
  }

  /** Adds a family of keyed channels, `<name>:<key>` (e.g. `launch` for `launch:<mint>`). */
  registerTopic(name: string, topic: StreamTopic): void {
    this.topics.set(name, topic);
  }

  /**
   * Enables a feed channel. `snapshot` answers a new subscriber when nothing was pushed in the last minute (e.g. the
   * summary for `index:live`); `slots` has none: the page loads history over REST and appends frames.
   */
  setFeed(channel: FeedChannel, snapshot?: StreamProvider): void {
    this.feeds.set(channel, { ...this.feeds.get(channel), snapshot });
  }

  /**
   * Pushes `data` to a feed channel's subscribers (keeping it for the next subscriber), or to every socket subscribed
   * to a keyed channel (`launch:<mint>`).
   */
  publish(channel: FeedChannel | StreamTopicChannel, data: unknown): void {
    if (isFeedChannel(channel)) {
      const feed = this.feeds.get(channel);
      if (!feed) return;
      feed.last = { data, at: this.now() };
      if (this.subscribers(channel) > 0) this.broadcast(channel, data);
      return;
    }
    const frame: StreamFrame = { channel, data, at: isoIst(new Date(this.now())) };
    const text = JSON.stringify(frame);
    for (const client of this.clients) if (client.topics.has(channel)) this.sendRaw(client, text);
  }

  /** Clients subscribed to a fixed channel (a poller polls only while someone listens). */
  subscriberCount(channel: StreamChannel): number {
    return this.subscribers(channel);
  }

  /** The provider's data changed (a poller re-read it): drop the cached value and push the new one to subscribers. */
  refresh(channel: ProviderChannel): void {
    this.invalidate(channel);
    if (this.providers[channel]) this.pushers[channel].trigger();
  }

  /** Sockets subscribed to a keyed channel. */
  topicSubscribers(channel: StreamTopicChannel): number {
    let n = 0;
    for (const client of this.clients) if (client.topics.has(channel)) n++;
    return n;
  }

  /** Serves `path` upgrades on `server` (other upgrade paths are left to their own handlers). */
  attach(server: Server): void {
    if (this.server) throw new Error('StreamHub is already attached');
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    this.busListeners = [
      this.options.bus.on('programEvent', (event) => this.onProgramEvent(event)),
      this.options.bus.on('predictCall', (call) => this.onPredictCall(call)),
    ];
    this.heartbeat = setInterval(() => this.beat(), this.options.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
    if (!this.shutdownRegistered) GracefulShutdown.register('stream-hub', () => this.close());
    this.shutdownRegistered = true;
    logger.info('websocket stream ready', { path: this.path, channels: this.channels });
  }

  /** Closes every socket and stops all timers. */
  async close(): Promise<void> {
    this.server?.off('upgrade', this.onUpgrade);
    this.server = undefined;
    for (const off of this.busListeners) off();
    this.busListeners = [];
    clearInterval(this.heartbeat);
    this.stopSlotPolling();
    this.feedOff?.();
    this.feedOff = undefined;
    for (const channel of PROVIDER_CHANNELS) this.pushers[channel].cancel();
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ── Connections ──────────────────────────────────────────────────────────────────────────────────

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = requestUrl(req.url)?.pathname.replace(/\/+$/, '');
    if (pathname !== this.path) return;
    if (!this.originAllowed(req.headers.origin)) {
      logger.debug('websocket origin refused', { origin: req.headers.origin });
      refuse(socket, 403);
      return;
    }
    if (this.clients.size >= (this.options.maxClients ?? 1_000)) {
      refuse(socket, 503);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
  };

  /** Browsers always send Origin; a client without one (a script, a server) is not a cross-site page. */
  private originAllowed(origin: string | undefined): boolean {
    if (!this.allowedOrigins || origin === undefined) return true;
    return this.allowedOrigins.has(normalizeOrigin(origin));
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const client: Client = {
      socket,
      channels: new Set(),
      topics: new Set(),
      alive: true,
      windowStart: this.now(),
      messages: 0,
    };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => this.onMessage(client, data));
    socket.on('close', () => this.drop(client));
    socket.on('error', (error) => logger.debug('websocket error', { error: String(error) }));
    this.send(client, {
      type: 'hello',
      channels: [...this.channels, ...[...this.topics.keys()].map((name) => `${name}:<key>`)],
    });
    const requested = channelsParam(req.url);
    if (requested.length > 0) this.subscribe(client, requested);
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (client.channels.has('slot')) this.updateSlotPolling();
  }

  private beat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.drop(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  private onMessage(client: Client, data: RawData): void {
    const now = this.now();
    if (now - client.windowStart > MESSAGE_WINDOW_MS) {
      client.windowStart = now;
      client.messages = 0;
    }
    if (++client.messages > MESSAGES_PER_WINDOW) {
      client.socket.close(1008, 'Too many messages');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data));
    } catch {
      this.send(client, {
        type: 'error',
        message: 'Messages must be JSON, e.g. {"op":"subscribe","channels":["slot"]}',
      });
      return;
    }
    const message = StreamClientMessageDto.safeParse(parsed);
    if (!message.success) {
      this.send(client, {
        type: 'error',
        message: 'Unknown message: send {"op":"subscribe"|"unsubscribe","channels":[…]} or {"op":"ping"}',
      });
      return;
    }
    switch (message.data.op) {
      case 'ping':
        this.send(client, { type: 'pong' });
        return;
      case 'subscribe':
        this.subscribe(client, message.data.channels);
        return;
      case 'unsubscribe':
        this.unsubscribeClient(client, message.data.channels);
        return;
    }
  }

  /** `<topic>:<key>` names this server streams, canonicalised (e.g. `launch:rREH` → `launch:<mint>`). */
  private topicChannel(name: string): StreamTopicChannel | null {
    const at = name.indexOf(':');
    if (at <= 0) return null;
    const topic = this.topics.get(name.slice(0, at));
    const key = name.slice(at + 1);
    if (!topic || !key || !topic.validate(key)) return null;
    return `${name.slice(0, at)}:${topic.canonical?.(key) ?? key}` as StreamTopicChannel;
  }

  private subscribedNames(client: Client): (StreamChannel | StreamTopicChannel)[] {
    return [...STREAM_CHANNELS.filter((c) => client.channels.has(c)), ...client.topics];
  }

  private subscribe(client: Client, requested: readonly string[]): void {
    // Fixed channels may contain a colon too (`index:live`, `predict:panta`); anything else with one is keyed.
    const topicNames = requested.filter((name) => !isFixedChannel(name) && name.includes(':'));
    const names = requested.filter((name) => isFixedChannel(name) || !name.includes(':'));
    const badTopics: string[] = [];
    for (const name of topicNames) {
      const channel = this.topicChannel(name);
      if (!channel || (client.topics.size >= MAX_TOPIC_CHANNELS_PER_CLIENT && !client.topics.has(channel))) {
        badTopics.push(name);
        continue;
      }
      if (client.topics.has(channel)) continue;
      client.topics.add(channel);
      void this.sendTopicSnapshot(client, channel);
    }
    if (badTopics.length > 0) {
      this.send(client, {
        type: 'error',
        message: `Unknown channel or too many keyed channels (at most ${MAX_TOPIC_CHANNELS_PER_CLIENT}): ${badTopics.join(', ')}`,
      });
    }
    const available = this.channels;
    const unknown = names.filter((name) => !(available as string[]).includes(name));
    if (unknown.length > 0) {
      this.send(client, {
        type: 'error',
        message: `Unknown or unavailable channel: ${unknown.join(', ')} (available: ${available.join(', ')})`,
      });
    }
    const added = available.filter((channel) => names.includes(channel) && !client.channels.has(channel));
    for (const channel of added) client.channels.add(channel);
    this.send(client, { type: 'subscribed', channels: this.subscribedNames(client) });

    if (added.includes('slot')) {
      // While others listen the last read is at most one interval old: send it now instead of waiting.
      const last = this.lastSlot;
      if (last && this.now() - last.at < 2 * this.options.slotIntervalMs) {
        this.sendFrame(client, 'slot', last.update, last.at);
      }
      this.updateSlotPolling();
    }
    for (const channel of PROVIDER_CHANNELS) {
      if (added.includes(channel)) void this.sendCurrent(client, channel);
    }
    if (added.includes('index:live')) void this.sendFeedCurrent(client, 'index:live');
  }

  private async sendFeedCurrent(client: Client, channel: FeedChannel): Promise<void> {
    const feed = this.feeds.get(channel);
    if (!feed) return;
    if (feed.last && this.now() - feed.last.at < 60_000) {
      this.sendFrame(client, channel, feed.last.data, feed.last.at);
      return;
    }
    if (!feed.snapshot) return;
    try {
      const data = await feed.snapshot();
      if (client.channels.has(channel)) this.sendFrame(client, channel, data);
    } catch (error) {
      this.send(client, { type: 'error', channel, message: errorMessage(error) });
    }
  }

  private unsubscribeClient(client: Client, names: readonly string[]): void {
    const hadSlot = client.channels.has('slot');
    for (const name of names) {
      if (!isFixedChannel(name) && name.includes(':')) {
        const channel = this.topicChannel(name);
        client.topics.delete((channel ?? name) as StreamTopicChannel);
      } else {
        client.channels.delete(name as StreamChannel);
      }
    }
    this.send(client, { type: 'subscribed', channels: this.subscribedNames(client) });
    if (hadSlot && !client.channels.has('slot')) this.updateSlotPolling();
  }

  // ── Sending ──────────────────────────────────────────────────────────────────────────────────────

  private send(client: Client, message: StreamServerMessage): void {
    this.sendRaw(client, JSON.stringify(message));
  }

  private async sendTopicSnapshot(client: Client, channel: StreamTopicChannel): Promise<void> {
    const at = channel.indexOf(':');
    const topic = this.topics.get(channel.slice(0, at));
    if (!topic?.snapshot) return;
    try {
      const data = await topic.snapshot(channel.slice(at + 1));
      if (client.topics.has(channel)) this.sendFrame(client, channel, data);
    } catch (error) {
      this.send(client, { type: 'error', channel, message: errorMessage(error) });
    }
  }

  /** `at`: when the data was read (epoch ms); default now. */
  private sendFrame(client: Client, channel: StreamChannel | StreamTopicChannel, data: unknown, at = this.now()): void {
    const frame: StreamFrame = { channel, data, at: isoIst(new Date(at)) };
    this.sendRaw(client, JSON.stringify(frame));
  }

  private sendRaw(client: Client, text: string): void {
    const { socket } = client;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      logger.warn('closing a websocket that stopped reading', { bufferedBytes: socket.bufferedAmount });
      socket.terminate();
      this.drop(client);
      return;
    }
    socket.send(text);
  }

  private broadcast(channel: StreamChannel, data: unknown): void {
    const frame: StreamFrame = { channel, data, at: isoIst(new Date(this.now())) };
    const text = JSON.stringify(frame);
    for (const client of this.clients) if (client.channels.has(channel)) this.sendRaw(client, text);
  }

  private subscribers(channel: StreamChannel): number {
    let n = 0;
    for (const client of this.clients) if (client.channels.has(channel)) n++;
    return n;
  }

  // ── activity, vault, feeIndex ────────────────────────────────────────────────────────────────────

  private onProgramEvent(event: StoredProgramEvent): void {
    if (VAULT_EVENTS.has(event.name)) {
      this.invalidate('vault');
      if (this.providers.vault) this.pushers.vault.trigger();
    }
    if (FEE_INDEX_EVENTS.has(event.name)) {
      this.invalidate('feeIndex');
      if (this.providers.feeIndex) this.pushers.feeIndex.trigger();
    }
    const age = event.blockTime ? this.now() - Date.parse(event.blockTime) : 0;
    if (age > (this.options.activityMaxAgeMs ?? 600_000)) return;
    // One at a time, so rows go out in the order the ingester announced them.
    this.activityQueue = this.activityQueue
      .then(async () => {
        if (this.subscribers('activity') === 0) return;
        const row = await this.options.activity.fromProgramEvent(event);
        if (row) this.broadcast('activity', row);
      })
      .catch((error: unknown) => logger.warn('activity row failed', { name: event.name, error: String(error) }));
  }

  private onPredictCall(call: PredictCallEvent): void {
    this.activityQueue = this.activityQueue
      .then(() => {
        if (this.subscribers('activity') > 0) this.broadcast('activity', this.options.activity.fromPredictCall(call));
      })
      .catch((error: unknown) => logger.warn('predict activity row failed', { error: String(error) }));
  }

  private invalidate(channel: ProviderChannel): void {
    this.generation[channel]++;
  }

  /** The channel's value: cached when no event changed it since (and young), else one shared provider read. */
  private current(channel: ProviderChannel): Promise<unknown> {
    const generation = this.generation[channel];
    const cached = this.cached.get(channel);
    if (cached && cached.generation === generation && this.now() - cached.at < PROVIDER_VALUE_MAX_AGE_MS) {
      return Promise.resolve(cached.data);
    }
    const running = this.inflight.get(channel);
    if (running && running.generation === generation) return running.promise;
    const provider = this.providers[channel];
    if (!provider) return Promise.reject(new Error(`the ${channel} channel has no provider`));
    const promise = provider()
      .then((data) => {
        if (this.generation[channel] === generation) this.cached.set(channel, { data, at: this.now(), generation });
        return data;
      })
      .finally(() => {
        if (this.inflight.get(channel)?.promise === promise) this.inflight.delete(channel);
      });
    this.inflight.set(channel, { promise, generation });
    return promise;
  }

  private async sendCurrent(client: Client, channel: ProviderChannel): Promise<void> {
    try {
      const data = await this.current(channel);
      if (client.channels.has(channel)) this.sendFrame(client, channel, data, this.cached.get(channel)?.at);
    } catch (error) {
      this.send(client, { type: 'error', channel, message: errorMessage(error) });
    }
  }

  private async pushAll(channel: ProviderChannel): Promise<void> {
    if (this.subscribers(channel) === 0) return;
    try {
      this.broadcast(channel, await this.current(channel));
    } catch (error) {
      logger.warn('stream push failed', { channel, error: errorMessage(error) });
    }
  }

  // ── slot ─────────────────────────────────────────────────────────────────────────────────────────

  private updateSlotPolling(): void {
    const wanted = this.options.slots !== undefined && this.subscribers('slot') > 0;
    // The feed stays subscribed once used: its stream is shared (program events) and reconnecting it costs more.
    if (wanted && this.options.slotFeed && !this.feedOff) {
      this.feedOff = this.options.slotFeed.onSlot((slot) => void this.onFeedSlot(slot));
    }
    if (wanted && !this.slotTimer) {
      this.slotTimer = setInterval(() => void this.slotTick(), this.options.slotIntervalMs);
      this.slotTimer.unref();
      void this.slotTick();
    } else if (!wanted) {
      this.stopSlotPolling();
    }
  }

  private stopSlotPolling(): void {
    clearInterval(this.slotTimer);
    this.slotTimer = undefined;
  }

  private async slotTick(): Promise<void> {
    const slots = this.options.slots;
    if (!slots || this.slotBusy) return;
    if (this.feedFresh()) {
      // Solami gRPC is pushing slots: only keep the epoch info (epoch, slot index) fresh.
      if (!this.epochInfo || this.now() - this.epochInfo.at > EPOCH_INFO_MAX_AGE_MS) await this.refreshEpochInfo(slots);
      return;
    }
    this.slotBusy = true;
    try {
      const info = await slots.getEpochInfo();
      this.epochInfo = { info, at: this.now() };
      if (this.lastSlot?.update.slot === info.absoluteSlot) {
        this.lastSlot.at = this.now();
        return;
      }
      const leader = await this.leaderOf(slots, info.absoluteSlot);
      const names = leader && this.options.names ? await this.options.names().catch(() => EMPTY_NAMES) : EMPTY_NAMES;
      const update: SlotUpdate = {
        slot: info.absoluteSlot,
        epoch: info.epoch,
        slotIndex: info.slotIndex,
        slotsInEpoch: info.slotsInEpoch,
        leader,
        leaderName: leader ? (names.byIdentity.get(leader) ?? null) : null,
        source: 'rpc',
      };
      // A slower poll can finish after a pushed slot: never send the channel backwards.
      if (this.lastSlot && update.slot <= this.lastSlot.update.slot) return;
      this.lastSlot = { update, at: this.now() };
      this.broadcast('slot', update);
    } catch (error) {
      if (this.now() - this.lastSlotErrorLog > ERROR_LOG_INTERVAL_MS) {
        this.lastSlotErrorLog = this.now();
        logger.warn('slot poll failed', { error: errorMessage(error) });
      }
    } finally {
      this.slotBusy = false;
    }
  }

  /** True while the feed has pushed a slot recently (then the poll stands by). */
  private feedFresh(): boolean {
    return (
      this.options.slotFeed !== undefined &&
      this.now() - this.lastFeedAt <
        Math.max(this.options.slotFeedQuietMs ?? FEED_QUIET_MS, 2 * this.options.slotIntervalMs)
    );
  }

  /** A slot pushed by the feed: placed in its epoch from the last epoch info, named, and sent at once. */
  private async onFeedSlot(slot: number): Promise<void> {
    this.lastFeedAt = this.now();
    const slots = this.options.slots;
    if (!slots || this.subscribers('slot') === 0) return;
    const stale = () => this.lastSlot !== undefined && slot <= this.lastSlot.update.slot;
    if (stale()) return;
    const position = this.slotPosition(slot);
    if (!position) {
      void this.refreshEpochInfo(slots);
      return;
    }
    const leader = await this.leaderOf(slots, slot);
    const names = leader && this.options.names ? await this.options.names().catch(() => EMPTY_NAMES) : EMPTY_NAMES;
    if (stale()) return;
    const update: SlotUpdate = {
      slot,
      ...position,
      leader,
      leaderName: leader ? (names.byIdentity.get(leader) ?? null) : null,
      source: 'grpc',
    };
    this.lastSlot = { update, at: this.now() };
    this.broadcast('slot', update);
  }

  /** Epoch and slot index of `slot` from the last epoch info (null before one is read, or for an older slot). */
  private slotPosition(slot: number): { epoch: number; slotIndex: number; slotsInEpoch: number } | null {
    const info = this.epochInfo?.info;
    if (!info) return null;
    const offset = slot - (info.absoluteSlot - info.slotIndex);
    if (offset < 0) return null;
    // Mainnet epochs have a fixed length: a slot past the end belongs to the next epoch (re-read soon after).
    const epochs = Math.floor(offset / info.slotsInEpoch);
    if (epochs > 0 && this.epochInfo) this.epochInfo.at = 0;
    return { epoch: info.epoch + epochs, slotIndex: offset % info.slotsInEpoch, slotsInEpoch: info.slotsInEpoch };
  }

  private async refreshEpochInfo(slots: SlotSource): Promise<void> {
    if (this.epochInfoBusy) return;
    this.epochInfoBusy = true;
    try {
      this.epochInfo = { info: await slots.getEpochInfo(), at: this.now() };
    } catch (error) {
      if (this.now() - this.lastSlotErrorLog > ERROR_LOG_INTERVAL_MS) {
        this.lastSlotErrorLog = this.now();
        logger.warn('epoch info read failed', { error: errorMessage(error) });
      }
    } finally {
      this.epochInfoBusy = false;
    }
  }

  /** The slot's leader from the cached schedule, read 100 slots at a time when the cache runs out. */
  private async leaderOf(slots: SlotSource, slot: number): Promise<string | null> {
    const cached = this.leaders;
    if (cached && slot >= cached.start && slot < cached.start + cached.identities.length) {
      return cached.identities[slot - cached.start];
    }
    try {
      const identities = await slots.getSlotLeaders(slot, LEADER_BATCH);
      if (identities.length === 0) return null;
      this.leaders = { start: slot, identities };
      return identities[0];
    } catch (error) {
      logger.debug('slot leaders unavailable', { error: errorMessage(error) });
      return null;
    }
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
