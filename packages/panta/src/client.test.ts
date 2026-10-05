import { Logger } from '@epoch/logger';

import * as fx from './__fixtures__/responses';
import { RequestBudget } from './budget';
import { PantaClient, type PantaClientOptions, retryAfterSeconds } from './client';
import {
  PantaApiError,
  PantaAuthError,
  PantaBudgetError,
  PantaConfigError,
  PantaForbiddenError,
  PantaInputError,
  PantaNetworkError,
  PantaNotFoundError,
  PantaRateLimitedError,
  PantaRequestError,
  PantaResponseError,
  PantaServerError,
} from './errors';

const BASE = 'https://live-api.panta.market/api/v1';

/** A client on a fake clock: `sleep` advances it and records each wait. */
function setup(options: Partial<PantaClientOptions> = {}) {
  const fake = new fx.FakeFetch();
  const clock = { now: 1_800_000_000_000 };
  const waits: number[] = [];
  const now = () => clock.now;
  const client = new PantaClient({
    apiKey: fx.API_KEY,
    fetch: fake.fetch,
    now,
    random: () => 1,
    sleep: async (ms) => {
      waits.push(ms);
      clock.now += ms;
    },
    budget: new RequestBudget({ now }),
    ...options,
  });
  return { fake, client, clock, waits };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('PantaClient requests', () => {
  it('sends the key only in X-Api-Key, with trailing slashes, and parses the documented answer', async () => {
    const { fake, client } = setup();
    fake.reply(200, fx.market, { 'x-powered-by': 'Panta' });
    const market = await client.getMarket(fx.MARKET);
    expect(fake.calls[0]).toMatchObject({
      url: `${BASE}/markets/${fx.MARKET}/`,
      method: 'GET',
      headers: { 'x-api-key': fx.API_KEY, accept: 'application/json' },
    });
    expect(fake.calls[0].url).not.toContain(fx.API_KEY);
    expect(fake.calls[0].headers['content-type']).toBeUndefined();
    expect(market).toMatchObject({ marketId: fx.MARKET, phase: 'primary', yesPrice: '0.52', noPrice: '0.48' });
    expect(market.secondaryYesPrice).toBeNull();
  });

  it('posts JSON bodies and builds query strings without empty values', async () => {
    const { fake, client } = setup();
    fake.reply(200, fx.buyQuote).reply(200, fx.marketList);
    await client.quoteBuy({ wallet: fx.WALLET, marketId: fx.MARKET, side: 'yes', amountUsdc: '20.00' });
    expect(fake.calls[0]).toMatchObject({
      url: `${BASE}/primaryorderquote/`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { wallet: fx.WALLET, marketId: fx.MARKET, side: 'yes', amountUsdc: '20.00' },
    });
    await client.listMarkets({ category: 'crypto', status: 'primary', limit: 500, cursor: undefined });
    expect(fake.calls[1].url).toBe(`${BASE}/markets/?category=crypto&status=primary&limit=50`);
  });

  it('calls every endpoint we use at its documented path and method', async () => {
    const { fake, client } = setup({ budget: new RequestBudget({ share: 1 }) });
    const cases: [() => Promise<unknown>, unknown, string, string][] = [
      [() => client.account(), fx.account, 'GET', '/account/'],
      [() => client.metrics({ limit: 10 }), fx.metrics, 'GET', '/account/metrics/?limit=10'],
      [() => client.creates({ status: 'registered' }), fx.creates, 'GET', '/account/creates/?status=registered'],
      [() => client.attributedTrades({ kind: 'buy' }), fx.attributedTrades, 'GET', '/account/trades/?kind=buy'],
      [() => client.listMarkets({ createdBy: 'me' }), fx.marketList, 'GET', '/markets/?createdBy=me'],
      [
        () => client.marketTrades(fx.MARKET, { limit: 900 }),
        fx.marketTrades,
        'GET',
        `/markets/${fx.MARKET}/trades/?limit=200`,
      ],
      [() => client.categories(), fx.categories, 'GET', '/categories/'],
      [() => client.walletTrades(fx.WALLET), fx.walletTrades, 'GET', `/wallets/${fx.WALLET}/trades/`],
      [
        () => client.buildCreate({ createId: 'cr_abc123', wallet: fx.CREATOR }),
        fx.createBuild,
        'POST',
        '/markets/create/build/',
      ],
      [
        () => client.registerMarket({ createId: 'cr_abc123', signature: fx.SIGNATURE }),
        fx.register,
        'POST',
        '/markets/register/',
      ],
      [
        () => client.buildBuy({ quoteId: 'qt_abc123', wallet: fx.WALLET, maxSlippageBps: 100 }),
        fx.buyBuild,
        'POST',
        '/primaryorderbuild/',
      ],
      [
        () => client.submitBuy({ orderId: 'ord_abc123', signature: fx.SIGNATURE }),
        fx.submit,
        'POST',
        '/primaryordersubmit/',
      ],
      [() => client.verifyBuy({ orderId: 'ord_abc123' }), fx.verify, 'POST', '/primaryorderverify/'],
      [() => client.positions(fx.WALLET), fx.positions, 'GET', `/positions/?wallet=${fx.WALLET}`],
      [() => client.buildWinClaim({ wallet: fx.WALLET, marketId: fx.MARKET }), fx.winClaim, 'POST', '/claim/build/'],
      [
        () => client.buildCreatorFeeClaim({ wallet: fx.CREATOR, marketId: fx.MARKET }),
        fx.creatorFees,
        'POST',
        '/claim/creator-fees/build/',
      ],
      [
        () => client.reportTrade({ signature: fx.SIGNATURE, wallet: fx.WALLET, marketId: fx.MARKET }),
        fx.report,
        'POST',
        '/trades/',
      ],
      [() => client.tradeStatus(fx.SIGNATURE), fx.tradeStatus, 'GET', `/trades/${fx.SIGNATURE}/`],
    ];
    for (const [call, body, method, path] of cases) {
      fake.reply(200, body);
      await call();
      const sent = fake.calls.at(-1);
      expect([sent?.method, sent?.url]).toEqual([method, `${BASE}${path}`]);
    }
  });

  it('validates a market before spending a quote', async () => {
    const { fake, client } = setup();
    const body = {
      wallet: fx.CREATOR,
      question: 'Will ETH be above $5,000 on 2027-01-01?',
      resolutionRule: 'CoinGecko daily close UTC',
      sourcesOfTruth: ['https://www.coingecko.com'],
      category: 'crypto' as const,
      startTime: 1893456000,
      endTime: 1896127200,
      resolutionTime: 1896130800,
      imageUrl: 'https://cdn.example.com/markets/eth-5k-1024.webp',
    };
    fake.reply(200, fx.createQuote);
    expect(await client.quoteCreate(body)).toMatchObject({ createId: 'cr_abc123', paymentUsdc: '50000000' });
    for (const bad of [
      { ...body, endTime: body.startTime },
      { ...body, sourcesOfTruth: [] },
      { ...body, question: 'x'.repeat(513) },
      { ...body, imageUrl: 'data:image/png;base64,AAAA' },
    ]) {
      expect(await failure(client.quoteCreate(bad))).toBeInstanceOf(PantaInputError);
    }
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses ids that are not base58 without calling Panta', async () => {
    const { fake, client } = setup();
    expect(await failure(client.getMarket('../account'))).toBeInstanceOf(PantaInputError);
    expect(await failure(client.positions('not a wallet'))).toBeInstanceOf(PantaInputError);
    expect(await failure(client.buildBuy({ quoteId: 'q t', wallet: fx.WALLET }))).toBeInstanceOf(PantaInputError);
    expect(
      await failure(client.quoteBuy({ wallet: fx.WALLET, marketId: fx.MARKET, side: 'yes', amountUsdc: '-1' })),
    ).toBeInstanceOf(PantaInputError);
    expect(
      await failure(client.buildBuy({ quoteId: 'qt_1', wallet: fx.WALLET, maxSlippageBps: 6_000 })),
    ).toBeInstanceOf(PantaInputError);
    expect(fake.calls).toHaveLength(0);
  });

  it('needs an API key and never shows it', async () => {
    const fake = new fx.FakeFetch();
    const bare = new PantaClient({ fetch: fake.fetch });
    expect(bare.configured).toBe(false);
    expect(await failure(bare.categories())).toBeInstanceOf(PantaConfigError);
    expect(fake.calls).toHaveLength(0);

    const { client } = setup();
    expect(client.configured).toBe(true);
    expect(JSON.stringify(client)).not.toContain(fx.API_KEY);
    expect(String(client)).not.toContain(fx.API_KEY);
    expect(() => new PantaClient({ baseUrl: 'http://panta.example/api/v1' })).toThrow(PantaConfigError);
    expect(() => new PantaClient({ baseUrl: 'https://u:p@panta.example/api/v1' })).toThrow(PantaConfigError);
    expect(new PantaClient({ baseUrl: 'http://127.0.0.1:9/api/v1/' }).baseUrl).toBe('http://127.0.0.1:9/api/v1');
  });
});

describe('PantaClient failures', () => {
  it('maps the error envelope to typed errors and does not retry a 4xx', async () => {
    const { fake, client } = setup();
    fake.reply(400, fx.errorEnvelope, { 'x-request-id': 'req-1' });
    const error = await failure(client.categories());
    expect(error).toBeInstanceOf(PantaRequestError);
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_MARKET_PARAMS',
      field: 'startTime',
      requestId: 'req-1',
      endpoint: 'GET /categories/',
      message: 'startTime must be at least 3600s ahead of now',
    });
    expect(PantaApiError.is(error, 'INVALID_MARKET_PARAMS')).toBe(true);
    expect(PantaApiError.is(error, 'DUPLICATE_MARKET')).toBe(false);
    expect((error as PantaApiError).known).toBe(true);
    expect(fake.calls).toHaveLength(1);

    fake.reply(400, fx.fieldErrors);
    expect(await failure(client.categories())).toMatchObject({ fields: { imageUrl: ['This field is required.'] } });

    const statuses: [number, string, new (...args: never[]) => Error][] = [
      [401, 'UNAUTHORIZED', PantaAuthError],
      [403, 'FORBIDDEN', PantaForbiddenError],
      [404, 'MARKET_NOT_FOUND', PantaNotFoundError],
    ];
    for (const [status, code, type] of statuses) {
      fake.reply(status, { code, message: 'nope' });
      const typed = await failure(client.getMarket(fx.MARKET));
      expect(typed).toBeInstanceOf(type);
      expect(typed).toMatchObject({ code, status });
    }
  });

  it('retries a 429 after Retry-After and blocks the family meanwhile', async () => {
    const { fake, client, waits } = setup();
    fake.reply(429, { code: 'RATE_LIMITED', message: 'slow down' }, { 'retry-after': '3' }).reply(200, fx.categories);
    expect((await client.categories()).categories).toContain('crypto');
    expect(fake.calls).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(3_000);
  });

  it('throws a 429 at once when Retry-After is longer than it may wait', async () => {
    const { fake, client, waits } = setup({ maxRetryWaitMs: 5_000 });
    fake.reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '60' });
    const error = await failure(client.categories());
    expect(error).toBeInstanceOf(PantaRateLimitedError);
    expect(error).toMatchObject({ retryAfterSeconds: 60 });
    expect(waits).toEqual([]);
    // The family is blocked for those 60 s: the next call fails locally, nothing sent.
    expect(await failure(client.categories())).toBeInstanceOf(PantaBudgetError);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries 5xx with jittered exponential backoff, then gives up', async () => {
    const { fake, client, waits } = setup({ random: () => 0 });
    fake.reply(502, undefined).reply(503, { code: 'INTERNAL_ERROR' }).reply(500, { code: 'INTERNAL_ERROR' });
    const error = await failure(client.account());
    expect(error).toBeInstanceOf(PantaServerError);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(fake.calls).toHaveLength(3);
    expect(waits).toEqual([250, 500]); // 500 ms and 1 s, scaled by the minimum jitter (50%)

    fake.replyText(502, '<html>bad gateway</html>').reply(200, fx.account);
    expect((await client.account()).userId).toBe('usr_epoch');
  });

  it('labels an answer without an envelope by its status', async () => {
    const { fake, client } = setup({ maxRetries: 0 });
    fake.replyText(502, '<html>bad gateway</html>');
    expect(await failure(client.account())).toMatchObject({ code: 'HTTP_502', status: 502 });
  });

  it('times out, retries, then reports a network error', async () => {
    const { fake, client } = setup({ timeoutMs: 20, maxRetries: 1 });
    fake.hang().hang();
    const error = await failure(client.account());
    expect(error).toBeInstanceOf(PantaNetworkError);
    expect((error as PantaNetworkError).timedOut).toBe(true);
    expect(fake.calls).toHaveLength(2);

    fake.fail(new TypeError('fetch failed')).reply(200, fx.account);
    expect((await client.account()).canCreateMarkets).toBe(true);
  });

  it('rejects a 2xx answer that does not match the documented shape, without retrying', async () => {
    const { fake, client } = setup();
    fake.reply(200, { items: [{ marketId: 1 }] });
    const error = await failure(client.listMarkets());
    expect(error).toBeInstanceOf(PantaResponseError);
    expect((error as PantaResponseError).issues.join(' ')).toContain('items.0.marketId');
    expect(fake.calls).toHaveLength(1);
    fake.replyText(200, 'not json');
    expect(await failure(client.categories())).toBeInstanceOf(PantaResponseError);
  });

  it('waits for X-RateLimit-Reset after Panta reports the window spent', async () => {
    const { fake, client, clock } = setup();
    const reset = new Date(clock.now + 30_000).toISOString();
    fake.reply(200, fx.categories, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset });
    await client.categories();
    const error = await failure(client.categories());
    expect(error).toBeInstanceOf(PantaBudgetError);
    expect(error).toMatchObject({ family: 'read', retryAfterSeconds: 30 });
    expect(fake.calls).toHaveLength(1);
  });

  it('never logs or throws the API key', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const { fake, client } = setup({ maxRetries: 1, random: () => 0 });
    fake.reply(500, { code: 'INTERNAL_ERROR' }).reply(401, { code: 'UNAUTHORIZED', message: 'bad key' });
    const error = await failure(client.account());
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).toContain('GET /account/');
    expect(logged).not.toContain(fx.API_KEY);
    expect(JSON.stringify(error)).not.toContain(fx.API_KEY);
    expect(String((error as Error).stack)).not.toContain(fx.API_KEY);
    for (const spy of spies) spy.mockRestore();
  });
});

describe('retryAfterSeconds', () => {
  it('reads seconds or an HTTP date', () => {
    expect(retryAfterSeconds('7')).toBe(7);
    expect(retryAfterSeconds(new Date(1_000_000 + 9_500).toUTCString(), 1_000_000)).toBe(9);
    expect(retryAfterSeconds('soon')).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });
});
