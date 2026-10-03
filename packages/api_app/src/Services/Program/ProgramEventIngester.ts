import { GracefulShutdown, sleep } from '@epoch/common';
import { type EventName, eventToJson, parseEventsFromLogs } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type PublicKey } from '@solana/web3.js';

import { type EventBus, type StoredProgramEvent } from '../../Lib/EventBus';
import {
  type IngestRpc,
  isRateLimited,
  type LogsNotification,
  RpcAnswerError,
  type SignatureInfo,
} from '../../Sources/ProgramLogsSource';
import { type EventCursor, type ProgramEventStore } from './ProgramEventStore';

const logger = Logger.create('ProgramEventIngester');

export interface ProgramEventIngesterOptions {
  /** Unset → ingestion stays off (EPOCH_PROGRAM_ID is not set). */
  programId?: PublicKey;
  /** PROGRAM_EVENTS_INGEST. */
  enabled: boolean;
  rpc?: IngestRpc;
  store: ProgramEventStore;
  bus: EventBus;
  /** The program cluster's epoch of a slot (EpochProgramSource.epochOfSlot). */
  epochOfSlot: (slot: number) => Promise<number>;
  /** Drops the cached account reads an event makes stale (EpochProgramSource.invalidateFor). */
  invalidate: (name: EventName) => void;
  /** PROGRAM_EVENTS_BACKFILL_LIMIT: the most transactions to read on a first start (no cursor yet); 0 = none. */
  backfillLimit: number;
  /** Catch-up poll interval. Default 60 s. */
  pollIntervalMs?: number;
  /** Parallel getTransaction calls. Default 2. */
  concurrency?: number;
  /** getSignaturesForAddress page size (the RPC's maximum is 1,000). */
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Passes a transaction the RPC can't return (null, or a JSON-RPC error about it) may hold the cursor before it is
 * skipped: a few minutes for a lagging node, never forever.
 */
const MISSING_TX_RUNS = 3;
const RATE_LIMIT_RETRIES = 6;
const OTHER_RETRIES = 2;
/** Signatures the websocket delivered (and stored), so a poll doesn't read them again. */
const LIVE_SEEN_CAPACITY = 5_000;
/** A transaction older than this that only the poll found means the websocket went quiet: resubscribe. */
const LIVE_GRACE_MS = 30_000;

export const cursorName = (programId: PublicKey): string => `program_events:${programId.toBase58()}`;

/**
 * Reads the Epoch program's events into program_events (ProgramEventStore) and announces each new one: the program's
 * caches drop what it makes stale (`invalidateFor`) and the bus emits `programEvent` (activity, websocket, recorder).
 *
 * - **Backfill / catch-up** (at start, then every `pollIntervalMs`): getSignaturesForAddress pages back to the cursor
 *   (`program_events:<programId>`: every transaction up to it has been read), or `backfillLimit` signatures on a
 *   first start; then getTransaction oldest first, `concurrency` at a time, with backoff on 429. Failed transactions
 *   are skipped; the cursor advances after each batch, so a restart resumes where it stopped.
 * - **Live**: logsSubscribe at `confirmed` through the dedicated websocket; failed transactions skipped, logs parsed
 *   directly (block time = arrival time). Live events never move the cursor: the next poll still walks every
 *   signature after it, so a dropped websocket loses nothing, and the store's (signature, ix) key dedupes.
 * Only `Program data:` lines written while the Epoch program is the innermost frame count (epoch-sdk
 * `parseEventsFromLogs`), so other programs' events in the same transaction are ignored.
 */
export class ProgramEventIngester {
  /** Between start() and stop(). */
  private active = false;
  /** stop() was called: passes and retries end at the next step. */
  private halted = false;
  private shutdownRegistered = false;
  private timer?: NodeJS.Timeout;
  private resubscribeTimer?: NodeJS.Timeout;
  private subscription?: number;
  private subscribedAt = 0;
  private subscribeFailures = 0;
  private running?: Promise<number>;
  private liveQueue: Promise<void> = Promise.resolve();
  private readonly liveSeen = new Set<string>();
  private readonly missing = new Map<string, number>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: ProgramEventIngesterOptions) {
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
  }

  get cursorName(): string | undefined {
    return this.options.programId ? cursorName(this.options.programId) : undefined;
  }

  /** True between start() and stop(). */
  get started(): boolean {
    return this.active;
  }

  start(): void {
    const { programId, rpc, enabled } = this.options;
    if (!enabled) {
      logger.info('program event ingestion off (PROGRAM_EVENTS_INGEST=false)');
      return;
    }
    if (!programId || !rpc) {
      logger.info('program event ingestion off: EPOCH_PROGRAM_ID is not set');
      return;
    }
    if (this.active) return;
    this.active = true;
    this.halted = false;
    logger.info('program event ingestion starting', { programId: programId.toBase58() });
    this.subscribe();
    void this.poll(); // the backfill
    this.timer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? 60_000);
    this.timer.unref();
    if (!this.shutdownRegistered) GracefulShutdown.register('program-event-ingester', () => this.stop());
    this.shutdownRegistered = true;
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.halted = true;
    clearInterval(this.timer);
    clearTimeout(this.resubscribeTimer);
    this.timer = undefined;
    const id = this.subscription;
    this.subscription = undefined;
    if (id !== undefined) await this.options.rpc?.removeOnLogsListener(id).catch(() => undefined);
    await this.idle();
  }

  /** Resolves when the pass in flight and the queued live events are done. */
  async idle(): Promise<void> {
    await this.running?.catch(() => 0);
    await this.liveQueue;
  }

  /**
   * One backfill / catch-up pass (passes never overlap: a call during a pass joins it). Returns how many
   * transactions it read; throws when the RPC keeps failing (the cursor stays at the last finished batch).
   */
  catchUp(): Promise<number> {
    this.running ??= this.runCatchUp().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async poll(): Promise<void> {
    try {
      await this.catchUp();
    } catch (error) {
      logger.warn('program event catch-up failed; retrying on the next poll', { error: String(error) });
    }
  }

  private async runCatchUp(): Promise<number> {
    const { programId, rpc } = this.require();
    const name = cursorName(programId);
    const cursor = await this.options.store.getCursor(name);
    if (!cursor && this.options.backfillLimit === 0) {
      // No history wanted: start after the newest transaction.
      const [newest] = await this.call(() => rpc.getSignaturesForAddress(programId, { limit: 1 }));
      await this.options.store.setCursor(name, newest ? toCursor(newest) : { slot: 0, signature: null });
      return 0;
    }

    const signatures = await this.collect(programId, rpc, cursor);
    if (signatures.length === 0) {
      // Nothing yet: every later transaction is new.
      if (!cursor) await this.options.store.setCursor(name, { slot: 0, signature: null });
      return 0;
    }

    const ordered = signatures.reverse(); // oldest first
    const now = this.now();
    let read = 0;
    let missedLive = 0;
    const concurrency = Math.max(1, this.options.concurrency ?? 2);
    for (let start = 0; start < ordered.length && !this.halted; start += concurrency) {
      const batch = ordered.slice(start, start + concurrency);
      for (const info of batch) if (this.missedByWebsocket(info, now)) missedLive++;
      const results = await Promise.all(batch.map((info) => this.read(programId, rpc, info)));
      let last: SignatureInfo | undefined;
      for (const [i, result] of results.entries()) {
        if (result === 'missing') {
          // Not readable yet: keep the cursor before it so the next pass tries again.
          if (last) await this.options.store.setCursor(name, toCursor(last));
          return read;
        }
        await this.publish(result);
        last = batch[i];
        read++;
      }
      if (last) await this.options.store.setCursor(name, toCursor(last));
    }
    if (missedLive > 0 && this.subscription !== undefined && this.active) {
      await this.resubscribe(`${missedLive} transaction(s) reached the poll but not the websocket`);
    }
    return read;
  }

  /** Signatures after the cursor (or the newest `backfillLimit` without one), newest first. */
  private async collect(programId: PublicKey, rpc: IngestRpc, cursor: EventCursor | null): Promise<SignatureInfo[]> {
    const pageSize = Math.min(1_000, Math.max(1, this.options.pageSize ?? 1_000));
    const max = cursor ? Number.POSITIVE_INFINITY : this.options.backfillLimit;
    const until = cursor?.signature ?? undefined;
    const out: SignatureInfo[] = [];
    let before: string | undefined;
    while (out.length < max && !this.halted) {
      const limit = Math.min(pageSize, max - out.length);
      const page = await this.call(() => rpc.getSignaturesForAddress(programId, { before, until, limit }));
      // `until` stops at the cursor; the slot check also stops if that signature is gone (a dropped fork).
      const fresh = cursor ? page.filter((s) => s.slot >= cursor.slot && s.signature !== cursor.signature) : page;
      out.push(...fresh);
      if (page.length < limit || fresh.length < page.length) break;
      before = page[page.length - 1].signature;
    }
    return out;
  }

  /** The transaction's events, [] for a failed or already-delivered one, 'missing' while the RPC can't find it. */
  private async read(
    programId: PublicKey,
    rpc: IngestRpc,
    info: SignatureInfo,
  ): Promise<StoredProgramEvent[] | 'missing'> {
    if (info.err || this.liveSeen.has(info.signature)) return [];
    let tx: Awaited<ReturnType<IngestRpc['getTransaction']>>;
    try {
      tx = await this.call(() => rpc.getTransaction(info.signature));
    } catch (error) {
      // Transport failures and 429s fail the pass (retried next poll); an answer about this transaction is counted.
      if (!(error instanceof RpcAnswerError)) throw error;
      return this.unreadable(info, error.message);
    }
    if (!tx) return this.unreadable(info, 'not found');
    this.missing.delete(info.signature);
    if (!tx.meta || tx.meta.err) return [];
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1_000).toISOString() : null;
    return this.toStored(programId, info.signature, tx.slot, blockTime, tx.meta.logMessages ?? []);
  }

  /** 'missing' for the first passes, then [] (skipped, logged as an error). */
  private unreadable(info: SignatureInfo, reason: string): 'missing' | [] {
    const runs = (this.missing.get(info.signature) ?? 0) + 1;
    if (runs < MISSING_TX_RUNS) {
      this.missing.set(info.signature, runs);
      return 'missing';
    }
    this.missing.delete(info.signature);
    logger.error('transaction listed for the program could not be read; skipping it', undefined, {
      signature: info.signature,
      slot: info.slot,
      reason,
    });
    return [];
  }

  private async toStored(
    programId: PublicKey,
    signature: string,
    slot: number,
    blockTime: string | null,
    logs: readonly string[],
  ): Promise<StoredProgramEvent[]> {
    let events: ReturnType<typeof parseEventsFromLogs>;
    try {
      events = parseEventsFromLogs(logs, programId);
    } catch (error) {
      logger.error('program event did not decode; skipping its transaction', error, { signature });
      return [];
    }
    if (events.length === 0) return [];
    const epoch = await this.options.epochOfSlot(slot).catch(() => null);
    return events.map((event, ix) => ({
      signature,
      ix,
      slot,
      epoch,
      blockTime,
      name: event.name,
      data: eventToJson(event).data,
    }));
  }

  /** Stores the events and announces the new ones (insert returns only rows it had not seen). */
  private async publish(events: readonly StoredProgramEvent[]): Promise<void> {
    if (events.length === 0) return;
    const fresh = await this.options.store.insert(events);
    for (const event of fresh) {
      this.options.invalidate(event.name);
      try {
        this.options.bus.emit('programEvent', event);
      } catch (error) {
        logger.error('a programEvent listener failed', error, { name: event.name, signature: event.signature });
      }
    }
  }

  private subscribe(): void {
    const { programId, rpc } = this.require();
    if (!this.active) return;
    try {
      this.subscription = rpc.onLogs(programId, (notification, context) => this.onLogs(notification, context));
      this.subscribedAt = this.now();
      this.subscribeFailures = 0;
    } catch (error) {
      this.subscribeFailures++;
      const delayMs = Math.min(60_000, 5_000 * 2 ** (this.subscribeFailures - 1));
      logger.warn('program logs subscription failed; retrying', { delayMs, error: String(error) });
      this.resubscribeTimer = setTimeout(() => this.subscribe(), delayMs);
      this.resubscribeTimer.unref();
    }
  }

  private async resubscribe(reason: string): Promise<void> {
    logger.warn('resubscribing to program logs', { reason });
    const id = this.subscription;
    this.subscription = undefined;
    if (id !== undefined) {
      await this.options.rpc
        ?.removeOnLogsListener(id)
        .catch((error: unknown) => logger.debug('removing the old logs listener failed', { error: String(error) }));
    }
    this.options.rpc?.reconnect?.();
    this.subscribe();
  }

  private onLogs(notification: LogsNotification, context: { slot: number }): void {
    if (this.halted) return;
    if (notification.err) {
      this.markSeen(notification.signature);
      return;
    }
    const { programId } = this.require();
    const receivedAt = new Date(this.now()).toISOString();
    this.liveQueue = this.liveQueue
      .then(async () => {
        const events = await this.toStored(
          programId,
          notification.signature,
          context.slot,
          receivedAt,
          notification.logs,
        );
        await this.publish(events);
        // Only once stored: a failed insert leaves it to the next poll.
        this.markSeen(notification.signature);
      })
      .catch((error: unknown) =>
        logger.warn('live program event failed; the next poll reads it', {
          signature: notification.signature,
          error: String(error),
        }),
      );
  }

  private markSeen(signature: string): void {
    this.liveSeen.add(signature);
    if (this.liveSeen.size > LIVE_SEEN_CAPACITY) {
      const oldest = this.liveSeen.values().next().value;
      if (oldest !== undefined) this.liveSeen.delete(oldest);
    }
  }

  /** A transaction the websocket should have delivered by now (it landed after we subscribed) but did not. */
  private missedByWebsocket(info: SignatureInfo, now: number): boolean {
    if (this.subscription === undefined || !info.blockTime || this.liveSeen.has(info.signature)) return false;
    const at = info.blockTime * 1_000;
    return at > this.subscribedAt + 5_000 && at < now - LIVE_GRACE_MS;
  }

  /** Retries with backoff: longer and more often for HTTP 429. */
  private async call<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        const limited = isRateLimited(error);
        const retries = limited ? RATE_LIMIT_RETRIES : error instanceof RpcAnswerError ? 0 : OTHER_RETRIES;
        if (this.halted || attempt >= retries) throw error;
        const delayMs = limited ? Math.min(30_000, 1_000 * 2 ** attempt) : 500 * 2 ** attempt;
        if (limited) logger.debug('program RPC rate limited; backing off', { delayMs });
        await this.sleep(delayMs);
      }
    }
  }

  private require(): { programId: PublicKey; rpc: IngestRpc } {
    const { programId, rpc } = this.options;
    if (!programId || !rpc) throw new Error('ProgramEventIngester needs a program id and an RPC');
    return { programId, rpc };
  }
}

const toCursor = (info: SignatureInfo): EventCursor => ({ slot: info.slot, signature: info.signature });
