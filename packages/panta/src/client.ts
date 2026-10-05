import { sleep as realSleep } from '@epoch/common';
import { type z } from '@epoch/common/pkg/zod';
import { getTraceId, Logger } from '@epoch/logger';

import { type PantaFamily, RequestBudget } from './budget';
import {
  type PantaApiError,
  pantaApiError,
  PantaConfigError,
  PantaInputError,
  PantaNetworkError,
  PantaResponseError,
} from './errors';
import {
  type PantaAccount,
  PantaAccountSchema,
  type PantaAttributedTrades,
  PantaAttributedTradesSchema,
  type PantaBuyBuild,
  PantaBuyBuildSchema,
  type PantaBuyQuote,
  PantaBuyQuoteSchema,
  type PantaCategories,
  PantaCategoriesSchema,
  type PantaCreateBuild,
  PantaCreateBuildSchema,
  type PantaCreateQuote,
  type PantaCreateQuoteRequest,
  PantaCreateQuoteRequestSchema,
  PantaCreateQuoteSchema,
  type PantaCreates,
  PantaCreatesSchema,
  type PantaCreatorFeeClaim,
  PantaCreatorFeeClaimSchema,
  PantaErrorEnvelopeSchema,
  type PantaMarket,
  type PantaMarketList,
  PantaMarketListSchema,
  PantaMarketSchema,
  type PantaMarketTrades,
  PantaMarketTradesSchema,
  type PantaMetrics,
  PantaMetricsSchema,
  type PantaPhase,
  type PantaPositions,
  PantaPositionsSchema,
  type PantaRegister,
  PantaRegisterSchema,
  type PantaReportTrade,
  type PantaReportTradeRequest,
  PantaReportTradeRequestSchema,
  PantaReportTradeSchema,
  type PantaSide,
  type PantaSubmit,
  PantaSubmitSchema,
  type PantaTradeStatus,
  PantaTradeStatusSchema,
  type PantaVerify,
  PantaVerifySchema,
  type PantaWalletTrades,
  PantaWalletTradesSchema,
  type PantaWinClaim,
  PantaWinClaimSchema,
} from './schemas';
import { isUsdcAmount } from './units';

const logger = Logger.create('PantaClient');

/** https://docs.panta.market/index.md → Base URL. Every path ends with a slash (required). */
export const PANTA_DEFAULT_BASE_URL = 'https://live-api.panta.market/api/v1';

/** Base58 ids: addresses (32–44 chars) and transaction signatures (64–88). */
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
/** Session ids Panta hands out (`cr_…`, `qt_…`, `ord_…`): letters, digits, `_` and `-`. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The list cursor is opaque (a market id today). */
const CURSOR = /^[A-Za-z0-9_=-]{1,256}$/;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface PantaClientOptions {
  /** Default `https://live-api.panta.market/api/v1`. Must be https (http only for localhost). */
  baseUrl?: string;
  /** `pk_live_…` / `pk_test_…`. Sent only in the `X-Api-Key` header; never logged, never in a URL or error. */
  apiKey?: string;
  /** Per attempt. Default 10 s. */
  timeoutMs?: number;
  /** Retries after the first attempt, on 408/429/5xx and network errors. Default 2. */
  maxRetries?: number;
  /** A retry that would have to wait longer than this (a long `Retry-After`) is not made: the error is thrown. Default 15 s. */
  maxRetryWaitMs?: number;
  /** How long a call may wait for its family's budget before failing with `PantaBudgetError`. Default 0 (fail fast). */
  maxBudgetWaitMs?: number;
  /** Shared by every client in the process that uses the same key. Default: a new budget at share 0.8. */
  budget?: RequestBudget;
  /** Tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface ListMarketsParams {
  /** One of GET /categories/. */
  category?: string;
  /** Market phase. */
  status?: PantaPhase;
  /** Only markets this account created. */
  createdBy?: 'me';
  /** `nextCursor` of the previous page. */
  cursor?: string;
  /** 1–50, default 20. */
  limit?: number;
}

export interface BuyQuoteRequest {
  wallet: string;
  marketId: string;
  side: PantaSide;
  /** Decimal USDC, e.g. "20.00". */
  amountUsdc: string;
  userId?: string;
}

export interface BuyBuildRequest {
  quoteId: string;
  wallet: string;
  userId?: string;
  /** Default 100 (1%) at Panta; at most 5,000. */
  maxSlippageBps?: number;
}

/** What the apps use from Panta; `PantaClient` is the live implementation, tests pass fakes. */
export interface PantaApi {
  readonly configured: boolean;
  account(): Promise<PantaAccount>;
  metrics(params?: { limit?: number }): Promise<PantaMetrics>;
  creates(params?: { limit?: number; status?: string }): Promise<PantaCreates>;
  attributedTrades(params?: { limit?: number; kind?: 'buy' | 'claim' }): Promise<PantaAttributedTrades>;
  listMarkets(params?: ListMarketsParams): Promise<PantaMarketList>;
  getMarket(marketId: string): Promise<PantaMarket>;
  marketTrades(marketId: string, params?: { limit?: number }): Promise<PantaMarketTrades>;
  categories(): Promise<PantaCategories>;
  walletTrades(wallet: string, params?: { limit?: number }): Promise<PantaWalletTrades>;
  quoteCreate(body: PantaCreateQuoteRequest): Promise<PantaCreateQuote>;
  buildCreate(body: { createId: string; wallet?: string }): Promise<PantaCreateBuild>;
  registerMarket(body: { createId: string; signature: string }): Promise<PantaRegister>;
  quoteBuy(body: BuyQuoteRequest): Promise<PantaBuyQuote>;
  buildBuy(body: BuyBuildRequest): Promise<PantaBuyBuild>;
  submitBuy(body: { orderId: string; signature: string; wallet?: string }): Promise<PantaSubmit>;
  verifyBuy(body: { orderId: string; signature?: string; wallet?: string }): Promise<PantaVerify>;
  positions(wallet: string): Promise<PantaPositions>;
  buildWinClaim(body: { wallet: string; marketId: string }): Promise<PantaWinClaim>;
  buildCreatorFeeClaim(body: { wallet: string; marketId: string }): Promise<PantaCreatorFeeClaim>;
  reportTrade(body: PantaReportTradeRequest): Promise<PantaReportTrade>;
  tradeStatus(signature: string, params?: { userId?: string }): Promise<PantaTradeStatus>;
}

interface RequestSpec<S extends z.ZodTypeAny> {
  method: 'GET' | 'POST';
  /** Path segments under the base URL; the client adds the slashes (trailing slash included). */
  path: string[];
  family: PantaFamily;
  schema: S;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Typed client for the Panta public API (https://docs.panta.market). Every call: one `RequestBudget` slot per attempt
 * (per-family sliding window under Panta's per-account limits), a timeout, retries with jittered exponential backoff on
 * 408 / 429 / 5xx / network errors (a 429 waits at least its `Retry-After`), and a zod-validated answer. Failures are
 * typed (`errors.ts`). The API key lives in a private field, goes out only in the `X-Api-Key` header and is never
 * logged.
 */
export class PantaClient implements PantaApi {
  readonly #apiKey: string | undefined;
  readonly baseUrl: string;
  readonly budget: RequestBudget;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly maxBudgetWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: PantaClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? PANTA_DEFAULT_BASE_URL);
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.budget = options.budget ?? new RequestBudget();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 15_000;
    this.maxBudgetWaitMs = options.maxBudgetWaitMs ?? 0;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /** True when an API key is set (every documented product route needs one). */
  get configured(): boolean {
    return this.#apiKey !== undefined;
  }

  /** Never prints the key. */
  toJSON(): { baseUrl: string; configured: boolean } {
    return { baseUrl: this.baseUrl, configured: this.configured };
  }

  // ── Account · https://docs.panta.market/api-reference/account/ ────────────────────────────────────

  /** GET /account/ (alias /whoami/): the key's account, including `canCreateMarkets`. */
  async account(): Promise<PantaAccount> {
    return this.request({ method: 'GET', path: ['account'], family: 'read', schema: PantaAccountSchema });
  }

  /** GET /account/metrics/: create and attributed-trade totals plus recent rows (`limit` ≤ 200). */
  async metrics(params: { limit?: number } = {}): Promise<PantaMetrics> {
    return this.request({
      method: 'GET',
      path: ['account', 'metrics'],
      family: 'read',
      schema: PantaMetricsSchema,
      query: { limit: clamp(params.limit, 1, 200) },
    });
  }

  /** GET /account/creates/: create sessions (`pending`, `built`, `registered`, …) with their event addresses. */
  async creates(params: { limit?: number; status?: string } = {}): Promise<PantaCreates> {
    return this.request({
      method: 'GET',
      path: ['account', 'creates'],
      family: 'read',
      schema: PantaCreatesSchema,
      query: { limit: clamp(params.limit, 1, 200), status: params.status },
    });
  }

  /** GET /account/trades/: the attribution rows credited to this account. */
  async attributedTrades(params: { limit?: number; kind?: 'buy' | 'claim' } = {}): Promise<PantaAttributedTrades> {
    return this.request({
      method: 'GET',
      path: ['account', 'trades'],
      family: 'read',
      schema: PantaAttributedTradesSchema,
      query: { limit: clamp(params.limit, 1, 200), kind: params.kind },
    });
  }

  // ── Markets catalog · https://docs.panta.market/api-reference/markets/catalog.md ──────────────────

  /** GET /markets/: the public USDC catalog, paged by `nextCursor`. Rows carry no live prices. */
  async listMarkets(params: ListMarketsParams = {}): Promise<PantaMarketList> {
    if (params.cursor !== undefined && !CURSOR.test(params.cursor)) {
      throw new PantaInputError('cursor is not a Panta list cursor', 'GET /markets/');
    }
    return this.request({
      method: 'GET',
      path: ['markets'],
      family: 'read',
      schema: PantaMarketListSchema,
      query: {
        category: params.category,
        status: params.status,
        createdBy: params.createdBy,
        cursor: params.cursor,
        limit: clamp(params.limit, 1, 50),
      },
    });
  }

  /** GET /markets/{marketId}/: one market with spot prices (when Panta's RPC answers). */
  async getMarket(marketId: string): Promise<PantaMarket> {
    this.assertBase58(marketId, 'marketId', 'GET /markets/{marketId}/');
    return this.request({ method: 'GET', path: ['markets', marketId], family: 'read', schema: PantaMarketSchema });
  }

  /** GET /markets/{marketId}/trades/: the public tape (not attribution). `limit` ≤ 200. */
  async marketTrades(marketId: string, params: { limit?: number } = {}): Promise<PantaMarketTrades> {
    this.assertBase58(marketId, 'marketId', 'GET /markets/{marketId}/trades/');
    return this.request({
      method: 'GET',
      path: ['markets', marketId, 'trades'],
      family: 'read',
      schema: PantaMarketTradesSchema,
      query: { limit: clamp(params.limit, 1, 200) },
    });
  }

  /** GET /categories/. */
  async categories(): Promise<PantaCategories> {
    return this.request({ method: 'GET', path: ['categories'], family: 'read', schema: PantaCategoriesSchema });
  }

  /** GET /wallets/{wallet}/trades/: a wallet's catalog trades. */
  async walletTrades(wallet: string, params: { limit?: number } = {}): Promise<PantaWalletTrades> {
    this.assertBase58(wallet, 'wallet', 'GET /wallets/{wallet}/trades/');
    return this.request({
      method: 'GET',
      path: ['wallets', wallet, 'trades'],
      family: 'read',
      schema: PantaWalletTradesSchema,
      query: { limit: clamp(params.limit, 1, 200) },
    });
  }

  // ── Create market · https://docs.panta.market/api-reference/markets/overview.md ───────────────────

  /** POST /markets/create/quote/: validates the market, reserves a ~5 min session and returns the USDC fee. */
  async quoteCreate(body: PantaCreateQuoteRequest): Promise<PantaCreateQuote> {
    const endpoint = 'POST /markets/create/quote/';
    const checked = PantaCreateQuoteRequestSchema.safeParse(body);
    if (!checked.success) {
      throw new PantaInputError(`Market rejected before sending: ${issueText(checked.error.issues)}`, endpoint);
    }
    return this.request({
      method: 'POST',
      path: ['markets', 'create', 'quote'],
      family: 'quote',
      schema: PantaCreateQuoteSchema,
      body: checked.data,
    });
  }

  /** POST /markets/create/build/: the unsigned VersionedTransaction (base64) for a live `createId`. */
  async buildCreate(body: { createId: string; wallet?: string }): Promise<PantaCreateBuild> {
    this.assertSession(body.createId, 'createId', 'POST /markets/create/build/');
    return this.request({
      method: 'POST',
      path: ['markets', 'create', 'build'],
      family: 'build',
      schema: PantaCreateBuildSchema,
      body,
    });
  }

  /** POST /markets/register/: verifies the confirmed create on chain and lists it. Idempotent per createId + signature. */
  async registerMarket(body: { createId: string; signature: string }): Promise<PantaRegister> {
    const endpoint = 'POST /markets/register/';
    this.assertSession(body.createId, 'createId', endpoint);
    this.assertBase58(body.signature, 'signature', endpoint);
    return this.request({
      method: 'POST',
      path: ['markets', 'register'],
      family: 'register',
      schema: PantaRegisterSchema,
      body,
    });
  }

  // ── Primary buy · https://docs.panta.market/api-reference/orders/overview.md ──────────────────────

  /** POST /primaryorderquote/: simulates the fill and fee; opens a ~90 s `quoteId`. */
  async quoteBuy(body: BuyQuoteRequest): Promise<PantaBuyQuote> {
    const endpoint = 'POST /primaryorderquote/';
    this.assertBase58(body.wallet, 'wallet', endpoint);
    this.assertBase58(body.marketId, 'marketId', endpoint);
    if (!isUsdcAmount(body.amountUsdc)) throw new PantaInputError('amountUsdc must be a positive decimal', endpoint);
    return this.request({
      method: 'POST',
      path: ['primaryorderquote'],
      family: 'quote',
      schema: PantaBuyQuoteSchema,
      body,
    });
  }

  /** POST /primaryorderbuild/: unsigned instructions + blockhash for a live quote (`QUOTE_STALE` past the slippage). */
  async buildBuy(body: BuyBuildRequest): Promise<PantaBuyBuild> {
    const endpoint = 'POST /primaryorderbuild/';
    this.assertSession(body.quoteId, 'quoteId', endpoint);
    this.assertBase58(body.wallet, 'wallet', endpoint);
    if (body.maxSlippageBps !== undefined && !(Number.isInteger(body.maxSlippageBps) && body.maxSlippageBps >= 0)) {
      throw new PantaInputError('maxSlippageBps must be a whole number of basis points', endpoint);
    }
    if ((body.maxSlippageBps ?? 0) > 5_000) throw new PantaInputError('maxSlippageBps is at most 5000', endpoint);
    return this.request({
      method: 'POST',
      path: ['primaryorderbuild'],
      family: 'build',
      schema: PantaBuyBuildSchema,
      body,
    });
  }

  /** POST /primaryordersubmit/: registers the broadcast signature; does not wait. Idempotent per orderId + signature. */
  async submitBuy(body: { orderId: string; signature: string; wallet?: string }): Promise<PantaSubmit> {
    const endpoint = 'POST /primaryordersubmit/';
    this.assertSession(body.orderId, 'orderId', endpoint);
    this.assertBase58(body.signature, 'signature', endpoint);
    return this.request({
      method: 'POST',
      path: ['primaryordersubmit'],
      family: 'register',
      schema: PantaSubmitSchema,
      body,
    });
  }

  /** POST /primaryorderverify/: the order's status (`built` | `submitted` | `confirmed` | `failed` | `expired`). */
  async verifyBuy(body: { orderId: string; signature?: string; wallet?: string }): Promise<PantaVerify> {
    const endpoint = 'POST /primaryorderverify/';
    this.assertSession(body.orderId, 'orderId', endpoint);
    if (body.signature !== undefined) this.assertBase58(body.signature, 'signature', endpoint);
    return this.request({
      method: 'POST',
      path: ['primaryorderverify'],
      family: 'register',
      schema: PantaVerifySchema,
      body,
    });
  }

  // ── Positions and claims ──────────────────────────────────────────────────────────────────────────

  /** GET /positions/?wallet=: holdings with phase and claim eligibility. https://docs.panta.market/api-reference/positions.md */
  async positions(wallet: string): Promise<PantaPositions> {
    this.assertBase58(wallet, 'wallet', 'GET /positions/');
    return this.request({
      method: 'GET',
      path: ['positions'],
      family: 'positions',
      schema: PantaPositionsSchema,
      query: { wallet },
    });
  }

  /** POST /claim/build/: unsigned claim_win_usdc instructions (`NOT_CLAIMABLE` otherwise). */
  async buildWinClaim(body: { wallet: string; marketId: string }): Promise<PantaWinClaim> {
    const endpoint = 'POST /claim/build/';
    this.assertBase58(body.wallet, 'wallet', endpoint);
    this.assertBase58(body.marketId, 'marketId', endpoint);
    return this.request({
      method: 'POST',
      path: ['claim', 'build'],
      family: 'build',
      schema: PantaWinClaimSchema,
      body,
    });
  }

  /** POST /claim/creator-fees/build/: the creator's fees of a graduated market. Never reported to /trades/. */
  async buildCreatorFeeClaim(body: { wallet: string; marketId: string }): Promise<PantaCreatorFeeClaim> {
    const endpoint = 'POST /claim/creator-fees/build/';
    this.assertBase58(body.wallet, 'wallet', endpoint);
    this.assertBase58(body.marketId, 'marketId', endpoint);
    return this.request({
      method: 'POST',
      path: ['claim', 'creator-fees', 'build'],
      family: 'build',
      schema: PantaCreatorFeeClaimSchema,
      body,
    });
  }

  // ── Attribution · https://docs.panta.market/api-reference/trades/report.md ────────────────────────

  /** POST /trades/: verifies a confirmed primary buy or win claim and credits it to this account. Idempotent. */
  async reportTrade(body: PantaReportTradeRequest): Promise<PantaReportTrade> {
    const endpoint = 'POST /trades/';
    const checked = PantaReportTradeRequestSchema.safeParse(body);
    if (!checked.success) throw new PantaInputError(`Report rejected: ${issueText(checked.error.issues)}`, endpoint);
    this.assertBase58(body.signature, 'signature', endpoint);
    return this.request({
      method: 'POST',
      path: ['trades'],
      family: 'register',
      schema: PantaReportTradeSchema,
      body: checked.data,
    });
  }

  /** GET /trades/{signature}/: `processed` | `pending_attribution` | `unknown` | `failed`. */
  async tradeStatus(signature: string, params: { userId?: string } = {}): Promise<PantaTradeStatus> {
    this.assertBase58(signature, 'signature', 'GET /trades/{signature}/');
    return this.request({
      method: 'GET',
      path: ['trades', signature],
      family: 'read',
      schema: PantaTradeStatusSchema,
      query: { userId: params.userId },
    });
  }

  // ── Transport ────────────────────────────────────────────────────────────────────────────────────

  private async request<S extends z.ZodTypeAny>(spec: RequestSpec<S>): Promise<z.output<S>> {
    const endpoint = `${spec.method} /${spec.path.map((part) => encodeURIComponent(part)).join('/')}/`;
    const apiKey = this.#apiKey;
    if (!apiKey) throw new PantaConfigError('PANTA_API_KEY is not set: Panta calls are off', endpoint);
    const url = this.url(spec.path, spec.query);

    for (let attempt = 0; ; attempt++) {
      await this.budget.take(spec.family, this.maxBudgetWaitMs, endpoint, this.sleep);
      const started = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: spec.method,
          headers: this.headers(apiKey, spec.body !== undefined),
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timedOut = isTimeout(error);
        const failure = new PantaNetworkError(
          timedOut ? `Panta did not answer within ${this.timeoutMs} ms` : 'Could not reach Panta',
          endpoint,
          timedOut,
        );
        if (attempt < this.maxRetries) {
          const wait = this.backoff(attempt);
          logger.warn('Panta call failed; retrying', { endpoint, attempt: attempt + 1, timedOut, waitMs: wait });
          await this.sleep(wait);
          continue;
        }
        throw failure;
      }

      this.observeRateHeaders(spec.family, res.headers);
      logger.debug('Panta call', { endpoint, status: res.status, ms: this.now() - started, attempt });
      if (res.ok) return this.parse(res, spec.schema, endpoint);

      const failure = await this.toApiError(res, endpoint);
      if (res.status === 429) {
        this.budget.block(spec.family, this.now() + (failure.retryAfterSeconds ?? 1) * 1_000);
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        const wait = Math.max(this.backoff(attempt), (failure.retryAfterSeconds ?? 0) * 1_000);
        if (wait <= this.maxRetryWaitMs) {
          logger.warn('Panta call failed; retrying', {
            endpoint,
            status: res.status,
            code: failure.code,
            attempt: attempt + 1,
            waitMs: wait,
          });
          await this.sleep(wait);
          continue;
        }
      }
      throw failure;
    }
  }

  private headers(apiKey: string, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': apiKey };
    if (hasBody) headers['content-type'] = 'application/json';
    const traceId = getTraceId();
    if (traceId) headers['x-request-id'] = traceId;
    return headers;
  }

  private url(path: string[], query: RequestSpec<z.ZodTypeAny>['query'] = {}): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(name, String(value));
    }
    const search = params.toString();
    return `${this.baseUrl}/${path.map((part) => encodeURIComponent(part)).join('/')}/${search ? `?${search}` : ''}`;
  }

  private async parse<S extends z.ZodTypeAny>(res: Response, schema: S, endpoint: string): Promise<z.output<S>> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PantaResponseError(`Panta answered ${endpoint} with a body that is not JSON`, endpoint, []);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      throw new PantaResponseError(
        `Panta's answer to ${endpoint} did not match the documented shape`,
        endpoint,
        issues,
      );
    }
    return parsed.data;
  }

  private async toApiError(res: Response, endpoint: string): Promise<PantaApiError> {
    const text = await res.text().catch(() => '');
    let envelope: z.output<typeof PantaErrorEnvelopeSchema> | undefined;
    try {
      const parsed = PantaErrorEnvelopeSchema.safeParse(JSON.parse(text));
      if (parsed.success) envelope = parsed.data;
    } catch {
      // not JSON (a proxy's HTML page): the status is all we know
    }
    return pantaApiError({
      endpoint,
      status: res.status,
      code: envelope?.code ?? `HTTP_${res.status}`,
      message: envelope?.message ?? `Panta answered HTTP ${res.status}`,
      field: envelope?.field,
      fields: envelope?.fields,
      requestId: res.headers.get('x-request-id') ?? undefined,
      retryAfterSeconds: retryAfterSeconds(res.headers.get('retry-after'), this.now()),
    });
  }

  /** `X-RateLimit-Remaining: 0` blocks the family until `X-RateLimit-Reset` (at most 2 minutes ahead). */
  private observeRateHeaders(family: PantaFamily, headers: Headers): void {
    if (headers.get('x-ratelimit-remaining') !== '0') return;
    const reset = Date.parse(headers.get('x-ratelimit-reset') ?? '');
    const now = this.now();
    const until = Number.isFinite(reset) ? Math.min(reset, now + 120_000) : now + 1_000;
    if (until > now) this.budget.block(family, until);
  }

  /** 0.5 s, 1 s, 2 s … (max 8 s), each scaled by a random 50–100% (jitter). */
  private backoff(attempt: number): number {
    const base = Math.min(8_000, 500 * 2 ** attempt);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  private assertBase58(value: string, what: string, endpoint: string): void {
    if (typeof value !== 'string' || !BASE58_ID.test(value)) {
      throw new PantaInputError(`${what} must be a base58 address or signature`, endpoint);
    }
  }

  private assertSession(value: string, what: string, endpoint: string): void {
    if (typeof value !== 'string' || !SESSION_ID.test(value)) {
      throw new PantaInputError(`${what} is not a Panta session id`, endpoint);
    }
  }
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PantaConfigError('PANTA_API_URL is not a URL', 'config');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new PantaConfigError('PANTA_API_URL must be https', 'config');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new PantaConfigError('PANTA_API_URL must not carry a query, fragment or credentials', 'config');
  }
  return url.toString().replace(/\/+$/, '');
}

const clamp = (value: number | undefined, min: number, max: number): number | undefined =>
  value === undefined ? undefined : Math.min(max, Math.max(min, Math.trunc(value)));

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** `Retry-After` as seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterSeconds(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1_000)) : undefined;
}

const issueText = (issues: readonly { path: PropertyKey[]; message: string }[]): string =>
  issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
