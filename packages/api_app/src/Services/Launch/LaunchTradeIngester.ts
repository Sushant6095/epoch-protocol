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
  now?: () => number;
}

/** Transactions per getTransaction batch. */
const CONCURRENCY = 2;
const PAGE = 1_000;
/** A transaction the RPC lists but cannot return holds the cursor this many polls, then is skipped. */
const MAX_MISSING_POLLS = 3;
const MAX_BACKOFF_MS = 60_000;

export const cursorName = (pool: string): string => `launch_trades:${pool}`;

/**
 * Reads every launch pool's transactions into launch_trades and launch_fee_events: on a first start the newest
 * `backfillLimit` signatures of each pool, then every `pollMs` the ones after the pool's cursor
 * (`indexer_cursors.name = launch_trades:<pool>`: every transaction up to it has been read), oldest first. Swap events
 * become trades, claim and graduation events fee events (`@epoch/meteora` decoders); a curve's graduation adds its
 * DAMM v2 pool to the watch list. Failed transactions are skipped; (signature, ix) dedupes, so a transaction read
 * through both pools (the migration) is stored once. HTTP 429 backs off up to a minute.
 */
export class LaunchTradeIngester {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private backoffMs = 0;
  private skipUntil = 0;
  private readonly lastPollAt = new Map<string, number>();
  private readonly missing = new Map<string, number>();
  /** DAMM v2 pools learned from graduation events, by mint. */
  private readonly graduated = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: LaunchTradeIngesterOptions) {
    this.now = options.now ?? Date.now;
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

  start(): void {
    if (!this.options.enabled || this.timer) return;
    const tick = () => void this.pollOnce();
    setTimeout(tick, 2_000).unref();
    this.timer = setInterval(tick, this.options.pollMs);
    this.timer.unref();
    GracefulShutdown.register('launch-trade-ingester', () => this.stop());
    logger.info('launch trade ingester started', { everySeconds: this.options.pollMs / 1000 });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
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
      for (const launch of launches) {
        const learned = this.graduated.get(launch.mint);
        const pools =
          learned && !launch.pools.some((pool) => pool.address === learned)
            ? [...launch.pools, { address: learned, info: dammInfo(launch) }]
            : launch.pools;
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

  /** New signatures of one pool after its cursor (or the backfill window), oldest first. */
  private async newSignatures(pool: string): Promise<PoolSignature[]> {
    const name = cursorName(pool);
    const cursor = await this.options.store.cursor(name);
    if (!cursor && this.options.backfillLimit === 0) {
      const [newest] = await this.options.chain.signatures(pool, { limit: 1 });
      if (newest) await this.options.store.setCursor(name, newest.slot, newest.signature);
      return [];
    }
    const wanted = cursor ? Number.POSITIVE_INFINITY : this.options.backfillLimit;
    const fresh: PoolSignature[] = [];
    let before: string | undefined;
    for (;;) {
      const limit = Math.min(PAGE, wanted - fresh.length);
      const page = await this.options.chain.signatures(pool, { until: cursor?.signature, before, limit });
      fresh.push(...page);
      if (page.length < limit || fresh.length >= wanted || page.length === 0) break;
      before = page[page.length - 1].signature;
    }
    return fresh.reverse();
  }

  private async pollPool(
    launch: IngestLaunch,
    pool: WatchedPool,
    pools: readonly WatchedPool[],
  ): Promise<{ trades: number; feeEvents: number }> {
    const signatures = await this.newSignatures(pool.address);
    const counts = { trades: 0, feeEvents: 0 };
    if (signatures.length === 0) return counts;
    const poolInfo = new Map(pools.map((watched) => [watched.address, watched.info]));
    const dbcPools = new Set(pools.filter((watched) => watched.info.venue === 'dbc').map((watched) => watched.address));
    const dammPools = new Map(
      pools
        .filter((watched) => watched.info.venue === 'damm-v2')
        .map((watched) => [watched.address, { baseIsTokenA: watched.info.baseIsTokenA ?? true }]),
    );
    let last: PoolSignature | null = null;
    for (let i = 0; i < signatures.length; i += CONCURRENCY) {
      const batch = signatures.slice(i, i + CONCURRENCY);
      const raws = await Promise.all(
        batch.map((sig) => (sig.err ? Promise.resolve(null) : this.options.chain.transaction(sig.signature))),
      );
      const trades: StoredLaunchTrade[] = [];
      const fees: StoredLaunchFeeEvent[] = [];
      let stop = false;
      for (let j = 0; j < batch.length; j++) {
        const sig = batch[j];
        const raw = raws[j];
        if (!sig.err && !raw) {
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
          const decoded = this.decode(launch, raw, sig, poolInfo, dbcPools, dammPools);
          trades.push(...decoded.trades);
          fees.push(...decoded.fees);
        }
        last = sig;
      }
      if (trades.length > 0) {
        const added = await this.options.store.insertTrades(trades);
        counts.trades += added.length;
        if (added.length > 0) this.options.onTrades?.(launch.mint, added);
      }
      if (fees.length > 0) {
        const added = await this.options.store.insertFeeEvents(fees);
        counts.feeEvents += added.length;
        if (added.length > 0) this.options.onFeeEvents?.(launch.mint, added);
      }
      if (last) await this.options.store.setCursor(cursorName(pool.address), last.slot, last.signature);
      if (stop) break;
    }
    if (counts.trades > 0 || counts.feeEvents > 0) {
      logger.info('launch pool read', { symbol: launch.symbol, pool: pool.address, ...counts });
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
