import { BadRequestException, EpochException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import {
  buildCandles,
  CANDLE_INTERVAL_SECONDS,
  type CandleInterval,
  type DammPoolState,
  type DataApiTimeframe,
  DEFAULT_TRADE_PRIORITY_MICROLAMPORTS,
  fillCandles,
  fromBaseUnits,
  type HolderLabels,
  impliedYieldPctPerEpoch,
  type LaunchClaimsState,
  type LaunchPoolState,
  type LaunchRef,
  type LaunchRegistryEntry,
  LaunchTradeError,
  type LaunchTradeErrorCode,
  MAX_CANDLES,
  TRADE_COMPUTE_UNIT_LIMIT,
  type TradePoolInfo,
} from '@epoch/meteora';
import { PublicKey } from '@solana/web3.js';

import { SnapshotCache } from '../../Lib/SnapshotCache';
import { isoIst, round } from '../../Lib/Stats';
import { type LaunchNetwork } from '../../types/Launch.types';
import {
  type Freshness,
  type LaunchBuildResponse,
  type LaunchCandle,
  type LaunchCandleInterval,
  type LaunchCandles,
  type LaunchFeeEventRow,
  type LaunchFees,
  type LaunchHolders,
  type LaunchIndexed,
  type LaunchIndexedSummary,
  type LaunchIngestStatus,
  type LaunchMarket,
  type LaunchPage,
  type LaunchQuoteResponse,
  type LaunchStreamMessage,
  type LaunchTrade,
  type LaunchTradeList,
} from '../../types/LaunchPage.types';
import { type LaunchChainReader } from './LaunchChain';
import { type LaunchIndexedSource } from './LaunchIndexedSource';
import { type LaunchItem } from './LaunchMapper';
import { type LaunchLiveChain } from './LaunchLiveChain';
import { type LaunchPriceStore } from './LaunchPriceStore';
import { type LaunchService } from './LaunchService';
import { type IngestLaunch, type LaunchTradeIngester } from './LaunchTradeIngester';
import {
  decodeTradeCursor,
  encodeTradeCursor,
  type LaunchTradeStore,
  type StoredLaunchFeeEvent,
  type StoredLaunchTrade,
} from './LaunchTradeStore';
import { type RevenueTokenSource } from './RevenueTokenSource';
import { type TreasuryClaimsSource } from './TreasuryClaimsSource';

const logger = Logger.create('LaunchPage');

/** Meteora's pool authorities: they own the curve's and the DAMM v2 pool's token vaults. */
const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const DAMM_V2_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
const DAY_MS = 86_400_000;
const PAGE_TRADES = 50;
/** Where `market.indexed` and `GET .../indexed` come from. */
const INDEXED_SOURCE = "Meteora's DAMM v2 data API (damm-v2.datapi.meteora.ag): indexed, seconds behind the chain";
/** Top holders are kept 2 minutes, or read again on request after a trade or claim (at most this often). */
const HOLDERS_REREAD_MS = 5_000;

/** Why a quote or a transaction cannot be built, as an HTTP error the ticket can show. */
export class LaunchTradeException extends EpochException {
  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message, code, status, details);
  }
}

const TRADE_ERROR_STATUS: Record<LaunchTradeErrorCode, number> = {
  NOT_LAUNCHED: 409,
  NOT_OPEN: 409,
  CURVE_COMPLETE: 409,
  NOT_TRADING: 409,
  AMOUNT_TOO_SMALL: 400,
  INSUFFICIENT_LIQUIDITY: 422,
  WRONG_TOKEN: 409,
};

export interface TradeRequest {
  side: 'buy' | 'sell';
  /** SOL to spend (buy) or tokens to sell (sell). */
  amount: number;
  slippageBps?: number;
}

export interface BuildRequest extends TradeRequest {
  owner: string;
  minimumOut?: number;
  consent: boolean;
}

export interface LaunchPageServiceOptions {
  launches: LaunchService;
  reader: LaunchChainReader;
  live: LaunchLiveChain;
  store: LaunchTradeStore;
  prices: LaunchPriceStore | null;
  /** SOL/USD (Jupiter, via the market data); null when unknown. */
  solUsd: () => Promise<number | null>;
  revenueTokens: RevenueTokenSource;
  /** Epoch's treasury claims (the program's `TreasuryClaimed` events); null without a program id. */
  treasury?: TreasuryClaimsSource | null;
  ingester: LaunchTradeIngester | null;
  network: LaunchNetwork;
  /** For explorer links: the launch cluster, or a custom RPC (localnet stand-in). */
  explorer: { cluster: LaunchNetwork; customRpc: string | null };
  marketCacheMs: number;
  staleMs: number;
  maxBuySol: number;
  /** The priority fee /build puts on the swap, micro-lamports per CU (reported as `priorityFeeSol`). Default 100,000. */
  tradePriorityMicroLamports?: number;
  /** Meteora's DAMM v2 data API for graduated pools; null when off, with `indexedOff` saying why. */
  indexed?: LaunchIndexedSource | null;
  indexedOff?: string;
  now?: () => number;
}

/** A pool read for the market block. */
interface MarketRead {
  pool: LaunchPoolState | null;
  damm: DammPoolState | null;
}

const fresh = (asOfMs: number | null, now: number, staleMs: number): Freshness =>
  asOfMs === null
    ? { asOf: null, ageSeconds: null, stale: true }
    : {
        asOf: isoIst(new Date(asOfMs)),
        ageSeconds: Math.max(0, Math.round((now - asOfMs) / 1000)),
        stale: now - asOfMs > staleMs,
      };

const sig6 = (value: number): number => (value === 0 ? 0 : Number(value.toPrecision(6)));
const nullableRound = (value: number | null, digits: number): number | null =>
  value === null ? null : round(value, digits);

/**
 * The Launch page's live data (plan F13, docs/pages/launch.md) on top of `LaunchService`'s cached board: the market
 * (a fresh pool read, cached LAUNCH_MARKET_CACHE_SECONDS and dropped on a new trade), the trade feed and candles from
 * launch_trades, top holders, fees and payouts from the pools' state, the buy/sell ticket, and the first-paint bundle.
 * Every block reports when it was read and whether that is stale.
 */
export class LaunchPageService {
  private readonly markets = new Map<string, SnapshotCache<MarketRead>>();
  private readonly holderCaches = new Map<string, SnapshotCache<LaunchHolders['top']>>();
  /** When a trade or claim last changed a mint's balances (epoch ms): the holders are read again on the next request. */
  private readonly holdersChangedAt = new Map<string, number>();
  private readonly claimCaches = new Map<string, SnapshotCache<LaunchClaimsState | null>>();
  private readonly now: () => number;
  /** Publishes on WS `launch:<mint>` (set by the stream wiring). */
  private publish?: (mint: string, message: LaunchStreamMessage) => void;

  constructor(private readonly options: LaunchPageServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  setPublisher(publish: (mint: string, message: LaunchStreamMessage) => void): void {
    this.publish = publish;
  }

  // ── Wiring for the ingester and the stream ──────────────────────────────────────────────────────

  /** The launches the ingester reads, with their pools (the DAMM v2 pool once graduated). */
  async ingestLaunches(): Promise<IngestLaunch[]> {
    return Promise.all(
      this.options.launches
        .entries()
        .filter((entry) => !!entry.dbcPool)
        .map(async (entry) => {
          const dbc: TradePoolInfo = { venue: 'dbc', baseDecimals: entry.decimals, collectFeeMode: 0 };
          const pools = [{ address: entry.dbcPool as string, info: dbc }];
          const damm = entry.dammPool ?? (await this.dammPoolOf(entry).catch(() => null));
          if (damm)
            pools.push({ address: damm, info: { venue: 'damm-v2', baseDecimals: entry.decimals, baseIsTokenA: true } });
          return { mint: entry.mint, symbol: entry.symbol, pools };
        }),
    );
  }

  /** New trades from the ingester: drop the market read and push the trades and the new market on the stream. */
  onTrades(mint: string, rows: StoredLaunchTrade[]): void {
    this.markets.get(mint)?.invalidate();
    if (rows.length > 0) this.holdersChangedAt.set(mint, this.now());
    if (!this.publish) return;
    void (async () => {
      const entry = this.options.launches.entries().find((candidate) => candidate.mint === mint);
      if (!entry) return;
      for (const row of [...rows].sort((a, b) => a.slot - b.slot || a.ix - b.ix)) {
        this.publish?.(mint, { type: 'trade', trade: this.toTrade(row, entry) });
      }
      this.publish?.(mint, { type: 'market', market: await this.market(mint) });
    })().catch((error: unknown) => logger.warn('launch stream push failed', { mint, error: String(error) }));
  }

  /** New fee events: drop the fee read; push them. */
  onFeeEvents(mint: string, rows: StoredLaunchFeeEvent[]): void {
    this.claimCaches.get(mint)?.invalidate();
    this.markets.get(mint)?.invalidate();
    if (rows.length > 0) this.holdersChangedAt.set(mint, this.now());
    const entry = this.options.launches.entries().find((candidate) => candidate.mint === mint);
    if (!entry) return;
    for (const row of rows) this.publish?.(mint, { type: 'fee', event: this.toFeeEvent(row, entry) });
  }

  /** What a new `launch:<mint>` subscriber gets first. */
  async snapshot(mint: string): Promise<LaunchStreamMessage> {
    const { item } = await this.options.launches.find(mint);
    const [market, trades] = await Promise.all([
      this.market(mint),
      this.options.store.trades(item.entry.mint, { limit: 20 }),
    ]);
    return { type: 'snapshot', market, trades: trades.map((row) => this.toTrade(row, item.entry)) };
  }

  /** Whether a `launch:<key>` channel names a launch on this network (mint or symbol). */
  isLaunch(key: string): boolean {
    return this.entryOf(key) !== undefined;
  }

  /** The mint for a mint or a symbol (the canonical `launch:<mint>` channel). */
  mintOf(key: string): string {
    return this.entryOf(key)?.mint ?? key;
  }

  private entryOf(key: string): LaunchRegistryEntry | undefined {
    const entries = this.options.launches.entries();
    return (
      entries.find((entry) => entry.mint === key) ??
      entries.find((entry) => entry.symbol.toLowerCase() === key.toLowerCase())
    );
  }

  // ── Endpoints ───────────────────────────────────────────────────────────────────────────────────

  /** GET /v1/launches/:mint/market */
  async market(key: string): Promise<LaunchMarket> {
    const { item } = await this.options.launches.find(key);
    return this.marketFor(item);
  }

  /** GET /v1/launches/:mint/trades */
  async trades(key: string, options: { limit?: number; before?: string | null }): Promise<LaunchTradeList> {
    const { item } = await this.options.launches.find(key);
    const entry = item.entry;
    const before = options.before ? decodeTradeCursor(options.before) : null;
    if (options.before && !before) throw new BadRequestException('before: a cursor from nextCursor');
    const limit = Math.min(Math.max(options.limit ?? PAGE_TRADES, 1), 200);
    const rows = await this.options.store.trades(entry.mint, { limit, before });
    const last = rows[rows.length - 1];
    return {
      ...this.meta('launch_trades: DBC and DAMM v2 swap events of the launch pools'),
      network: this.options.network,
      mint: entry.mint,
      trades: rows.map((row) => this.toTrade(row, entry)),
      nextCursor: rows.length === limit && last ? encodeTradeCursor(last) : null,
      ingest: await this.ingestStatus(entry),
    };
  }

  /** GET /v1/launches/:mint/candles */
  async candles(
    key: string,
    options: { interval?: LaunchCandleInterval; from?: number; to?: number },
  ): Promise<LaunchCandles> {
    const { item } = await this.options.launches.find(key);
    const entry = item.entry;
    const interval: CandleInterval = options.interval ?? '15m';
    const step = CANDLE_INTERVAL_SECONDS[interval];
    const nowSec = Math.floor(this.now() / 1000);
    const to = Math.min(options.to ?? nowSec, nowSec);
    const defaultSpan =
      interval === '1m' || interval === '5m' || interval === '15m'
        ? 86_400
        : interval === '1d'
          ? 90 * 86_400
          : 7 * 86_400;
    if (options.from !== undefined && options.from > to) throw new BadRequestException('from must be before to');
    // Whole buckets: the first one starts on the interval's grid, so its open is the bucket's first trade.
    const from = Math.floor(Math.max(options.from ?? to - defaultSpan, to - (MAX_CANDLES - 1) * step) / step) * step;
    const { candles: sparse, previousClose } = await this.options.store.candles(
      entry.mint,
      interval,
      new Date(from * 1000),
      new Date((to + step) * 1000),
    );
    let basis: LaunchCandles['basis'] = 'trades';
    let candles = fillCandles(sparse, interval, { from, to, previousClose });
    if (sparse.length === 0 && previousClose === null && this.options.prices) {
      // No trades yet in or before the range: the sampled pool prices, if any.
      const samples = await this.options.prices.series(entry.mint).catch(() => []);
      const points = samples
        .map((sample) => ({ t: sample.t.getTime() / 1000, priceSol: sample.priceSol }))
        .filter((point) => point.t >= from - step && point.t <= to + step);
      candles = buildCandles(points, interval, { from, to });
      basis = candles.length > 0 ? 'samples' : 'none';
    } else if (candles.length === 0) {
      basis = 'none';
    }
    return {
      ...this.meta(basis === 'samples' ? 'launch_price_samples (no trades in range)' : 'launch_trades'),
      network: this.options.network,
      mint: entry.mint,
      interval,
      candles: candles.map((candle): LaunchCandle => ({
        t: isoIst(new Date(candle.t * 1000)),
        time: candle.t,
        open: sig6(candle.open),
        high: sig6(candle.high),
        low: sig6(candle.low),
        close: sig6(candle.close),
        volumeSol: round(candle.volumeSol, 6),
        trades: candle.trades,
      })),
      basis,
    };
  }

  /** GET /v1/launches/:mint/holders */
  async holders(key: string): Promise<LaunchHolders> {
    const { item, readAt } = await this.options.launches.find(key);
    const entry = item.entry;
    const token = await this.options.revenueTokens.get(entry).catch(() => null);
    const escrow = entry.escrow ?? token?.buybackEscrow ?? null;
    const treasury = token?.treasury ?? null;
    const cache = this.cacheFor(this.holderCaches, entry.mint, 120_000, async () =>
      (await this.options.live.topHolders(entry.mint, entry.decimals, this.holderLabels(entry, escrow, treasury))).map(
        (holder) => ({
          owner: holder.owner,
          tokenAccount: holder.tokenAccount,
          amount: holder.uiAmount,
          sharePct: round(holder.sharePct, 4),
          label: holder.label,
        }),
      ),
    );
    // A trade or claim since the last read moved balances: read again, at most every HOLDERS_REREAD_MS (a failed
    // re-read serves the last list, marked by its age).
    const changed = (this.holdersChangedAt.get(entry.mint) ?? 0) > cache.loadedAtMs;
    const top =
      changed && cache.loadedAtMs > 0 && this.now() - cache.loadedAtMs >= HOLDERS_REREAD_MS
        ? await cache.refresh().catch(() => cache.get())
        : await cache.get();
    // Fewer than 20 accounts back from getTokenLargestAccounts is every holder: count them from the fresh list.
    // Otherwise the counts come from the board's holder scan (one getProgramAccounts, LAUNCH_HOLDERS_CACHE_MINUTES).
    const complete = top.length < 20;
    // Not buyers: the pools' vault authorities, the buyback escrow, Epoch's treasury and the leftover receiver.
    const notBuyers = new Set(
      [DBC_POOL_AUTHORITY, DAMM_V2_POOL_AUTHORITY, escrow, treasury, entry.feeClaimer, entry.leftoverReceiver].filter(
        Boolean,
      ),
    );
    return {
      ...this.meta(
        complete
          ? 'getTokenLargestAccounts and token-account owners (every holder)'
          : 'getTokenLargestAccounts and token-account owners; holder counts from the holder scan',
      ),
      network: this.options.network,
      mint: entry.mint,
      count: complete
        ? { all: top.length, buyers: top.filter((holder) => !holder.owner || !notBuyers.has(holder.owner)).length }
        : {
            all: item.real || item.detail.token.holders > 0 ? item.detail.token.holders : null,
            buyers: item.real || item.summary.raise.buyers > 0 ? item.summary.raise.buyers : null,
          },
      top,
      freshness: fresh(
        complete ? cache.loadedAtMs : Math.min(cache.loadedAtMs, readAt.getTime()),
        this.now(),
        this.options.staleMs,
      ),
    };
  }

  /** GET /v1/launches/:mint/fees */
  async fees(key: string): Promise<LaunchFees> {
    const { item } = await this.options.launches.find(key);
    const entry = item.entry;
    if (!entry.dbcPool) throw new EpochException('This launch has no curve pool yet', 'NOT_LAUNCHED', 409);
    const cache = this.cacheFor(this.claimCaches, entry.mint, 60_000, () =>
      this.options.live.claims(entry.dbcPool as string, entry.dbcConfig ?? null, entry.dammPool ?? null),
    );
    const source = this.options.treasury ?? null;
    const [claims, history, claimed] = await Promise.all([
      cache.get(),
      this.options.store.feeEvents(entry.mint, 50),
      source?.treasury
        ? source.claims(entry.mint, entry.decimals).catch((error: unknown) => {
            logger.warn('treasury claims read failed', { mint: entry.mint, error: String(error) });
            return null;
          })
        : null,
    ]);
    if (!claims) throw new EpochException('The curve pool is not on chain yet', 'NOT_LAUNCHED', 409);
    const sol = (lamports: bigint) => round(fromBaseUnits(lamports, 9), 9);
    const tokens = (amount: bigint) => round(fromBaseUnits(amount, entry.decimals), 6);
    const partnerPositions = claims.positions.filter((position) => position.role === 'partner');
    const lpClaimed = claims.positions.reduce((sum, position) => sum + position.claimedLamports, 0n);
    const lpUnclaimed = claims.positions.reduce((sum, position) => sum + position.unclaimedLamports, 0n);
    const partnerLpClaimed = partnerPositions.reduce((sum, position) => sum + position.claimedLamports, 0n);
    const partnerLpUnclaimed = partnerPositions.reduce((sum, position) => sum + position.unclaimedLamports, 0n);
    const surplus = claims.surplus.partner;
    const migrationFee = claims.migrationFee.partner;
    // What the pools' state says the partner already took out of Meteora (the fallback when the events are unread).
    const takenLamports =
      claims.tradingFees.partner.claimedLamports +
      (surplus.withdrawn ? surplus.lamports : 0n) +
      (migrationFee.withdrawn ? migrationFee.lamports : 0n) +
      partnerLpClaimed;
    // Epoch's launches name the program's treasury PDA as fee claimer: its claims go into the lending pool as income
    // (the program's TreasuryClaimed events, the same sums as /buybacks). A launch whose fee claimer is a plain wallet
    // (the first rehearsal) keeps what that wallet claimed.
    const viaProgram = !!source?.treasury && claims.partner === source.treasury;
    const leftoverBurned = viaProgram ? (claimed?.byKind.leftover.tokensBurned ?? 0) : 0;
    return {
      ...this.meta(
        'DBC pool and config, DAMM v2 positions (on-chain state); claim events from launch_fee_events; the treasury claims from the Epoch program (TreasuryClaimed)',
      ),
      network: this.options.network,
      mint: entry.mint,
      partner: {
        address: claims.partner,
        tradingFeesSol: {
          accrued: sol(claims.tradingFees.partner.totalLamports),
          claimed: sol(claims.tradingFees.partner.claimedLamports),
          unclaimed: sol(claims.tradingFees.partner.unclaimedLamports),
        },
        surplusSol: sol(surplus.lamports),
        surplusWithdrawn: surplus.withdrawn,
        migrationFeeSol: sol(migrationFee.lamports),
        migrationFeeWithdrawn: migrationFee.withdrawn,
      },
      creator: {
        address: claims.creator,
        migrationFeeSol: sol(claims.migrationFee.creator.lamports),
        migrationFeeWithdrawn: claims.migrationFee.creator.withdrawn,
        surplusSol: sol(claims.surplus.creator.lamports),
        surplusWithdrawn: claims.surplus.creator.withdrawn,
        tradingFeesSol: {
          accrued: sol(claims.tradingFees.creator.totalLamports),
          claimed: sol(claims.tradingFees.creator.claimedLamports),
          unclaimed: sol(claims.tradingFees.creator.unclaimedLamports),
        },
      },
      lp: {
        positions: claims.positions.map((position) => ({
          position: position.position,
          owner: position.owner,
          role: position.role,
          lockedPct: position.lockedPct,
          claimedSol: sol(position.claimedLamports),
          unclaimedSol: sol(position.unclaimedLamports),
          claimedTokens: tokens(position.claimedTokens),
          unclaimedTokens: tokens(position.unclaimedTokens),
        })),
        claimedSol: sol(lpClaimed),
        unclaimedSol: sol(lpUnclaimed),
      },
      leftover: {
        receiver: claims.leftoverReceiver,
        tokens: tokens(claims.leftover.tokens),
        withdrawn: claims.leftover.withdrawn,
        burned: leftoverBurned > 0,
        burnedTokens: leftoverBurned,
      },
      toLenders: {
        // Exactly /buybacks' treasury.totals.toLendersSol (the same events, summed in lamports).
        claimedSol: viaProgram && claimed ? claimed.totals.toLendersSol : sol(takenLamports),
        pendingSol: sol(
          claims.tradingFees.partner.unclaimedLamports +
            (surplus.withdrawn ? 0n : surplus.lamports) +
            (migrationFee.withdrawn ? 0n : migrationFee.lamports) +
            partnerLpUnclaimed,
        ),
        holder: viaProgram ? source.vault : claims.partner,
        note: viaProgram
          ? "Epoch's partner fees (trading fees, surplus, migration fee, LP fees) are claimed into the Epoch lending pool as income; tokens burned, as is the supply the curve never sold."
          : "This launch's fee claimer is a plain wallet, not Epoch's treasury PDA: its partner fees are claimed to that wallet.",
      },
      history: history.map((row) => this.toFeeEvent(row, entry)),
      freshness: fresh(cache.loadedAtMs || null, this.now(), this.options.staleMs),
    };
  }

  /** POST /v1/launches/:mint/quote */
  async quote(key: string, request: TradeRequest): Promise<LaunchQuoteResponse> {
    const { item } = await this.options.launches.find(key);
    const ref = await this.tradeRef(item.entry);
    this.checkTrade(request);
    const slippageBps = request.slippageBps ?? 100;
    const quote = await this.tradeCall(() => this.options.live.quote(ref, request.side, request.amount, slippageBps));
    return {
      ...this.meta(
        `${quote.venue === 'dbc' ? 'Meteora DBC swapQuote2' : 'Meteora DAMM v2 getQuote2'} on ${this.options.network}`,
      ),
      network: this.options.network,
      mint: item.entry.mint,
      quote,
      validForSeconds: 15,
      warnings: this.tradeWarnings(quote.priceImpactPct, item),
    };
  }

  /** POST /v1/launches/:mint/build */
  async build(key: string, request: BuildRequest): Promise<LaunchBuildResponse> {
    if (request.consent !== true) {
      throw new LaunchTradeException(
        'CONSENT_REQUIRED',
        'consent must be true: the transaction trades SOL from the signing wallet',
        400,
      );
    }
    let owner: PublicKey;
    try {
      owner = new PublicKey(request.owner);
    } catch {
      throw new BadRequestException('owner: the wallet that signs, a base58 public key');
    }
    const { item } = await this.options.launches.find(key);
    const ref = await this.tradeRef(item.entry);
    this.checkTrade(request);
    const slippageBps = request.slippageBps ?? 100;
    const [quote, tx] = await this.tradeCall(() =>
      Promise.all([
        this.options.live.quote(ref, request.side, request.amount, slippageBps),
        this.options.live.build(ref, request.side, request.amount, slippageBps, owner.toBase58(), request.minimumOut),
      ]),
    );
    return {
      ...this.meta(
        `${quote.venue === 'dbc' ? 'Meteora DBC swap2' : 'Meteora DAMM v2 swap2'} on ${this.options.network}`,
      ),
      network: this.options.network,
      mint: item.entry.mint,
      quote: request.minimumOut !== undefined ? { ...quote, minimumOut: request.minimumOut } : quote,
      validForSeconds: 60,
      warnings: this.tradeWarnings(quote.priceImpactPct, item),
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      feePayer: owner.toBase58(),
      blockhash: tx.recentBlockhash ?? '',
      lastValidBlockHeight: tx.lastValidBlockHeight ?? 0,
      explorerCluster: this.options.network === 'mainnet' ? null : this.options.network,
      // At most the compute limit × the price; the wallet adds the 0.000005 SOL signature fee.
      priorityFeeSol:
        (TRADE_COMPUTE_UNIT_LIMIT * (this.options.tradePriorityMicroLamports ?? DEFAULT_TRADE_PRIORITY_MICROLAMPORTS)) /
        1e15,
    };
  }

  /** GET /v1/launches/:mint/page — the first-paint bundle. Blocks that fail are listed in `unavailable`. */
  async page(key: string): Promise<LaunchPage> {
    const [detail, found] = await Promise.all([this.options.launches.detail(key), this.options.launches.find(key)]);
    const entry = found.item.entry;
    const unavailable: string[] = [];
    const attempt = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (error) {
        unavailable.push(name);
        logger.warn('launch page block failed', { mint: entry.mint, block: name, error: String(error) });
        return null;
      }
    };
    const [market, trades, candles, holders, fees, revenueToken, ingest] = await Promise.all([
      attempt('market', () => this.marketFor(found.item)),
      attempt('trades', () => this.options.store.trades(entry.mint, { limit: PAGE_TRADES })),
      attempt('candles', () => this.candles(entry.mint, { interval: '15m' })),
      attempt('holders', () => this.holders(entry.mint)),
      entry.dbcPool ? attempt('fees', () => this.fees(entry.mint)) : Promise.resolve(null),
      this.options.revenueTokens.get(entry),
      this.ingestStatus(entry),
    ]);
    const { schemaVersion, kind, asOf, source, note, network, launch, ...rest } = detail;
    const stripMeta = <T extends object>(value: T | null) => {
      if (!value) return null;
      const {
        schemaVersion: _v,
        kind: _k,
        asOf: _a,
        source: _s,
        note: _n,
        network: _w,
        mint: _m,
        ...body
      } = value as T & {
        schemaVersion?: number;
        kind?: string;
        asOf?: string;
        source?: string;
        note?: string;
        network?: string;
        mint?: string;
      };
      return body;
    };
    const base = `/v1/launches/${entry.mint}`;
    return {
      schemaVersion,
      kind,
      asOf,
      source: `${source}; the Launch page's live reads (pools, launch_trades, holders, fees)`,
      note: [note, unavailable.length ? `Not available right now: ${unavailable.join(', ')}.` : '']
        .filter(Boolean)
        .join(' '),
      network,
      launch,
      detail: rest,
      market: market ?? this.unavailableMarket(found.item),
      revenueToken,
      trades: (trades ?? []).map((row) => this.toTrade(row, entry)),
      candles: candles
        ? { interval: candles.interval, basis: candles.basis, candles: candles.candles }
        : { interval: '15m', basis: 'none', candles: [] },
      holders: stripMeta(holders) as LaunchPage['holders'],
      fees: stripMeta(fees) as LaunchPage['fees'],
      ingest,
      stream: { channel: `launch:${entry.mint}` },
      links: {
        buybacks: `${base}/buybacks`,
        trades: `${base}/trades`,
        candles: `${base}/candles`,
        holders: `${base}/holders`,
        fees: `${base}/fees`,
      },
      unavailable,
    };
  }

  // ── Market ──────────────────────────────────────────────────────────────────────────────────────

  private async marketFor(item: LaunchItem): Promise<LaunchMarket> {
    const entry = item.entry;
    const cache = this.cacheFor(this.markets, entry.mint, this.options.marketCacheMs, () => this.readMarket(entry));
    const [read, solUsd, day] = await Promise.all([
      cache.get(),
      this.options.solUsd().catch(() => null),
      this.options.store.dayStats(entry.mint, new Date(this.now() - DAY_MS)),
    ]);
    const { pool, damm } = read;
    const migrated = !!pool?.migrated || !!damm;
    const upcoming = item.summary.status === 'upcoming' && !pool;
    const state: LaunchMarket['graduation']['state'] = upcoming
      ? 'upcoming'
      : migrated
        ? 'migrated'
        : pool?.curveComplete
          ? 'complete'
          : 'curve';
    const venue: LaunchMarket['venue'] = state === 'migrated' ? 'damm-v2' : state === 'curve' ? 'dbc' : null;
    const priceSol = upcoming ? null : (damm?.priceSol ?? pool?.priceSol ?? null);
    const burned = item.detail.token.burned;
    const marketCapSol = priceSol === null ? null : priceSol * Math.max(0, entry.supply - burned);
    const target = pool?.migrationThresholdSol ?? item.summary.raise.targetSol;
    const raised = migrated ? target : (pool?.quoteReserveSol ?? 0);
    const dammPool = damm?.pool ?? pool?.dammPool ?? entry.dammPool ?? null;
    const shareRevenue = item.summary.shareRevenuePerEpochSol;
    return {
      // The pool read can be fresher than the board's (a graduation since); a term that is over stays `ended`.
      status: item.summary.status !== 'ended' && migrated ? 'graduated' : item.summary.status,
      venue,
      priceSol: priceSol === null ? null : sig6(priceSol),
      priceUsd: priceSol !== null && solUsd !== null ? sig6(priceSol * solUsd) : null,
      solUsd: solUsd === null ? null : round(solUsd, 2),
      marketCapSol: marketCapSol === null ? null : round(marketCapSol, 4),
      marketCapUsd: marketCapSol !== null && solUsd !== null ? round(marketCapSol * solUsd, 2) : null,
      raise: {
        targetSol: round(target, 6),
        raisedSol: round(Math.min(raised, target || raised), 6),
        progressPct: round(migrated ? 100 : (pool?.curveProgressPct ?? 0), 2),
        complete: migrated || !!pool?.curveComplete,
      },
      liquiditySol: migrated
        ? damm
          ? round(damm.quoteReserveSol, 6)
          : null
        : pool
          ? round(pool.quoteReserveSol, 6)
          : null,
      shareRevenuePerEpochSol: shareRevenue,
      pricedAtShareRevenuePerEpochSol:
        entry.avgRevenueSol === undefined ? null : round((entry.avgRevenueSol * entry.shareBps) / 10_000, 6),
      impliedYieldPctPerEpoch:
        item.summary.impliedYieldPctPerEpoch === null && shareRevenue === 0
          ? null
          : nullableRound(impliedYieldPctPerEpoch(shareRevenue, marketCapSol), 3),
      graduation: {
        state,
        dammPool,
        dammPoolUrl: dammPool ? this.explorerUrl('address', dammPool) : null,
        meteoraUrl: dammPool && this.options.network === 'mainnet' ? `https://app.meteora.ag/dammv2/${dammPool}` : null,
        graduatedEpoch: item.detail.curve.graduatedEpoch,
        curveCompletedAt: pool?.finishCurveTime ? isoIst(new Date(pool.finishCurveTime * 1000)) : null,
      },
      day: {
        volumeSol: round(day.volumeSol, 6),
        trades: day.trades,
        buys: day.buys,
        sells: day.sells,
        priceChangePct:
          day.firstPriceSol && day.lastPriceSol
            ? round(((day.lastPriceSol - day.firstPriceSol) / day.firstPriceSol) * 100, 2)
            : null,
      },
      indexed: state === 'migrated' && dammPool ? await this.indexedSummary(dammPool) : null,
      freshness: fresh(cache.loadedAtMs || null, this.now(), this.options.staleMs),
    };
  }

  /** The graduated pool's indexed summary (cached by the source); null when off or unanswered: the chain read stands. */
  private async indexedSummary(dammPool: string): Promise<LaunchIndexedSummary | null> {
    if (!this.options.indexed) return null;
    try {
      const { value: pool, loadedAtMs } = await this.options.indexed.pool(dammPool);
      if (!pool) return null;
      return {
        source: INDEXED_SOURCE,
        tvlUsd: round(pool.tvlUsd, 2),
        volume24hUsd: round(pool.volumeUsd['24h'], 2),
        fees24hUsd: round(pool.feesUsd['24h'], 2),
        lockedLiquidityUsd: round(pool.permanentLockLiquidityUsd, 2),
        priceSol: sig6(pool.price),
        freshness: fresh(loadedAtMs || null, this.now(), this.options.staleMs),
      };
    } catch (error) {
      logger.warn('DAMM v2 data API unavailable; the chain read stands', { dammPool, error: String(error) });
      return null;
    }
  }

  /** GET /v1/launches/:mint/indexed — the graduated pool through Meteora's DAMM v2 data API. */
  async indexed(key: string, options: { timeframe?: DataApiTimeframe }): Promise<LaunchIndexed> {
    const { item } = await this.options.launches.find(key);
    const market = await this.marketFor(item);
    const dammPool = market.graduation.state === 'migrated' ? market.graduation.dammPool : null;
    const timeframe = options.timeframe ?? '1h';
    const none = (reason: string): LaunchIndexed => ({
      ...this.meta(INDEXED_SOURCE),
      network: this.options.network,
      mint: item.entry.mint,
      dammPool,
      available: false,
      reason,
      pool: null,
      candles: null,
      volumeHistory: null,
      protocol: null,
      freshness: { asOf: null, ageSeconds: null, stale: true },
    });
    const indexed = this.options.indexed;
    if (!indexed) return none(this.options.indexedOff ?? 'the DAMM v2 data API is off');
    if (!dammPool) {
      return none('the token has not graduated: the data API covers its DAMM v2 pool (see /market and /candles)');
    }
    try {
      const [pool, candles, volume, protocol] = await Promise.all([
        indexed.pool(dammPool),
        indexed.candles(dammPool, timeframe),
        indexed.volume(dammPool, timeframe),
        indexed.protocolMetrics().catch(() => null),
      ]);
      if (!pool.value) return none('Meteora has not indexed this pool yet (it indexes mainnet pools, seconds behind)');
      const p = pool.value;
      const t = (seconds: number) => isoIst(new Date(seconds * 1000));
      const loaded = Math.min(pool.loadedAtMs, candles.loadedAtMs, volume.loadedAtMs);
      return {
        ...this.meta(INDEXED_SOURCE),
        network: this.options.network,
        mint: item.entry.mint,
        dammPool,
        available: true,
        reason: null,
        pool: {
          name: p.name,
          tvlUsd: round(p.tvlUsd, 2),
          priceSol: sig6(p.price),
          tokenAmount: round(p.tokenXAmount, 6),
          solAmount: round(p.tokenYAmount, 9),
          holders: p.tokenX.holders,
          volumeUsd: { ...p.volumeUsd },
          feesUsd: { ...p.feesUsd },
          protocolFeesUsd: { ...p.protocolFeesUsd },
          cumulative: p.cumulative,
          lockedLiquidityUsd: round(p.permanentLockLiquidityUsd, 2),
          baseFeePct: p.baseFeePct,
          dynamicFee: p.dynamicFee,
          launchpad: p.launchpad,
          createdAt: isoIst(new Date(p.createdAt)),
        },
        candles: {
          timeframe: candles.value.timeframe,
          candles: candles.value.points.map((c) => ({
            t: t(c.time),
            time: c.time,
            open: sig6(c.open),
            high: sig6(c.high),
            low: sig6(c.low),
            close: sig6(c.close),
            volumeUsd: round(c.volumeUsd, 2),
          })),
        },
        volumeHistory: {
          timeframe: volume.value.timeframe,
          buckets: volume.value.points.map((b) => ({
            t: t(b.time),
            time: b.time,
            volumeUsd: round(b.volumeUsd, 2),
            feesUsd: round(b.feesUsd, 2),
            protocolFeesUsd: round(b.protocolFeesUsd, 2),
          })),
        },
        protocol: protocol
          ? {
              tvlUsd: round(protocol.value.tvlUsd, 0),
              volume24hUsd: round(protocol.value.volume24hUsd, 0),
              fees24hUsd: round(protocol.value.fees24hUsd, 0),
              pools: protocol.value.pools,
              refreshedAt: protocol.value.refreshedAt === null ? null : t(protocol.value.refreshedAt),
            }
          : null,
        freshness: fresh(loaded || null, this.now(), this.options.staleMs),
      };
    } catch (error) {
      logger.warn('DAMM v2 data API unavailable', { dammPool, error: String(error) });
      return none(`the DAMM v2 data API did not answer (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private async readMarket(entry: LaunchRegistryEntry): Promise<MarketRead> {
    const pool = entry.dbcPool ? await this.options.reader.launchPool(entry.dbcPool, entry.dbcConfig ?? null) : null;
    const dammAddress = entry.dammPool ?? pool?.dammPool ?? this.options.ingester?.graduatedPool(entry.mint) ?? null;
    const damm = dammAddress ? await this.options.reader.dammPool(dammAddress) : null;
    return { pool, damm };
  }

  private unavailableMarket(item: LaunchItem): LaunchMarket {
    return {
      status: item.summary.status,
      venue: null,
      priceSol: null,
      priceUsd: null,
      solUsd: null,
      marketCapSol: null,
      marketCapUsd: null,
      raise: { targetSol: item.summary.raise.targetSol, raisedSol: 0, progressPct: 0, complete: false },
      liquiditySol: null,
      shareRevenuePerEpochSol: item.summary.shareRevenuePerEpochSol,
      pricedAtShareRevenuePerEpochSol: null,
      impliedYieldPctPerEpoch: null,
      graduation: {
        state: 'upcoming',
        dammPool: null,
        dammPoolUrl: null,
        meteoraUrl: null,
        graduatedEpoch: null,
        curveCompletedAt: null,
      },
      day: { volumeSol: 0, trades: 0, buys: 0, sells: 0, priceChangePct: null },
      indexed: null,
      freshness: { asOf: null, ageSeconds: null, stale: true },
    };
  }

  private async dammPoolOf(entry: LaunchRegistryEntry): Promise<string | null> {
    const learned = this.options.ingester?.graduatedPool(entry.mint);
    if (learned) return learned;
    const cache = this.cacheFor(this.markets, entry.mint, this.options.marketCacheMs, () => this.readMarket(entry));
    const read = await cache.get();
    return read.damm?.pool ?? read.pool?.dammPool ?? null;
  }

  // ── Trades and the ticket ───────────────────────────────────────────────────────────────────────

  private async tradeRef(entry: LaunchRegistryEntry): Promise<LaunchRef> {
    if (!entry.dbcPool && !entry.dammPool) {
      throw new LaunchTradeException('NOT_LAUNCHED', 'This token has no pool yet', 409);
    }
    const dammPool = entry.dammPool ?? (await this.dammPoolOf(entry).catch(() => null));
    return {
      dbcPool: entry.dbcPool ?? null,
      dbcConfig: entry.dbcConfig ?? null,
      dammPool,
      mint: entry.mint,
      decimals: entry.decimals,
    };
  }

  private checkTrade(request: TradeRequest): void {
    if (request.side === 'buy' && request.amount > this.options.maxBuySol) {
      throw new LaunchTradeException(
        'AMOUNT_TOO_LARGE',
        `Buys are capped at ${this.options.maxBuySol} SOL while the demo runs`,
        400,
        { maxSol: this.options.maxBuySol },
      );
    }
  }

  private async tradeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LaunchTradeError) {
        throw new LaunchTradeException(error.code, error.message, TRADE_ERROR_STATUS[error.code] ?? 409);
      }
      throw error;
    }
  }

  private tradeWarnings(priceImpactPct: number, item: LaunchItem): string[] {
    const warnings: string[] = [];
    if (this.options.network === 'mainnet') {
      warnings.push(
        'Mainnet: this trades real SOL. Revenue tokens can be securities in many countries; nothing here is an offer.',
      );
    } else {
      warnings.push(`${this.options.network} demo: no real value. Nothing here is an offer.`);
    }
    if (priceImpactPct >= 5) warnings.push(`High price impact: ${round(priceImpactPct, 2)}% (a small pool).`);
    if (item.summary.status === 'curve' && item.summary.raise.progressPct >= 90) {
      warnings.push('The raise is nearly complete: a buy can complete it, and the token then graduates to DAMM v2.');
    }
    return warnings;
  }

  private toTrade(row: StoredLaunchTrade, entry: LaunchRegistryEntry): LaunchTrade {
    const tokenAmount = fromBaseUnits(row.tokenAmount, entry.decimals);
    const feeSol = row.feeInToken
      ? fromBaseUnits(row.feeAmount, entry.decimals) * row.priceSol
      : fromBaseUnits(row.feeAmount, 9);
    return {
      id: `${row.signature}:${row.ix}`,
      signature: row.signature,
      t: isoIst(row.blockTime),
      slot: row.slot,
      venue: row.venue,
      side: row.side,
      trader: row.trader,
      solAmount: round(fromBaseUnits(row.solLamports, 9), 9),
      tokenAmount: round(tokenAmount, entry.decimals),
      priceSol: sig6(row.priceSol),
      postPriceSol: sig6(row.postPriceSol),
      feeSol: round(feeSol, 9),
      explorerUrl: this.explorerUrl('tx', row.signature),
    };
  }

  private toFeeEvent(row: StoredLaunchFeeEvent, entry: LaunchRegistryEntry): LaunchFeeEventRow {
    return {
      id: `${row.signature}:${row.ix}`,
      signature: row.signature,
      t: isoIst(row.blockTime),
      kind: row.kind,
      owner: row.owner,
      solAmount: round(fromBaseUnits(row.solLamports, 9), 9),
      tokenAmount: round(fromBaseUnits(row.tokenAmount, entry.decimals), entry.decimals),
      explorerUrl: this.explorerUrl('tx', row.signature),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

  private holderLabels(entry: LaunchRegistryEntry, escrow: string | null, treasury: string | null): HolderLabels {
    const labels: Record<string, string> = {
      [DBC_POOL_AUTHORITY]: 'Meteora curve vault',
      [DAMM_V2_POOL_AUTHORITY]: 'Meteora DAMM v2 pool',
    };
    if (escrow) labels[escrow] = 'Buyback escrow';
    if (treasury) labels[treasury] = "Epoch's treasury";
    if (entry.feeClaimer) labels[entry.feeClaimer] = "Epoch's treasury";
    if (entry.leftoverReceiver) labels[entry.leftoverReceiver] = labels[entry.leftoverReceiver] ?? 'Leftover receiver';
    if (entry.creator) labels[entry.creator] = `${entry.validator.name} (pool creator)`;
    return labels;
  }

  private async ingestStatus(entry: LaunchRegistryEntry): Promise<LaunchIngestStatus> {
    const ingester = this.options.ingester;
    const last = ingester?.lastPoll(entry.mint) ?? null;
    // The graduation event may predate this process: the curve names its DAMM v2 pool too.
    const damm = entry.dammPool ?? (entry.dbcPool ? await this.dammPoolOf(entry).catch(() => null) : null);
    const feed = ingester?.enabled ? ingester.feedStatus(entry.mint) : null;
    // A slow backstop poll (realtime healthy) is not staleness: allow two of its intervals.
    const staleMs = Math.max(this.options.staleMs, 2 * (feed?.pollSeconds ?? 0) * 1_000);
    return {
      running: !!ingester?.enabled,
      lastPollAt: last === null ? null : isoIst(new Date(last)),
      stale: !ingester?.enabled || last === null || this.now() - last > staleMs,
      pools: [
        ...(entry.dbcPool ? [{ address: entry.dbcPool, venue: 'dbc' as const }] : []),
        ...(damm ? [{ address: damm, venue: 'damm-v2' as const }] : []),
      ],
      mode: feed?.mode ?? 'polling',
      lagSeconds: feed?.lagSeconds ?? null,
      pollSeconds: feed?.pollSeconds ?? null,
    };
  }

  private cacheFor<T>(
    map: Map<string, SnapshotCache<T>>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): SnapshotCache<T> {
    let cache = map.get(key);
    if (!cache) {
      // Served stale for at most 3 TTLs while refreshing; older than that, callers wait for a fresh read.
      cache = new SnapshotCache(`launch.${key}`, ttlMs, load, ttlMs * 3, this.now);
      map.set(key, cache);
    }
    return cache;
  }

  private explorerUrl(kind: 'tx' | 'address', value: string): string {
    const { cluster, customRpc } = this.options.explorer;
    const query = customRpc
      ? `?cluster=custom&customUrl=${encodeURIComponent(customRpc)}`
      : cluster === 'mainnet'
        ? ''
        : `?cluster=${cluster}`;
    return `https://explorer.solana.com/${kind}/${value}${query}`;
  }

  private meta(source: string) {
    return { schemaVersion: 1 as const, kind: 'real' as const, asOf: isoIst(new Date(this.now())), source, note: '' };
  }
}
