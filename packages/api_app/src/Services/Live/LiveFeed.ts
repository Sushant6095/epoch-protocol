import { Logger } from '@epoch/logger';
import { decodeLivePayload, LIVE_NOTIFY_CHANNEL, type LivePayload, PgListener } from '@epoch/pg_models';

import { type FeedChannel } from '../Stream/StreamHub';
import { type LiveService } from './LiveService';

const logger = Logger.create('LiveFeed');

/** What the feed needs from the hub. */
export interface FeedHub {
  setFeed(channel: FeedChannel, snapshot?: () => Promise<unknown>): void;
  publish(channel: FeedChannel, data: unknown): void;
}

/** What the feed needs from a LISTEN connection (PgListener, or a fake in tests). */
export interface FeedListener {
  start(): void;
  stop(): Promise<void>;
}

export interface LiveFeedOptions {
  hub: FeedHub;
  service: Pick<LiveService, 'summary' | 'slotFromPayload'>;
  /** Builds the LISTEN connection with the two callbacks. Default: PgListener on DATABASE_URL. */
  listen?: (onNotification: (payload: string | undefined) => void, onState: (on: boolean) => void) => FeedListener;
  /** `index:live` frames at most this often (they carry the whole summary). Default 1 s. */
  indexThrottleMs?: number;
  now?: () => number;
}

/**
 * Fans the indexer's Postgres NOTIFY feed out on WS /v1/stream: every block as a `slots` frame (with the leader's
 * name), and the running estimate as an `index:live` frame (the same LiveSummary as GET /v1/live/summary, so the page
 * renders both with one component). A dedicated LISTEN connection reconnects by itself; after a reconnect the current
 * summary is pushed again, since notifications sent meanwhile are gone.
 */
export class LiveFeed {
  private listener?: FeedListener;
  private lastIndexPush = 0;
  private indexTimer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: LiveFeedOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    const { hub, service } = this.options;
    hub.setFeed('slots');
    hub.setFeed('index:live', () => service.summary());
    const listen =
      this.options.listen ??
      ((onNotification, onState) =>
        new PgListener({ channel: LIVE_NOTIFY_CHANNEL, onNotification, onState }) as FeedListener);
    this.listener = listen(
      (payload) => this.onNotification(payload),
      (on) => {
        if (on) this.pushIndex(true);
      },
    );
    this.listener.start();
    logger.info('live feed started', { channel: LIVE_NOTIFY_CHANNEL, wsChannels: ['slots', 'index:live'] });
  }

  async stop(): Promise<void> {
    clearTimeout(this.indexTimer);
    await this.listener?.stop();
  }

  onNotification(text: string | undefined): void {
    const payload = decodeLivePayload(text);
    if (!payload) {
      logger.debug('ignored a notification that is not a live payload');
      return;
    }
    this.handle(payload);
  }

  private handle(payload: LivePayload): void {
    if (payload.t === 'slot') {
      // In order, one at a time (naming a leader may wait briefly for the validator table).
      this.queue = this.queue
        .then(async () => this.options.hub.publish('slots', await this.options.service.slotFromPayload(payload)))
        .catch((error: unknown) => logger.warn('slots frame failed', { error: String(error) }));
      return;
    }
    this.pushIndex(payload.t === 'epoch');
  }

  /** The summary as an `index:live` frame, throttled (an epoch rollup or a reconnect goes out at once). */
  private pushIndex(immediate: boolean): void {
    const throttle = this.options.indexThrottleMs ?? 1_000;
    const wait = immediate ? 0 : Math.max(0, this.lastIndexPush + throttle - this.now());
    if (this.indexTimer && !immediate) return;
    clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      this.lastIndexPush = this.now();
      this.options.service
        .summary()
        .then((summary) => this.options.hub.publish('index:live', summary))
        .catch((error: unknown) => logger.warn('index:live frame failed', { error: String(error) }));
    }, wait);
    this.indexTimer.unref?.();
  }
}
