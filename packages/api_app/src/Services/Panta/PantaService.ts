import { randomBytes } from 'crypto';

import { type PantaTradingConfig } from '@epoch/config-sdk';
import { base58Decode } from '@epoch/epoch-sdk';
import { EpochException, ServiceUnavailableException, UnauthorizedException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import {
  baseToUsdc,
  baseUnits,
  catalogAmount,
  compileUnsignedTransaction,
  decodeTransaction,
  isRetryablePantaError,
  messageHash,
  type PantaApi,
  PantaApiError,
  type PantaAttributedTrades,
  type PantaCreates,
  type PantaDashboard,
  PantaError,
  type PantaMarket,
  type PantaMarketList,
  type PantaMarketTrades,
  type PantaMetrics,
  type PantaPositions,
  transactionSignature,
  usdcToBase,
} from '@epoch/panta';

import { decodeSignature } from '../../Lib/Keys';
import { type SessionInfo } from '../../Lib/Session';
import { verifyEd25519 } from '../../Lib/Siws';
import { isoIst, shortKey } from '../../Lib/Stats';
import {
  type FeeIndexForecastCard,
  type PantaAccess,
  type PantaBuildView,
  type PantaCategoriesView,
  type PantaFeeIndexMarket,
  type PantaForecastStrike,
  type PantaForecastSummary,
  type PantaForecastView,
  type PantaMarketCard,
  type PantaMarketDetail,
  type PantaMarketsPage,
  type PantaMeta,
  type PantaPositionsView,
  type PantaPositionView,
  type PantaQuoteView,
  type PantaReview,
  type PantaSide,
  type PantaStatsView,
  type PantaStreamData,
  type PantaSubmitView,
  type PantaTapeRow,
  type PantaTradeState,
  type PantaTradeStatusView,
  type PantaTraction,
} from '../../types/Panta.types';
import {
  type PantaBuildBody,
  type PantaClaimBody,
  type PantaMarketsQuery,
  type PantaQuoteBody,
  type PantaSubmitBody,
} from '../../dto/Panta.dto';
import { crowdForecast, type StrikeQuote } from './CrowdForecast';
import { type BroadcastRejected, type PantaChain } from './PantaChain';
import { mapPanta } from './PantaErrors';
import {
  type PantaMarketReader,
  type PantaMarketRow,
  type PantaMarketTotals,
  type PantaTradeRecord,
  type PantaTradeStore,
  type PantaTradeTotals,
} from './PantaStores';
import { type IndexSnapshot, type IndexSnapshotSource, intelligenceFor, isGeoBlocked } from './PantaSupport';
import { type Timed, TimedCache } from './TimedCache';

const logger = Logger.create('PantaService');

export const PANTA_SOURCE = 'Panta public API (live-api.panta.market) through Epoch';
const POWERED = { poweredBy: 'Panta', poweredByUrl: 'https://panta.market' } as const;
/** Our markets shown with live prices (each is one cached detail read): two epochs of a full 5-strike ladder. */
const OUR_MARKETS_SHOWN = 10;
/** Catalog pages searched for `q`. */
const SEARCH_PAGES = 4;
/** Markets enriched with titles and prices on the positions view. */
const POSITION_MARKETS = 10;
/** A trade older than this is no longer chased for attribution. */
const ATTRIBUTION_WINDOW_MS = 48 * 3_600_000;
/** Attribution attempts before giving up on one trade. */
const MAX_REPORT_ATTEMPTS = 30;
/** Blocks past the transaction's last valid height before an unseen signature counts as expired. */
const EXPIRY_MARGIN_BLOCKS = 150;
/** Blocks a recent blockhash stays valid for (Solana's MAX_PROCESSING_AGE). */
const BLOCKHASH_LIFETIME_BLOCKS = 150;
/** Our markets read to find the epochs that have strikes (the forecast's epoch picker). */
const FORECAST_ROWS = 60;
/** Panta's typical primary fee (MarketConfig `primaryFeeBps`, 2%), as its metrics docs suggest for estimates. */
const PRIMARY_FEE_BPS = 200n;
/** Rows asked of Panta's account lists (its cap). */
const ACCOUNT_ROWS = 200;
/** Catalog pages of our own markets read for their all-time volume. */
const OWN_CATALOG_PAGES = 4;

export const FORECAST_DISCLAIMER =
  'Informational only, not advice. The crowd forecast is read from the YES prices of Epoch’s Panta markets on the ' +
  'epoch (one per strike) and a lognormal fitted through them; it is only as good as those markets’ liquidity.';

export interface RequestContext {
  /** From the trusted proxy's geo header. */
  country: string | null;
  /** The SIWS session, when signed in. */
  session?: SessionInfo;
}

export interface PantaServiceDeps {
  panta: PantaApi;
  config: PantaTradingConfig;
  /** Null without DATABASE_URL: trading and stats answer 503. */
  trades: PantaTradeStore | null;
  markets: PantaMarketReader | null;
  index: IndexSnapshotSource | null;
  chain: PantaChain;
  now?: () => number;
  /** Called after a submit, so the attribution job looks soon. */
  onSubmitted?: () => void;
}

export interface ReconcileResult {
  checked: number;
  confirmed: number;
  failed: number;
  expired: number;
  reported: number;
}

/**
 * Real-money Predict through Panta (decision of 3 Oct 2026): Epoch's Fee Index markets and Panta's catalog, quotes,
 * unsigned transactions for the user's wallet (never signed here), submission, status, positions, win claims and
 * attribution of every trade made through Epoch (POST /trades/, stored in panta_trades: the traction record).
 */
export class PantaService {
  private readonly now: () => number;
  private readonly details: TimedCache<PantaMarket>;
  private readonly lists: TimedCache<PantaMarketList>;
  private readonly tapes: TimedCache<PantaMarketTrades>;
  private readonly categoryCache: TimedCache<string[]>;
  private readonly positionCache: TimedCache<PantaPositions>;
  private readonly searchCache: TimedCache<PantaMarket[]>;
  private readonly orderStatus: TimedCache<string>;
  private readonly tractionCache: TimedCache<PantaAccountReads>;

  constructor(private readonly deps: PantaServiceDeps) {
    this.now = deps.now ?? Date.now;
    const ttl = deps.config.PANTA_CACHE_SECONDS * 1_000;
    const stale = 10 * 60_000;
    this.details = new TimedCache(ttl, stale, 1_000, this.now);
    this.lists = new TimedCache(ttl, stale, 200, this.now);
    this.tapes = new TimedCache(ttl, stale, 200, this.now);
    this.categoryCache = new TimedCache(3_600_000, 24 * 3_600_000, 1, this.now);
    this.positionCache = new TimedCache(10_000, 60_000, 2_000, this.now);
    this.searchCache = new TimedCache(60_000, stale, 50, this.now);
    this.orderStatus = new TimedCache(5_000, 5_000, 1_000, this.now);
    this.tractionCache = new TimedCache(120_000, 30 * 60_000, 1, this.now);
  }

  /** Trading routes answer: the switch is on and the server has an API key. */
  get tradingEnabled(): boolean {
    return this.deps.config.PANTA_TRADING_ENABLED && this.deps.panta.configured;
  }

  access(country: string | null): PantaAccess {
    const { config, panta } = this.deps;
    const geoBlocked = isGeoBlocked(country, config.PANTA_BLOCKED_COUNTRIES, config.PANTA_GEO_FAIL_CLOSED);
    let reason: string | null = null;
    if (!panta.configured) reason = 'Real-money Predict is not set up on this server yet';
    else if (!config.PANTA_TRADING_ENABLED) reason = 'Real-money trading is switched off right now';
    else if (geoBlocked && !country) reason = 'Trading needs your region, which could not be determined';
    else if (geoBlocked) reason = `Trading is not available in your region (${country})`;
    return {
      tradingEnabled: this.tradingEnabled,
      geoBlocked,
      country,
      reason,
      minTradeUsdc: config.PANTA_MIN_TRADE_USDC,
      maxTradeUsdc: config.PANTA_MAX_TRADE_USDC,
      signInRequired: true,
      network: 'solana-mainnet',
      currency: 'USDC',
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────────

  /** GET /v1/predict/panta/markets */
  async marketsPage(query: PantaMarketsQuery, ctx: RequestContext): Promise<PantaMarketsPage> {
    this.requireConfigured();
    const ours = await this.ourMarkets();
    const ourIds = new Set(ours.cards.map((card) => card.marketId));
    const reads: Timed<unknown>[] = [...ours.reads];
    let discover: PantaMarketsPage['discover'];
    if (query.q) {
      const scanned = await this.searchWindow(query.category, query.status);
      reads.push(scanned);
      const needle = query.q.toLowerCase();
      const hits = scanned.value.filter(
        (market) =>
          !ourIds.has(market.marketId) && `${market.title} ${market.description ?? ''}`.toLowerCase().includes(needle),
      );
      discover = {
        items: hits.slice(0, query.limit).map((market) => this.card(market, false)),
        nextCursor: null,
        category: query.category ?? null,
        q: query.q,
        searched: scanned.value.length,
      };
    } else {
      const key = `list:${query.category ?? ''}:${query.status ?? ''}:${query.cursor ?? ''}:${query.limit}`;
      const page = await mapPanta(() =>
        this.lists.get(key, () =>
          this.deps.panta.listMarkets({
            category: query.category,
            status: query.status,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      );
      reads.push(page);
      discover = {
        items: page.value.items.filter((m) => !ourIds.has(m.marketId)).map((market) => this.card(market, false)),
        nextCursor: page.value.nextCursor,
        category: query.category ?? null,
        q: null,
        searched: null,
      };
    }
    return { ...this.metaOf(reads), access: this.access(ctx.country), ours: ours.cards, discover };
  }

  /** GET /v1/predict/panta/markets/:marketId */
  async marketDetail(marketId: string, ctx: RequestContext): Promise<PantaMarketDetail> {
    this.requireConfigured();
    const detail = await mapPanta(() => this.details.get(marketId, () => this.deps.panta.getMarket(marketId)));
    const tape = await this.tapes
      .get(marketId, () => this.deps.panta.marketTrades(marketId, { limit: 50 }))
      .catch((error: unknown) => {
        logger.warn('market tape unavailable', { marketId, error: String(error) });
        return null;
      });
    const row = this.deps.markets ? await this.deps.markets.byMarketId(marketId) : null;
    const market = row ? this.feeIndexCard(row, detail, await this.snapshot()) : this.card(detail.value, false);
    const reads: Timed<unknown>[] = tape ? [detail, tape] : [detail];
    return {
      ...this.metaOf(reads, tape ? undefined : 'The trade tape could not be read just now.'),
      access: this.access(ctx.country),
      market,
      trades: (tape?.value.items ?? []).map(tapeRow),
    };
  }

  /** GET /v1/predict/panta/categories */
  async categories(): Promise<PantaCategoriesView> {
    this.requireConfigured();
    const read = await mapPanta(() =>
      this.categoryCache.get('categories', async () => (await this.deps.panta.categories()).categories),
    );
    return { ...this.metaOf([read]), categories: read.value };
  }

  /** GET /v1/predict/panta/positions?wallet= : holdings, claimability and a display-only value estimate. */
  async positions(wallet: string): Promise<PantaPositionsView> {
    this.requireConfigured();
    const read = await mapPanta(() => this.positionCache.get(wallet, () => this.deps.panta.positions(wallet)));
    const marketIds = [...new Set(read.value.positions.map((p) => p.marketId))].slice(0, POSITION_MARKETS);
    const details = new Map<string, PantaMarket>();
    await Promise.all(
      marketIds.map(async (id) => {
        const detail = await this.details.get(id, () => this.deps.panta.getMarket(id)).catch(() => null);
        if (detail) details.set(id, detail.value);
      }),
    );
    const ours = new Set<string>();
    if (this.deps.markets) {
      for (const id of marketIds) if (await this.deps.markets.byMarketId(id)) ours.add(id);
    }
    const positions = read.value.positions.map((position) =>
      positionView(position, details.get(position.marketId) ?? null, ours.has(position.marketId)),
    );
    return {
      ...this.metaOf([read]),
      wallet,
      positions,
      claimableCount: positions.filter((p) => p.state === 'claimable').length,
    };
  }

  /** GET /v1/predict/panta/stats */
  async stats(): Promise<PantaStatsView> {
    const { trades, markets } = this.requireStores();
    const [ours, created, wallets, reads] = await Promise.all([
      trades.totals(),
      markets.totals(new Date(this.now())),
      trades.wallets(10_000),
      this.accountReads(),
    ]);
    const m = reads?.value.metrics ?? null;
    return {
      ...this.metaOf(reads ? [reads] : [], m ? undefined : 'Panta’s account metrics could not be read.'),
      epoch: {
        trades: ours.trades,
        buys: ours.buys,
        claims: ours.claims,
        uniqueWallets: ours.uniqueWallets,
        volumeUsdc: baseToUsdc(BigInt(ours.volumeUsdcBase)),
        attributedTrades: ours.attributed,
        pendingAttribution: ours.pendingAttribution,
        marketsCreated: created.created,
        marketsLive: created.live,
        creationFeesPaidUsdc: baseToUsdc(BigInt(created.creationFeesPaidBase)),
        creatorFeesClaimedUsdc: baseToUsdc(BigInt(created.creatorFeesClaimedBase)),
        firstTradeAt: ours.firstTradeAt ? isoIst(ours.firstTradeAt) : null,
        lastTradeAt: ours.lastTradeAt ? isoIst(ours.lastTradeAt) : null,
      },
      panta: m
        ? {
            attributedTrades: m.summary.trades.total,
            attributedVolumeUsdc: baseToUsdc(BigInt(m.summary.trades.volumeUsdcBase)),
            byKind: m.summary.trades.byKind,
            creates: { total: m.summary.creates.total, byStatus: m.summary.creates.byStatus },
          }
        : null,
      traction: traction(reads, { ours, created, wallets }),
    };
  }

  /**
   * Panta's account endpoints for the traction record, read together and cached 2 minutes (stale copies up to 30
   * minutes when Panta cannot be read). Any of them may fail on its own; null when none answered.
   */
  private async accountReads(): Promise<Timed<PantaAccountReads> | null> {
    if (!this.deps.panta.configured) return null;
    const { panta } = this.deps;
    return this.tractionCache
      .get('traction', async () => {
        const settled = await Promise.allSettled([
          panta.dashboard(),
          panta.metrics({ limit: ACCOUNT_ROWS }),
          panta.creates({ limit: ACCOUNT_ROWS }),
          panta.attributedTrades({ limit: ACCOUNT_ROWS }),
          this.ownCatalog(),
        ]);
        const value = <T>(result: PromiseSettledResult<T>): T | null =>
          result.status === 'fulfilled' ? result.value : null;
        const reads: PantaAccountReads = {
          dashboard: value(settled[0]),
          metrics: value(settled[1]),
          creates: value(settled[2]),
          trades: value(settled[3]),
          catalog: value(settled[4]),
        };
        if (Object.values(reads).every((read) => read === null)) {
          throw (settled[0] as PromiseRejectedResult).reason;
        }
        return reads;
      })
      .catch((error: unknown) => {
        logger.warn('Panta account endpoints unreadable', { error: errorText(error) });
        return null;
      });
  }

  /** GET /markets/?createdBy=me, a few pages: Epoch's markets as Panta's catalog sees them (their volume). */
  private async ownCatalog(): Promise<PantaMarket[]> {
    const out: PantaMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < OWN_CATALOG_PAGES; page++) {
      const list = await this.deps.panta.listMarkets({ createdBy: 'me', cursor, limit: 50 });
      out.push(...list.items);
      if (!list.nextCursor) break;
      cursor = list.nextCursor;
    }
    return out;
  }

  // ── Crowd forecast ───────────────────────────────────────────────────────────────────────────────

  /**
   * GET /v1/predict/panta/forecast?epoch=: the crowd's forecast of one epoch's Fee Index from the YES prices of
   * Epoch's markets on it (one per strike). Default epoch: the soonest one whose markets still trade, else the newest.
   */
  async forecast(epoch?: number): Promise<PantaForecastView> {
    this.requireConfigured();
    const { markets } = this.requireStores();
    const recent = await markets.recent(FORECAST_ROWS);
    const epochs = [...new Set(recent.map((row) => row.epoch))].sort((a, b) => b - a);
    const target = epoch ?? defaultForecastEpoch(recent, this.now());
    const rows = target === null ? [] : await markets.forEpoch(target);
    const snapshot = await this.snapshot();
    const details = await Promise.all(
      rows.map((row) => {
        const marketId = row.marketId as string;
        return this.details.get(marketId, () => this.deps.panta.getMarket(marketId)).catch(() => null);
      }),
    );
    const reads = details.filter((detail): detail is Timed<PantaMarket> => detail !== null);
    const quotes = rows.map((row, i) => strikeQuote(row, details[i]?.value ?? null));
    const history = snapshot.history.map((point) => point.value);
    const newest = snapshot.history[0];
    const result = crowdForecast(quotes, history, target !== null && newest ? target - newest.epoch : 1);
    const lookback = history.slice(0, this.deps.config.PANTA_MODEL_LOOKBACK_EPOCHS);
    const strikes: PantaForecastStrike[] = rows.map((row, i) => {
      const point = result.points.find((p) => p.strike === row.threshold);
      const market = details[i]?.value ?? null;
      return {
        strikeMicroLamports: row.threshold,
        marketId: row.marketId as string,
        title: market?.title ?? row.title,
        phase: market?.phase ?? 'unknown',
        yesPrice: quotes[i].yesPrice,
        noPrice: quotes[i].noPrice,
        impliedProbability: point?.implied ?? null,
        fittedProbability: point?.fitted ?? null,
        curveProbability: point?.curve ?? null,
        empiricalProbability: lookback.length
          ? Math.round((lookback.filter((value) => value > row.threshold).length / lookback.length) * 10_000) / 10_000
          : null,
        volumeUsdc: market?.volumeUsdc ?? null,
      };
    });
    return {
      ...this.metaOf(reads, reads.length < rows.length ? 'Some of the markets’ prices could not be read.' : undefined),
      label: 'informational',
      disclaimer: FORECAST_DISCLAIMER,
      epoch: target,
      epochs,
      unit: 'µL/CU',
      strikes,
      fit: result.fit,
      median: result.median,
      expected: result.mean,
      band: result.band,
      lastValue: newest ? { epoch: newest.epoch, value: newest.value } : null,
      reason: target === null ? 'Epoch has no markets on Panta yet' : result.reason,
    };
  }

  /** GET /v1/index/forecast: the Terminal's Fee Index card; `available: false` instead of an error. */
  async forecastCard(): Promise<FeeIndexForecastCard> {
    const unavailable = (reason: string): FeeIndexForecastCard => ({
      available: false,
      reason,
      epoch: null,
      unit: 'µL/CU',
      median: null,
      expected: null,
      band: null,
      method: null,
      strikes: 0,
      ...POWERED,
      asOf: isoIst(new Date(this.now())),
      ageSeconds: 0,
      stale: false,
      details: null,
      disclaimer: FORECAST_DISCLAIMER,
    });
    if (!this.deps.panta.configured) return unavailable('Panta is not configured on this server');
    if (!this.deps.markets) return unavailable('No database: Epoch’s markets are unknown');
    let view: PantaForecastView;
    try {
      view = await this.forecast();
    } catch (error) {
      return unavailable(`The forecast could not be built: ${errorText(error)}`);
    }
    return {
      available: view.median !== null,
      reason: view.reason,
      epoch: view.epoch,
      unit: 'µL/CU',
      median: view.median,
      expected: view.expected,
      band: view.band,
      method: view.fit?.method ?? null,
      strikes: view.strikes.length,
      ...POWERED,
      asOf: view.asOf,
      ageSeconds: view.ageSeconds,
      stale: view.stale,
      details: view.epoch === null ? null : `/v1/predict/panta/forecast?epoch=${view.epoch}`,
      disclaimer: FORECAST_DISCLAIMER,
    };
  }

  /** WS `predict:panta`: our markets' prices and the model next to them. */
  async streamSnapshot(): Promise<PantaStreamData> {
    this.requireConfigured();
    const ours = await this.ourMarkets();
    const meta = this.metaOf(ours.reads);
    return {
      poweredBy: 'Panta',
      asOf: meta.asOf,
      stale: meta.stale,
      markets: ours.cards.map((card) => ({
        marketId: card.marketId,
        epoch: card.epoch,
        thresholdMicroLamports: card.thresholdMicroLamports,
        phase: card.phase,
        yesPrice: card.yesPrice,
        noPrice: card.noPrice,
        impliedProbability: card.intelligence.impliedProbability,
        modelProbability: card.intelligence.modelProbability,
        volumeUsdc: card.volumeUsdc,
      })),
      forecasts: await this.streamForecasts(ours.cards),
    };
  }

  /** The crowd forecast of each epoch in a frame, from the prices already read (no extra Panta calls). */
  private async streamForecasts(cards: PantaFeeIndexMarket[]): Promise<PantaForecastSummary[]> {
    if (cards.length === 0) return [];
    const snapshot = await this.snapshot();
    const history = snapshot.history.map((point) => point.value);
    const newest = snapshot.history[0];
    const epochs = [...new Set(cards.map((card) => card.epoch))].sort((a, b) => a - b);
    return epochs.map((epoch) => {
      const strikes = cards.filter((card) => card.epoch === epoch);
      const result = crowdForecast(
        strikes.map((card) => ({
          strike: card.thresholdMicroLamports,
          yesPrice: card.yesPrice,
          noPrice: card.noPrice,
          volumeUsdc: Number(card.volumeUsdc ?? 0) || 0,
        })),
        history,
        newest ? epoch - newest.epoch : 1,
      );
      return {
        epoch,
        median: result.median,
        expected: result.mean,
        band: result.band,
        method: result.fit?.method ?? null,
        strikes: strikes.length,
      };
    });
  }

  /** Re-reads our markets' prices (the stream poller); throws when Panta cannot be read. */
  async refreshPrices(): Promise<void> {
    if (!this.deps.markets) return;
    for (const row of await this.deps.markets.recent(OUR_MARKETS_SHOWN)) {
      const marketId = row.marketId as string;
      this.details.put(marketId, await this.deps.panta.getMarket(marketId));
    }
  }

  // ── Trading ──────────────────────────────────────────────────────────────────────────────────────

  /** POST /v1/predict/panta/quote: a ~90 s quote; nothing is signed. */
  async quote(body: PantaQuoteBody, _ctx: RequestContext): Promise<PantaQuoteView> {
    this.requireTrading();
    const amount = this.checkAmount(body.amountUsdc);
    const quote = await mapPanta(() =>
      this.deps.panta.quoteBuy({ wallet: body.wallet, marketId: body.marketId, side: body.side, amountUsdc: amount }),
    );
    const side = quote.side.toUpperCase();
    return {
      ...this.metaOf([]),
      quoteId: quote.quoteId,
      marketId: quote.marketId,
      side: quote.side,
      amountUsdc: quote.amountUsdc,
      feeUsdc: quote.feeUsdc,
      shares: quote.shares,
      avgPrice: quote.avgPrice,
      expiresAt: isoIst(new Date(Date.parse(quote.expiresAt) || this.now())),
      payoutIfWinUsdc: quote.shares,
      summary:
        `Buy ${side} for ${quote.amountUsdc} USDC: about ${quote.shares} shares at an average ${quote.avgPrice} USDC, ` +
        `Panta fee ${quote.feeUsdc} USDC. If ${side} wins the shares pay ${quote.shares} USDC; if not, nothing. ` +
        `Powered by Panta.`,
    };
  }

  /** POST /v1/predict/panta/build: the unsigned buy for the user's wallet, after explicit consent. */
  async build(body: PantaBuildBody, ctx: RequestContext): Promise<PantaBuildView> {
    this.requireTrading();
    const { trades } = this.requireStores();
    requireConsent(body.consent);
    const session = requireWallet(ctx.session, body.wallet);
    const build = await mapPanta(() =>
      this.deps.panta.buildBuy({ quoteId: body.quoteId, wallet: body.wallet, maxSlippageBps: body.maxSlippageBps }),
    );
    if (build.wallet !== body.wallet) throw badResponse('the build is for another wallet');
    this.checkAmount(build.amountUsdc);
    const unsigned = compile(body.wallet, build.recentBlockhash, build.instructions);
    const lastValidBlockHeight = await this.lastValidOf(build.lastValidBlockHeight);
    const title = await this.titleOf(build.marketId);
    const side = build.side.toUpperCase();
    const slippage = body.maxSlippageBps ?? 100;
    const summary =
      `Buy ${side} on "${title}" for ${build.amountUsdc} USDC (Panta fee ${build.feeUsdc ?? 'included'} USDC, about ` +
      `${build.expectedShares} shares, price may move up to ${slippage / 100}%). Wallet ${shortKey(body.wallet)} pays ` +
      `in USDC on Solana mainnet. Shares pay 1 USDC each if ${side} wins, nothing if not. Powered by Panta.`;
    const review: PantaReview = {
      action: 'buy',
      marketId: build.marketId,
      market: title,
      side: build.side,
      amountUsdc: build.amountUsdc,
      feeUsdc: build.feeUsdc,
      expectedShares: build.expectedShares,
      maxSlippageBps: slippage,
      wallet: body.wallet,
      network: 'solana-mainnet',
    };
    const tradeId = newTradeId();
    await trades.insert({
      id: tradeId,
      kind: 'buy',
      wallet: body.wallet,
      marketId: build.marketId,
      side: build.side,
      amountUsdc: build.amountUsdc,
      amountUsdcBase: Number(usdcToBase(build.amountUsdc)),
      feeUsdc: build.feeUsdc,
      expectedShares: build.expectedShares,
      quoteId: build.quoteId ?? body.quoteId,
      orderId: build.orderId,
      messageHash: unsigned.messageHash,
      lastValidBlockHeight,
      summary,
      consentAt: new Date(this.now()),
      sessionAddress: session.address,
      country: ctx.country,
    });
    return {
      ...this.metaOf([]),
      tradeId,
      action: 'buy',
      transaction: unsigned.transaction,
      recentBlockhash: build.recentBlockhash,
      lastValidBlockHeight,
      orderId: build.orderId,
      expiresAt: build.expiresAt ? isoIst(new Date(Date.parse(build.expiresAt) || this.now())) : null,
      summary,
      review,
    };
  }

  /** POST /v1/predict/panta/claim/build: the unsigned win claim, after explicit consent. */
  async claimBuild(body: PantaClaimBody, ctx: RequestContext): Promise<PantaBuildView> {
    this.requireTrading();
    const { trades } = this.requireStores();
    requireConsent(body.consent);
    const session = requireWallet(ctx.session, body.wallet);
    const claim = await mapPanta(() => this.deps.panta.buildWinClaim({ wallet: body.wallet, marketId: body.marketId }));
    if (claim.wallet !== body.wallet) throw badResponse('the claim is for another wallet');
    const unsigned = compile(body.wallet, claim.recentBlockhash, claim.instructions);
    const lastValidBlockHeight = await this.lastValidOf(claim.lastValidBlockHeight);
    const title = await this.titleOf(claim.marketId);
    const outcome = claim.outcome === 'yes' || claim.outcome === 'no' ? claim.outcome : null;
    const summary =
      `Claim winnings on "${title}": ${claim.winningShares} winning ${claim.outcome.toUpperCase()} shares, about ` +
      `${claim.winningShares} USDC to wallet ${shortKey(body.wallet)} on Solana mainnet. Powered by Panta.`;
    const tradeId = newTradeId();
    const amountBase = /^\d+(\.\d{1,6})?$/.test(claim.winningShares) ? Number(usdcToBase(claim.winningShares)) : null;
    await trades.insert({
      id: tradeId,
      kind: 'claim',
      wallet: body.wallet,
      marketId: claim.marketId,
      side: outcome,
      amountUsdc: claim.winningShares,
      amountUsdcBase: amountBase,
      feeUsdc: null,
      expectedShares: claim.winningShares,
      quoteId: null,
      orderId: null,
      messageHash: unsigned.messageHash,
      lastValidBlockHeight,
      summary,
      consentAt: new Date(this.now()),
      sessionAddress: session.address,
      country: ctx.country,
    });
    return {
      ...this.metaOf([]),
      tradeId,
      action: 'claim',
      transaction: unsigned.transaction,
      recentBlockhash: claim.recentBlockhash,
      lastValidBlockHeight,
      orderId: null,
      expiresAt: null,
      summary,
      review: {
        action: 'claim',
        marketId: claim.marketId,
        market: title,
        side: outcome,
        amountUsdc: claim.winningShares,
        feeUsdc: null,
        expectedShares: claim.winningShares,
        maxSlippageBps: null,
        wallet: body.wallet,
        network: 'solana-mainnet',
      },
    };
  }

  /**
   * live: Panta may leave `lastValidBlockHeight` out of a build (the playground types it optional). A blockhash lives
   * 150 blocks and Panta fetched it before this call, so our height + 150 is an upper bound: a trade is never marked
   * expired while it could still land.
   */
  private async lastValidOf(fromPanta: number | null): Promise<number> {
    if (fromPanta !== null) return fromPanta;
    try {
      return (await this.deps.chain.blockHeight()) + BLOCKHASH_LIFETIME_BLOCKS;
    } catch {
      throw new EpochException('Could not reach Solana: try again', 'RPC_UNAVAILABLE', 502);
    }
  }

  /**
   * POST /v1/predict/panta/submit: the wallet-signed transaction (Epoch broadcasts it) or the signature of one the
   * wallet broadcast. The signature is recorded before the broadcast; Panta is told (buys); attribution follows.
   */
  async submit(body: PantaSubmitBody, ctx: RequestContext): Promise<PantaSubmitView> {
    this.requireTrading();
    const { trades } = this.requireStores();
    const trade = await this.requireTrade(body.tradeId);
    requireWallet(ctx.session, trade.wallet);

    const signed = body.signedTransaction ? this.checkSigned(trade, body.signedTransaction) : null;
    const signature = signed?.signature ?? checkSignature(body.signature);
    const broadcastBy = signed ? 'epoch' : 'wallet';

    if (trade.status !== 'built') {
      if (trade.signature !== signature) {
        throw new EpochException('This trade was already submitted', 'TRADE_ALREADY_SUBMITTED', 409, {
          status: trade.status,
        });
      }
      // The same submission again (a retry after a timeout): send it once more if we hold it, harmless if it landed.
      if (signed && trade.status === 'submitted') await this.broadcast(trade, signed.bytes, false);
      return this.submitView(trade.id, signature, trade.status as PantaTradeState, broadcastBy);
    }
    if (!(await trades.markSubmitted(trade.id, signature))) {
      throw new EpochException('This transaction was already submitted', 'TRADE_ALREADY_SUBMITTED', 409);
    }
    let status: PantaTradeState = 'submitted';
    if (signed && !(await this.broadcast(trade, signed.bytes, true))) status = 'failed';
    if (status === 'submitted' && trade.kind === 'buy' && trade.orderId) {
      const orderId = trade.orderId;
      await this.deps.panta
        .submitBuy({ orderId, signature, wallet: trade.wallet })
        .catch((error: unknown) =>
          logger.warn('Panta submit failed; attribution still follows', { error: describe(error) }),
        );
    }
    this.deps.onSubmitted?.();
    return this.submitView(trade.id, signature, status, broadcastBy);
  }

  /** GET /v1/predict/panta/status/:tradeId */
  async status(tradeId: string): Promise<PantaTradeStatusView> {
    this.requireStores();
    let trade = await this.requireTrade(tradeId);
    if (trade.status === 'submitted' || (trade.status === 'confirmed' && trade.reportStatus === 'pending')) {
      await this.reconcileOne(trade).catch((error: unknown) =>
        logger.warn('status check failed', { tradeId, error: describe(error) }),
      );
      trade = await this.requireTrade(tradeId);
    }
    let orderStatus: string | null = null;
    if (trade.kind === 'buy' && trade.orderId && this.deps.panta.configured) {
      const orderId = trade.orderId;
      const read = await this.orderStatus
        .get(orderId, async () => {
          const verify = await this.deps.panta.verifyBuy({
            orderId,
            signature: trade.signature ?? undefined,
            wallet: trade.wallet,
          });
          return verify.status;
        })
        .catch(() => null);
      orderStatus = read?.value ?? null;
    }
    return {
      ...this.metaOf([]),
      tradeId: trade.id,
      action: trade.kind as 'buy' | 'claim',
      status: trade.status as PantaTradeState,
      signature: trade.signature,
      explorerUrl: trade.signature ? explorerTx(trade.signature) : null,
      marketId: trade.marketId,
      side: (trade.side as PantaSide | null) ?? null,
      amountUsdc: trade.amountUsdc,
      orderStatus,
      attribution: trade.reportStatus as PantaTradeStatusView['attribution'],
    };
  }

  /**
   * The attribution job: every submitted trade is followed on chain until confirmed (or failed / expired), and every
   * confirmed one is reported to Panta (POST /trades/, idempotent per signature) until Panta processes it.
   */
  async reconcile(limit = 50): Promise<ReconcileResult> {
    const result: ReconcileResult = { checked: 0, confirmed: 0, failed: 0, expired: 0, reported: 0 };
    if (!this.deps.trades || !this.deps.panta.configured) return result;
    const pending = await this.deps.trades.pending(new Date(this.now() - ATTRIBUTION_WINDOW_MS), limit);
    if (pending.length === 0) return result;
    const submitted = pending.filter((trade) => trade.status === 'submitted' && trade.signature);
    const states = submitted.length
      ? await this.deps.chain.statuses(submitted.map((trade) => trade.signature as string))
      : new Map<string, string>();
    const height = submitted.some((t) => states.get(t.signature as string) === 'unknown')
      ? await this.deps.chain.blockHeight().catch(() => null)
      : null;
    for (const trade of pending) {
      result.checked++;
      let status = trade.status;
      if (status === 'submitted') {
        status = await this.settleFrom(trade, states.get(trade.signature as string) ?? 'unknown', height);
        if (status === 'confirmed') result.confirmed++;
        if (status === 'failed') result.failed++;
        if (status === 'expired') result.expired++;
      }
      if (status === 'confirmed') {
        const outcome = await this.report(trade);
        if (outcome === 'processed') result.reported++;
        if (outcome === 'stop') break;
      }
    }
    if (result.reported + result.confirmed + result.failed + result.expired > 0) {
      logger.info('attribution pass', { ...result });
    }
    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────────

  private async reconcileOne(trade: PantaTradeRecord): Promise<void> {
    let status = trade.status;
    if (status === 'submitted' && trade.signature) {
      const state = (await this.deps.chain.statuses([trade.signature])).get(trade.signature) ?? 'unknown';
      const height = state === 'unknown' ? await this.deps.chain.blockHeight().catch(() => null) : null;
      status = await this.settleFrom(trade, state, height);
    }
    if (status === 'confirmed' && trade.reportStatus === 'pending' && this.deps.panta.configured) {
      await this.report(trade);
    }
  }

  private async settleFrom(trade: PantaTradeRecord, state: string, height: number | null): Promise<string> {
    const trades = this.deps.trades as PantaTradeStore;
    if (state === 'confirmed' || state === 'failed') {
      await trades.settle(trade.id, state);
      return state;
    }
    const lastValid = trade.lastValidBlockHeight;
    if (height !== null && lastValid !== null && height > lastValid + EXPIRY_MARGIN_BLOCKS) {
      await trades.settle(trade.id, 'expired');
      return 'expired';
    }
    return trade.status;
  }

  /** Reports one confirmed trade; 'stop' when Panta is rate-limiting (the rest wait for the next pass). */
  private async report(trade: PantaTradeRecord): Promise<'processed' | 'pending' | 'failed' | 'stop'> {
    const trades = this.deps.trades as PantaTradeStore;
    try {
      const answer = await this.deps.panta.reportTrade({
        signature: trade.signature as string,
        wallet: trade.wallet,
        marketId: trade.marketId,
        quoteId: trade.quoteId ?? undefined,
        clientOrderId: trade.id,
      });
      const processed = answer.status === 'processed';
      await trades.recordReport(trade.id, {
        status: processed ? 'processed' : 'pending',
        error: processed ? undefined : `Panta: ${answer.status}`,
      });
      return processed ? 'processed' : 'pending';
    } catch (error) {
      if (isRetryablePantaError(error)) return 'stop';
      const final = PantaApiError.is(error, 'TX_FAILED', 'TX_MISMATCH', 'TX_FEE_MISMATCH');
      const exhausted = trade.reportAttempts + 1 >= MAX_REPORT_ATTEMPTS;
      const status = final || exhausted ? 'failed' : 'pending';
      await trades.recordReport(trade.id, { status, error: describe(error) });
      if (status === 'failed')
        logger.warn('attribution failed for a trade', { tradeId: trade.id, error: describe(error) });
      return status;
    }
  }

  /** Our Fee Index markets with prices (cached reads) and intelligence. */
  private async ourMarkets(): Promise<{ cards: PantaFeeIndexMarket[]; reads: Timed<unknown>[] }> {
    if (!this.deps.markets) return { cards: [], reads: [] };
    const rows = await this.deps.markets.recent(OUR_MARKETS_SHOWN);
    if (rows.length === 0) return { cards: [], reads: [] };
    const snapshot = await this.snapshot();
    const details = await Promise.all(
      rows.map((row) => {
        const marketId = row.marketId as string;
        return this.details.get(marketId, () => this.deps.panta.getMarket(marketId)).catch(() => null);
      }),
    );
    const reads = details.filter((detail): detail is Timed<PantaMarket> => detail !== null);
    return { cards: rows.map((row, i) => this.feeIndexCard(row, details[i], snapshot)), reads };
  }

  private async snapshot(): Promise<IndexSnapshot> {
    const empty: IndexSnapshot = { history: [], last: null, running: null };
    if (!this.deps.index) return empty;
    return this.deps.index.get().catch(() => empty);
  }

  private feeIndexCard(
    row: PantaMarketRow,
    detail: Timed<PantaMarket> | null,
    snapshot: IndexSnapshot,
  ): PantaFeeIndexMarket {
    const base: PantaMarketCard = detail
      ? this.card(detail.value, true)
      : {
          marketId: row.marketId as string,
          title: row.title,
          description: row.description,
          category: 'crypto',
          phase: 'unknown',
          status: null,
          imageUrl: row.imageUrl,
          yesPrice: null,
          noPrice: null,
          volumeUsdc: null,
          startsAt: row.startTime ? isoIst(row.startTime) : null,
          endsAt: row.endTime ? isoIst(row.endTime) : null,
          resolvesAt: row.resolutionTime ? isoIst(row.resolutionTime) : null,
          resolved: false,
          ours: true,
          tradable: false,
        };
    return {
      ...base,
      ours: true,
      epoch: row.epoch,
      thresholdMicroLamports: row.threshold,
      question: row.question,
      resolutionRule: row.resolutionRule,
      sourcesOfTruth: row.sourcesOfTruth,
      resolutionUrl: row.sourcesOfTruth[0] ?? '',
      pricesAsOf: detail ? isoIst(new Date(detail.at)) : null,
      pricesStale: detail?.stale ?? false,
      intelligence: intelligenceFor(
        snapshot,
        row.threshold,
        base.yesPrice,
        this.deps.config.PANTA_MODEL_LOOKBACK_EPOCHS,
      ),
    };
  }

  private card(market: PantaMarket, ours: boolean): PantaMarketCard {
    const ends = market.endTime === null ? null : market.endTime * 1_000;
    return {
      marketId: market.marketId,
      title: market.title,
      description: market.description,
      category: market.category,
      phase: market.phase,
      status: market.status,
      imageUrl: market.images[0] ?? null,
      yesPrice: spotPrice(market, 'yes'),
      noPrice: spotPrice(market, 'no'),
      volumeUsdc: market.volumeUsdc,
      startsAt: market.startTime === null ? null : isoIst(new Date(market.startTime * 1_000)),
      endsAt: ends === null ? null : isoIst(new Date(ends)),
      resolvesAt: market.resolutionTime === null ? null : isoIst(new Date(market.resolutionTime * 1_000)),
      resolved: market.resolved,
      ours,
      tradable: market.phase === 'primary' && !market.resolved && (ends === null || ends > this.now()),
    };
  }

  /** Up to 4 catalog pages (200 markets) for a search, cached a minute. */
  private searchWindow(category?: string, status?: PantaMarketsQuery['status']): Promise<Timed<PantaMarket[]>> {
    return mapPanta(() =>
      this.searchCache.get(`search:${category ?? ''}:${status ?? ''}`, async () => {
        const out: PantaMarket[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < SEARCH_PAGES; page++) {
          const list = await this.deps.panta.listMarkets({ category, status, cursor, limit: 50 });
          out.push(...list.items);
          if (!list.nextCursor) break;
          cursor = list.nextCursor;
        }
        return out;
      }),
    );
  }

  private async titleOf(marketId: string): Promise<string> {
    const cached = this.details.peek(marketId);
    if (cached) return cached.value.title;
    const detail = await this.details.get(marketId, () => this.deps.panta.getMarket(marketId)).catch(() => null);
    return detail?.value.title ?? `market ${shortKey(marketId)}`;
  }

  /** Freshness of a payload built from several reads: the oldest read's time, stale if any read is. */
  private metaOf(reads: Timed<unknown>[], note?: string): PantaMeta {
    const now = this.now();
    const at = reads.length ? Math.min(...reads.map((read) => read.at)) : now;
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(new Date(at)),
      source: PANTA_SOURCE,
      ...POWERED,
      ageSeconds: Math.max(0, Math.round((now - at) / 1_000)),
      stale: reads.some((read) => read.stale),
      ...(note ? { note } : {}),
    };
  }

  private submitView(
    tradeId: string,
    signature: string,
    status: PantaTradeState,
    broadcastBy: 'epoch' | 'wallet',
  ): PantaSubmitView {
    return { ...this.metaOf([]), tradeId, signature, status, broadcastBy, explorerUrl: explorerTx(signature) };
  }

  /** Decodes the wallet-signed transaction: exactly the message we built, signed by the trade's wallet. */
  private checkSigned(trade: PantaTradeRecord, base64: string): { signature: string; bytes: Uint8Array } {
    let tx;
    try {
      tx = decodeTransaction(base64);
    } catch {
      throw new EpochException('signedTransaction is not a Solana transaction', 'TX_INVALID', 400);
    }
    if (messageHash(tx) !== trade.messageHash) {
      throw new EpochException('The signed transaction is not the one built for this trade', 'TX_MODIFIED', 400);
    }
    const signature = transactionSignature(tx);
    const signatureBytes = tx.signatures[0];
    if (!signature || !verifyEd25519(tx.message.serialize(), signatureBytes, base58Decode(trade.wallet))) {
      throw new EpochException('The transaction is not signed by the trade’s wallet', 'TX_NOT_SIGNED', 400);
    }
    return { signature, bytes: tx.serialize() };
  }

  /** Sends to mainnet; false (and the trade marked failed) when the cluster refuses it. */
  private async broadcast(trade: PantaTradeRecord, bytes: Uint8Array, first: boolean): Promise<boolean> {
    try {
      await this.deps.chain.broadcast(bytes);
      return true;
    } catch (error) {
      if ((error as BroadcastRejected).name === 'BroadcastRejected') {
        if (!first) return true; // a re-send of something that already landed is refused: fine
        await this.deps.trades?.settle(trade.id, 'failed');
        throw new EpochException('The network rejected the transaction', 'TX_REJECTED', 400, {
          reason: (error as BroadcastRejected).message,
          logs: (error as BroadcastRejected).logs,
        });
      }
      // RPC trouble: the signature is recorded; the attribution job finds out whether it landed.
      logger.warn('broadcast failed; the signature is recorded and will be followed', { error: describe(error) });
      if (first) throw new EpochException('Could not reach Solana: try submitting again', 'RPC_UNAVAILABLE', 502);
      return true;
    }
  }

  private checkAmount(amount: string): string {
    const { PANTA_MIN_TRADE_USDC: min, PANTA_MAX_TRADE_USDC: max } = this.deps.config;
    const base = usdcToBase(amount);
    if (base < usdcToBase(min) || base > usdcToBase(max)) {
      throw new EpochException(`Trades are ${min}–${max} USDC`, 'PANTA_AMOUNT_OUT_OF_RANGE', 400, {
        minUsdc: min,
        maxUsdc: max,
      });
    }
    return baseToUsdc(base);
  }

  private async requireTrade(tradeId: string): Promise<PantaTradeRecord> {
    const trade = await (this.deps.trades as PantaTradeStore).get(tradeId);
    if (!trade) throw new EpochException('No such trade', 'TRADE_NOT_FOUND', 404, { tradeId });
    return trade;
  }

  private requireConfigured(): void {
    if (!this.deps.panta.configured) {
      throw new ServiceUnavailableException(
        'Real-money Predict is not configured on this server',
        'PANTA_NOT_CONFIGURED',
      );
    }
  }

  private requireTrading(): void {
    this.requireConfigured();
    if (!this.deps.config.PANTA_TRADING_ENABLED) {
      throw new ServiceUnavailableException('Real-money trading is switched off', 'PANTA_TRADING_DISABLED');
    }
  }

  private requireStores(): { trades: PantaTradeStore; markets: PantaMarketReader } {
    if (!this.deps.trades || !this.deps.markets) {
      throw new ServiceUnavailableException('This feature needs Postgres: set DATABASE_URL', 'DATABASE_NOT_CONFIGURED');
    }
    return { trades: this.deps.trades, markets: this.deps.markets };
  }
}

function requireConsent(consent: boolean | undefined): void {
  if (consent !== true) {
    throw new EpochException('Confirm the trade summary first: send consent: true', 'CONSENT_REQUIRED', 400);
  }
}

/** The signed-in wallet must be the one trading (401 signed out, 403 another wallet). */
function requireWallet(session: SessionInfo | undefined, wallet: string): SessionInfo {
  if (!session) throw new UnauthorizedException('Sign in with your wallet first', { reason: 'SIGNED_OUT' });
  if (session.address !== wallet) {
    throw new EpochException('Sign in with the wallet that trades', 'WALLET_MISMATCH', 403, {
      signedIn: shortKey(session.address),
    });
  }
  return session;
}

function compile(
  wallet: string,
  recentBlockhash: string,
  instructions: Parameters<typeof compileUnsignedTransaction>[0]['instructions'],
) {
  try {
    return compileUnsignedTransaction({ payer: wallet, recentBlockhash, instructions });
  } catch (error) {
    throw badResponse(error instanceof Error ? error.message : 'unusable instructions');
  }
}

function checkSignature(signature: string | undefined): string {
  if (!signature || !decodeSignature(signature) || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) {
    throw new EpochException('signature must be the base58 transaction signature', 'BAD_REQUEST', 400);
  }
  return signature;
}

const badResponse = (why: string): EpochException =>
  new EpochException(`Panta returned an unusable transaction: ${why}`, 'PANTA_BAD_RESPONSE', 502);

const newTradeId = (): string => `ptr_${randomBytes(12).toString('base64url')}`;

const explorerTx = (signature: string): string => `https://explorer.solana.com/tx/${signature}`;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What Panta's account endpoints said (each may be missing). */
interface PantaAccountReads {
  dashboard: PantaDashboard | null;
  metrics: PantaMetrics | null;
  creates: PantaCreates | null;
  trades: PantaAttributedTrades | null;
  catalog: PantaMarket[] | null;
}

/** An integer base-unit string → bigint, or null (never throws). */
function baseOrNull(text: string | null | undefined): bigint | null {
  return text !== null && text !== undefined && /^\d+$/.test(text) ? baseUnits(text) : null;
}

/** A decimal USDC string → base units, or null (never throws). */
function decimalBaseOrNull(text: string | null | undefined): bigint | null {
  return text !== null && text !== undefined && /^\d{1,15}(\.\d{1,6})?$/.test(text) ? usdcToBase(text) : null;
}

/** A market's all-time volume in base units: the total when Panta sends it, else the active volume. */
function volumeBaseOf(market: PantaMarket): bigint {
  return (
    baseOrNull(market.totalVolumeUsdcBase) ??
    decimalBaseOrNull(market.totalVolumeUsdc) ??
    baseOrNull(market.volumeUsdcBase) ??
    decimalBaseOrNull(market.volumeUsdc) ??
    0n
  );
}

/** Pure: the traction block from Panta's account reads (when any answered) and Epoch's own records. */
function traction(
  read: Timed<PantaAccountReads> | null,
  own: { ours: PantaTradeTotals; created: PantaMarketTotals; wallets: string[] },
): PantaTraction {
  const r = read?.value ?? null;
  const creates = r?.creates?.summary ?? r?.metrics?.summary.creates ?? r?.dashboard?.metrics.creates ?? null;
  const trades = r?.metrics?.summary.trades ?? r?.trades?.summary ?? r?.dashboard?.metrics.trades ?? null;
  const rows = [...(r?.trades?.items ?? []), ...(r?.metrics?.trades ?? [])];
  const seen = new Set(rows.map((row) => row.signature)).size;
  const traders = new Set([...own.wallets, ...rows.map((row) => row.wallet)]);
  const attributedBase = baseOrNull(trades?.volumeUsdcBase) ?? BigInt(own.ours.volumeUsdcBase);
  const dashboard = r?.dashboard ?? null;
  return {
    asOf: read ? isoIst(new Date(read.at)) : null,
    stale: read?.stale ?? false,
    account: dashboard
      ? {
          status: dashboard.account.status,
          canCreateMarkets: dashboard.permissions.canCreateMarkets ?? dashboard.account.canCreateMarkets,
        }
      : null,
    marketsCreated: creates ? (creates.byStatus.registered ?? 0) : own.created.created,
    createsByStatus: creates?.byStatus ?? {},
    attributedVolumeUsdc: baseToUsdc(attributedBase),
    marketsVolumeUsdc: r?.catalog
      ? baseToUsdc(r.catalog.reduce((sum, market) => sum + volumeBaseOf(market), 0n))
      : null,
    traders: traders.size,
    tradersComplete: trades ? seen >= trades.total : true,
    attributedTrades: trades?.total ?? own.ours.attributed,
    tradesByKind: trades?.byKind ?? {},
    creatorFeesClaimedUsdc: baseToUsdc(BigInt(own.created.creatorFeesClaimedBase)),
    creationFeesPaidUsdc: baseToUsdc(BigInt(own.created.creationFeesPaidBase)),
    estimatedProtocolFeesUsdc: baseToUsdc((BigInt(own.ours.volumeUsdcBase) * PRIMARY_FEE_BPS) / 10_000n),
    sources: {
      dashboard: Boolean(r?.dashboard),
      metrics: Boolean(r?.metrics),
      creates: Boolean(r?.creates),
      trades: Boolean(r?.trades),
      catalog: Boolean(r?.catalog),
    },
  };
}

/** The soonest epoch whose markets still trade; else the newest epoch with markets; null without markets. */
function defaultForecastEpoch(rows: PantaMarketRow[], now: number): number | null {
  if (rows.length === 0) return null;
  const open = rows.filter((row) => row.endTime !== null && row.endTime.getTime() > now).map((row) => row.epoch);
  return open.length ? Math.min(...open) : Math.max(...rows.map((row) => row.epoch));
}

/** One strike's quote for the forecast. */
function strikeQuote(row: PantaMarketRow, market: PantaMarket | null): StrikeQuote {
  return {
    strike: row.threshold,
    yesPrice: market ? spotPrice(market, 'yes') : null,
    noPrice: market ? spotPrice(market, 'no') : null,
    volumeUsdc: market ? Number(baseToUsdc(volumeBaseOf(market))) : 0,
  };
}

/** The spot price of one side, as Panta's playground reads it: the live price, else the phase's price. */
function spotPrice(market: PantaMarket, side: PantaSide): number | null {
  return side === 'yes'
    ? price(market.yesPrice ?? market.secondaryYesPrice ?? market.primaryYesPrice)
    : price(market.noPrice ?? market.secondaryNoPrice ?? market.primaryNoPrice);
}

/** A decimal price string → 0–1, or null. */
function price(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * One row of Panta's public tape. live: share and fee amounts arrive in 1e6 base units (the docs show decimals;
 * `catalogAmount` reads both) and every field may be missing.
 */
function tapeRow(row: PantaMarketTrades['items'][number]): PantaTapeRow {
  const yesShares = catalogAmount(row.yesAmount) ?? '0';
  const noShares = catalogAmount(row.noAmount) ?? '0';
  const yes = Number(yesShares) > 0;
  const no = Number(noShares) > 0;
  let side: PantaTapeRow['side'] = yes && no ? 'both' : yes ? 'yes' : no ? 'no' : null;
  if (row.side === 'yes' || row.side === 'no') side = row.side;
  let amountUsdc = row.amountUsdc;
  if (amountUsdc === null && row.amountUsdcBase !== null && /^\d+$/.test(row.amountUsdcBase)) {
    amountUsdc = baseToUsdc(baseUnits(row.amountUsdcBase));
  }
  return {
    walletShort: row.wallet ? shortKey(row.wallet) : null,
    side,
    yesShares,
    noShares,
    feeUsdc: catalogAmount(row.feePaid),
    amountUsdc,
    kind: row.kind,
    isPrimary: row.isPrimary,
    at: row.blockTime === null ? null : isoIst(new Date(row.blockTime * 1_000)),
    signature: row.signature,
  };
}

function positionView(
  position: PantaPositions['positions'][number],
  market: PantaMarket | null,
  ours: boolean,
): PantaPositionView {
  const outcome = position.outcome === 'yes' || position.outcome === 'no' ? position.outcome : null;
  let state: PantaPositionView['state'] = 'open';
  if (position.phase === 'cancelled') state = 'cancelled';
  else if (position.claimed) state = 'claimed';
  else if (position.claimable) state = 'claimable';
  else if (outcome) state = position.side === outcome ? 'won' : 'lost';
  const spot = market ? price(position.side === 'yes' ? market.yesPrice : market.noPrice) : null;
  const shares = Number(position.shares);
  let estValue: string | null = null;
  if (Number.isFinite(shares)) {
    if (state === 'open' && spot !== null) estValue = (shares * spot).toFixed(2);
    if (state === 'won' || state === 'claimable') estValue = shares.toFixed(2);
    if (state === 'lost') estValue = '0.00';
  }
  return {
    marketId: position.marketId,
    title: market?.title ?? null,
    ours,
    side: position.side,
    shares: position.shares,
    phase: position.phase,
    claimable: position.claimable,
    claimed: position.claimed,
    outcome,
    price: state === 'open' ? spot : null,
    estValueUsdc: estValue,
    state,
  };
}

function describe(error: unknown): string {
  if (error instanceof PantaApiError) return `${error.code}: ${error.message}`;
  if (error instanceof PantaError) return error.message;
  if (error instanceof EpochException) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
