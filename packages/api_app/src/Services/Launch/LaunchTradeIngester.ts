import { GracefulShutdown } from '@epoch/common';
import { Logger } from '@epoch/logger';
import {
  decodeMeteoraEvents,
  launchFeeEventsFromTransaction,
  launchTradesFromTransaction,
  normalizeTransaction,
  type TradePoolInfo,
} from '@epoch/meteora';

import { isRateLimited } from '../../Sources/ProgramLogsSource';
import { type LaunchLiveChain, type PoolSignature } from './LaunchLiveChain';
import { type LaunchFeedMode, type LaunchRealtimeSource, type RealtimeTransaction } from './LaunchRealtime';
import { type LaunchTradeStore, type StoredLaunchFeeEvent, type StoredLaunchTrade } from './LaunchTradeStore';

const logger = Logger.create('LaunchTradeIngester');

/** A pool the ingester reads: the curve, and the DAMM v2 pool once the token graduated. */
export interface WatchedPool {
  address: string;
  info: TradePoolInfo;
}

/** A launch and its pools as the ingester sees them now. */
export interface IngestLaunch {
  mint: string;
  symbol: string;
  pools: WatchedPool[];
}

export interface LaunchTradeIngesterOptions {
  chain: Pick<LaunchLiveChain, 'signatures' | 'transaction'>;
  store: LaunchTradeStore;
  /** The launches to read (the registry on LAUNCH_CLUSTER) with their pools. */
  launches: () => Promise<IngestLaunch[]>;
  pollMs: number;
  /** Signatures read back per pool on a first start (no cursor yet); 0 = start from the newest. */
  backfillLimit: number;
  enabled: boolean;
  onTrades?: (mint: string, trades: StoredLaunchTrade[]) => void;
  onFeeEvents?: (mint: string, events: StoredLaunchFeeEvent[]) => void;
  /** Pushes the pools' transactions as they land (gRPC or websocket); polling stays as the backstop. */
  realtime?: LaunchRealtimeSource | null;
  /** The polling interval while the realtime source is healthy. Default 60 s (never below `pollMs`). */
  backstopMs?: number;
  now?: () => number;
  /** Tests: waits between fetch attempts of a pushed transaction. */
  sleep?: (ms: number) => Promise<void>;
}

/** The trade feed's state for one launch, for the page's `ingest` block. */
export interface LaunchFeedStatus {
  mode: LaunchFeedMode;
  /**
   * From the block time of the newest stored trade or fee event to when it was stored; null before any. A first start's
   * backfill is history, not lag, and does not count.
   */
  lagSeconds: number | null;
  /** How often the pools are polled now (slower while the realtime source is healthy). */
  pollSeconds: number;
}

/** Transactions per getTransaction batch. */
const CONCURRENCY = 2;
const PAGE = 1_000;
/** A transaction the RPC lists but cannot return holds the cursor this many polls, then is skipped. */
const MAX_MISSING_POLLS = 3;
const MAX_BACKOFF_MS = 60_000;
/** A pushed signature whose transaction the RPC cannot return yet is asked for this many times, then left to polling. */
const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_MS = 750;
/** Signatures already read (pushed or polled), so neither path fetches a transaction twice. */
const SEEN_CAPACITY = 20_000;

export const cursorName = (pool: string): string => `launch_trades:${pool}`;

/** The RPC's answer when a `before`/`until` signature is not in its history: "Transaction <signature> not found". */
const isMissingSignature = (error: unknown, signature: string): boolean => {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return message.includes(signature) && /not found/i.test(message);
};

/**
 * Reads every launch pool's transactions into launch_trades and launch_fee_events: on a first start the newest
 * `backfillLimit` signatures of each pool, then every `pollMs` the ones after the pool's cursor
 * (`indexer_cursors.name = launch_trades:<pool>`: every transaction up to it has been read), oldest first. Swap events
 * become trades, claim and graduation events fee events (`@epoch/meteora` decoders); a curve's graduation adds its
 * DAMM v2 pool to the watch list. Failed transactions are skipped; (signature, ix) dedupes, so a transaction read
 * through both pools (the migration) is stored once. HTTP 429 backs off up to a minute. When the node no longer has a
 * cursor's transaction (it trimmed its history), the pool is read back to the cursor's slot.
 *
 * With a realtime source (Yellowstone gRPC on the pools, or the RPC websocket's logsSubscribe per pool), each pushed
 * transaction is decoded and stored as it lands, and polling slows to `backstopMs` while the source is healthy (it
 * speeds back up at once when the source goes down). Both paths share the decoder and the (signature, ix) dedupe, and a
 * signature read by one is not fetched again by the other.
 */
export class LaunchTradeIngester {
  private timer?: NodeJS.Timeout;
  private started = false;
  private running?: Promise<void>;
  /** Pushed transactions, handled one at a time in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  /** Each watched pool's launch, and that launch's pools, as of the last pass. */
  private readonly routes = new Map<string, { launch: IngestLaunch; pools: WatchedPool[] }>();
  private readonly seen = new Set<string>();
  /** Feed lag of the newest stored row, by mint (ms). */
  private readonly lagMs = new Map<string, number>();
  private readonly backstopMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private backoffMs = 0;
  private skipUntil = 0;
  private readonly lastPollAt = new Map<string, number>();
  private readonly missing = new Map<string, number>();
  /** DAMM v2 pools learned from graduation events, by mint. */
  private readonly graduated = new Map<string, string>();
  /** Per pool, a cursor signature the node no longer has (trimmed history). */
  private readonly trimmedCursors = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: LaunchTradeIngesterOptions) {
    this.now = options.now ?? Date.now;
    this.backstopMs = Math.max(options.pollMs, options.backstopMs ?? 60_000);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** When this launch's pools were last read successfully (epoch ms), or null. */
  lastPoll(mint: string): number | null {
    return this.lastPollAt.get(mint) ?? null;
  }

  /** The DAMM v2 pool a graduation event named for this mint, if one was seen. */
  graduatedPool(mint: string): string | null {
    return this.graduated.get(mint) ?? null;
  }

  /** The feed's mode: the realtime source's while it is healthy, else polling. */
  get mode(): LaunchFeedMode {
    const realtime = this.options.realtime;
    return realtime && realtime.healthy() ? realtime.mode : 'polling';
  }

  /** The polling interval now: the backstop while the realtime source is healthy. */
  pollDelayMs(): number {
    return this.options.realtime?.healthy() ? this.backstopMs : this.options.pollMs;
  }

  feedStatus(mint: string): LaunchFeedStatus {
    const lag = this.lagMs.get(mint);
    return {
      mode: this.mode,
      lagSeconds: lag === undefined ? null : Math.round(lag / 100) / 10,
      pollSeconds: this.pollDelayMs() / 1000,
    };
  }

  start(): void {
    if (!this.options.enabled || this.started) return;
    this.started = true;
    const realtime = this.options.realtime;
    realtime?.start(
      (tx) => this.push(tx),
      (healthy) => {
        logger.info('launch realtime feed', { mode: realtime.mode, healthy });
        // Down: poll now and at the normal pace until it is back.
        if (!healthy) this.schedule(0);
      },
    );
    this.schedule(2_000);
    GracefulShutdown.register('launch-trade-ingester', () => this.stop());
    logger.info('launch trade ingester started', {
      realtime: realtime?.mode ?? 'off',
      everySeconds: this.options.pollMs / 1000,
      backstopSeconds: realtime ? this.backstopMs / 1000 : undefined,
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.options.realtime?.stop();
    await this.running;
    await this.queue;
  }

  /** Queues a pushed transaction (handled in arrival order). Never throws. */
  push(tx: RealtimeTransaction): Promise<void> {
    this.queue = this.queue.then(() =>
      this.ingestPushed(tx).catch((error: unknown) =>
        logger.warn('pushed transaction not read; polling will', { signature: tx.signature, error: String(error) }),
      ),
    );
    return this.queue;
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedule(this.pollDelayMs()));
    }, ms);
    this.timer.unref();
  }

  private remember(signature: string): void {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > SEEN_CAPACITY) this.seen.delete(this.seen.values().next().value as string);
  }

  /** A pushed transaction: fetched when the source did not carry it, then decoded and stored like a polled one. */
  private async ingestPushed(tx: RealtimeTransaction): Promise<void> {
    if (this.seen.has(tx.signature)) return;
    if (tx.failed) {
      this.remember(tx.signature);
      return;
    }
    const route = tx.pools.map((pool) => this.routes.get(pool)).find((found) => found !== undefined);
    if (!route) return;
    let raw = tx.raw;
    for (let attempt = 0; raw === null && attempt < FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(FETCH_RETRY_MS);
      raw = await this.options.chain.transaction(tx.signature);
    }
    // Not returned yet: the polling backstop reads it.
    if (raw === null) return;
    const sig: PoolSignature = { signature: tx.signature, slot: tx.slot, err: null, blockTime: null };
    await this.storeDecoded(route.launch, [this.decodeFor(route.launch, route.pools, raw, sig)]);
    this.remember(tx.signature);
  }

  /** One pass over every launch (skipped while backing off, or while the previous pass runs). Never throws. */
  async pollOnce(): Promise<{ trades: number; feeEvents: number }> {
    const totals = { trades: 0, feeEvents: 0 };
    if (this.running || this.now() < this.skipUntil) return totals;
    const pass = (async () => {
      let launches: IngestLaunch[];
      try {
        launches = await this.options.launches();
      } catch (error) {
        logger.warn('could not list launches to ingest', { error: String(error) });
        return;
      }
      const watched = launches.map((launch) => ({ launch, pools: this.poolsOf(launch) }));
      this.routes.clear();
      for (const route of watched) for (const pool of route.pools) this.routes.set(pool.address, route);
      this.options.realtime?.watch([...this.routes.keys()]);
      for (const { launch, pools } of watched) {
        let ok = true;
        for (const pool of pools) {
          try {
            const counts = await this.pollPool(launch, pool, pools);
            totals.trades += counts.trades;
            totals.feeEvents += counts.feeEvents;
          } catch (error) {
            ok = false;
            if (isRateLimited(error)) {
              this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(2_000, this.backoffMs * 2));
              this.skipUntil = this.now() + this.backoffMs;
              logger.warn('launch RPC rate-limited; backing off', { seconds: this.backoffMs / 1000 });
              return;
            }
            logger.warn('launch pool read failed; retrying next poll', {
              symbol: launch.symbol,
              pool: pool.address,
              error: String(error),
            });
          }
        }
        if (ok) this.lastPollAt.set(launch.mint, this.now());
      }
      this.backoffMs = 0;
    })();
    this.running = pass;
    try {
      await pass;
    } finally {
      this.running = undefined;
    }
    return totals;
  }

  /** A launch's pools: the registry's, plus the DAMM v2 pool a graduation event named. */
  private poolsOf(launch: IngestLaunch): WatchedPool[] {
    const learned = this.graduated.get(launch.mint);
    return learned && !launch.pools.some((pool) => pool.address === learned)
      ? [...launch.pools, { address: learned, info: dammInfo(launch) }]
      : launch.pools;
  }

  /** New signatures of one pool after its cursor, oldest first; without a cursor, the backfill window. */
  private async newSignatures(pool: string): Promise<{ signatures: PoolSignature[]; backfill: boolean }> {
    const name = cursorName(pool);
    const cursor = await this.options.store.cursor(name);
    if (!cursor && this.options.backfillLimit === 0) {
      const [newest] = await this.options.chain.signatures(pool, { limit: 1 });
      if (newest) await this.options.store.setCursor(name, newest.slot, newest.signature);
      return { signatures: [], backfill: true };
    }
    const wanted = cursor ? Number.POSITIVE_INFINITY : this.options.backfillLimit;
    const fresh: PoolSignature[] = [];
    let before: string | undefined;
    // A cursor the node no longer has is read back to its slot until a new transaction moves it.
    let until = cursor && this.trimmedCursors.get(pool) !== cursor.signature ? cursor.signature : undefined;
    for (;;) {
      const limit = Math.min(PAGE, wanted - fresh.length);
      let page: PoolSignature[];
      try {
        page = await this.options.chain.signatures(pool, { until, before, limit });
      } catch (error) {
        // A node that trimmed its history past the cursor's transaction answers "Transaction <cursor> not found":
        // read back to the cursor's slot instead (what is read twice is deduped on (signature, ix)).
        if (!cursor || until === undefined || !isMissingSignature(error, cursor.signature)) throw error;
        logger.warn('the node no longer has the cursor transaction; reading back to its slot', {
          pool,
          slot: cursor.slot,
        });
        this.trimmedCursors.set(pool, cursor.signature);
        until = undefined;
        continue;
      }
      if (cursor && until === undefined) {
        const end = page.findIndex((sig) => sig.signature === cursor.signature || sig.slot < cursor.slot);
        if (end >= 0) {
          fresh.push(...page.slice(0, end));
          break;
        }
      }
      fresh.push(...page);
      if (page.length < limit || fresh.length >= wanted || page.length === 0) break;
      before = page[page.length - 1].signature;
    }
    return { signatures: fresh.reverse(), backfill: !cursor };
  }

  private async pollPool(
    launch: IngestLaunch,
    pool: WatchedPool,
    pools: readonly WatchedPool[],
  ): Promise<{ trades: number; feeEvents: number }> {
    const { signatures, backfill } = await this.newSignatures(pool.address);
    const counts = { trades: 0, feeEvents: 0 };
    if (signatures.length === 0) return counts;
    let last: PoolSignature | null = null;
    for (let i = 0; i < signatures.length; i += CONCURRENCY) {
      const batch = signatures.slice(i, i + CONCURRENCY);
      // Failed transactions and those the realtime source already read are not fetched.
      const skip = (sig: PoolSignature) => !!sig.err || this.seen.has(sig.signature);
      const raws = await Promise.all(
        batch.map((sig) => (skip(sig) ? Promise.resolve(null) : this.options.chain.transaction(sig.signature))),
      );
      const decoded: { trades: StoredLaunchTrade[]; fees: StoredLaunchFeeEvent[] }[] = [];
      let stop = false;
      for (let j = 0; j < batch.length; j++) {
        const sig = batch[j];
        const raw = raws[j];
        if (!skip(sig) && !raw) {
          const polls = (this.missing.get(sig.signature) ?? 0) + 1;
          this.missing.set(sig.signature, polls);
          if (polls < MAX_MISSING_POLLS) {
            stop = true; // hold the cursor before it; the next poll asks again
            break;
          }
          logger.error('transaction listed but never returned; skipping it', undefined, { signature: sig.signature });
        }
        this.missing.delete(sig.signature);
        if (raw) {
          decoded.push(this.decodeFor(launch, pools, raw, sig));
          this.remember(sig.signature);
        }
        last = sig;
      }
      // A first start's backfill is history: it does not count as feed lag.
      const added = await this.storeDecoded(launch, decoded, !backfill);
      counts.trades += added.trades;
      counts.feeEvents += added.feeEvents;
      if (last) await this.options.store.setCursor(cursorName(pool.address), last.slot, last.signature);
      if (stop) break;
    }
    if (counts.trades > 0 || counts.feeEvents > 0) {
      logger.info('launch pool read', { symbol: launch.symbol, pool: pool.address, ...counts });
    }
    return counts;
  }

  /** Decodes one transaction with the launch's pools (a graduation adds the DAMM v2 pool it names). */
  private decodeFor(
    launch: IngestLaunch,
    pools: readonly WatchedPool[],
    raw: unknown,
    sig: PoolSignature,
  ): { trades: StoredLaunchTrade[]; fees: StoredLaunchFeeEvent[] } {
    const poolInfo = new Map(pools.map((watched) => [watched.address, watched.info]));
    const dbcPools = new Set(pools.filter((watched) => watched.info.venue === 'dbc').map((watched) => watched.address));
    const dammPools = new Map(
      pools
        .filter((watched) => watched.info.venue === 'damm-v2')
        .map((watched) => [watched.address, { baseIsTokenA: watched.info.baseIsTokenA ?? true }]),
    );
    const known = this.graduated.get(launch.mint);
    const decoded = this.decode(launch, raw, sig, poolInfo, dbcPools, dammPools);
    // A graduation learned here: watch the new DAMM v2 pool at once (the realtime source too).
    const learned = this.graduated.get(launch.mint);
    if (learned && learned !== known && !this.routes.has(learned)) {
      const route = { launch, pools: this.poolsOf(launch) };
      for (const pool of route.pools) this.routes.set(pool.address, route);
      this.options.realtime?.watch([...this.routes.keys()]);
    }
    return decoded;
  }

  /** Stores decoded rows, publishes the new ones (the store dedupes on (signature, ix)) and records the feed lag. */
  private async storeDecoded(
    launch: IngestLaunch,
    decoded: readonly { trades: StoredLaunchTrade[]; fees: StoredLaunchFeeEvent[] }[],
    measureLag = true,
  ): Promise<{ trades: number; feeEvents: number }> {
    const trades = decoded.flatMap((one) => one.trades);
    const fees = decoded.flatMap((one) => one.fees);
    const counts = { trades: 0, feeEvents: 0 };
    const stored = this.now();
    const lag = (rows: readonly { blockTime: Date }[]) => {
      if (!measureLag) return;
      const newest = rows.reduce((max, row) => Math.max(max, row.blockTime.getTime()), 0);
      if (newest > 0) this.lagMs.set(launch.mint, Math.max(0, stored - newest));
    };
    if (trades.length > 0) {
      const added = await this.options.store.insertTrades(trades);
      counts.trades = added.length;
      if (added.length > 0) {
        lag(added);
        this.options.onTrades?.(launch.mint, added);
      }
    }
    if (fees.length > 0) {
      const added = await this.options.store.insertFeeEvents(fees);
      counts.feeEvents = added.length;
      if (added.length > 0) {
        lag(added);
        this.options.onFeeEvents?.(launch.mint, added);
      }
    }
    return counts;
  }

  private decode(
    launch: IngestLaunch,
    raw: unknown,
    sig: PoolSignature,
    poolInfo: ReadonlyMap<string, TradePoolInfo>,
    dbcPools: ReadonlySet<string>,
    dammPools: ReadonlyMap<string, { baseIsTokenA: boolean }>,
  ): { trades: StoredLaunchTrade[]; fees: StoredLaunchFeeEvent[] } {
    let tx;
    try {
      tx = normalizeTransaction(raw, sig.signature);
    } catch (error) {
      logger.warn('could not read a transaction; skipping it', { signature: sig.signature, error: String(error) });
      return { trades: [], fees: [] };
    }
    const events = decodeMeteoraEvents(tx);
    // Graduation: the migration creates a DAMM v2 pool for this mint (DBC puts the token in A). Watch it from now on.
    for (const event of events) {
      if (event.program !== 'damm-v2' || event.name !== 'EvtInitializePool') continue;
      if (event.data.tokenAMint === launch.mint || event.data.tokenBMint === launch.mint) {
        const damm = String(event.data.pool);
        if (!this.graduated.has(launch.mint))
          logger.info('launch graduated to DAMM v2', { symbol: launch.symbol, pool: damm });
        this.graduated.set(launch.mint, damm);
        if (!dammPools.has(damm)) {
          (dammPools as Map<string, { baseIsTokenA: boolean }>).set(damm, {
            baseIsTokenA: event.data.tokenAMint === launch.mint,
          });
        }
      }
    }
    const blockTime = new Date((tx.blockTime ?? sig.blockTime ?? Math.floor(this.now() / 1000)) * 1000);
    const trades = launchTradesFromTransaction(tx, poolInfo, events).map((trade): StoredLaunchTrade => ({
      signature: trade.signature,
      ix: trade.ix,
      mint: launch.mint,
      pool: trade.pool,
      venue: trade.venue,
      side: trade.side,
      trader: trade.trader,
      slot: trade.slot,
      blockTime,
      solLamports: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      feeAmount: trade.fee,
      feeInToken: trade.feeInToken,
      priceSol: trade.priceSol,
      postPriceSol: trade.postPriceSol,
      quoteReserveLamports: trade.quoteReserve,
    }));
    const fees = launchFeeEventsFromTransaction(tx, dbcPools, dammPools, events).map((event): StoredLaunchFeeEvent => ({
      signature: event.signature,
      ix: event.ix,
      mint: launch.mint,
      pool: event.pool,
      kind: event.kind,
      owner: event.owner,
      slot: event.slot,
      blockTime,
      solLamports: event.solAmount,
      tokenAmount: event.tokenAmount,
    }));
    return { trades, fees };
  }
}

/** The decoder settings of a launch's DAMM v2 pool (DBC graduations put the token in A). */
function dammInfo(launch: IngestLaunch): TradePoolInfo {
  const dbc = launch.pools.find((pool) => pool.info.venue === 'dbc');
  return { venue: 'damm-v2', baseDecimals: dbc?.info.baseDecimals ?? 6, baseIsTokenA: true };
}
