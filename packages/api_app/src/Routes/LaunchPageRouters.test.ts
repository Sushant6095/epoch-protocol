import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import { LaunchPageConfigSchema, loadConfig } from '@epoch/config-sdk';

import {
  launchPageHarness,
  type LaunchPageHarness,
  REHEARSAL,
  storedTrade,
  TRADER,
} from '../__fixtures__/LaunchFixtures';
import { RateLimiter } from '../Lib/RateLimiter';
import { setLaunchPageServices } from '../Services/Launch/LaunchLive';
import { LaunchTradeIngester } from '../Services/Launch/LaunchTradeIngester';
import { launchPageRouter } from './LaunchPageRouters';

const MINT = REHEARSAL.mint;

describe('Launch page routes (/v1/launches/:mint/…)', () => {
  let server: ExpressAppServer;
  let base: string;
  let h: LaunchPageHarness;

  beforeAll(async () => {
    h = launchPageHarness({ now: Date.now() });
    await h.store.insertTrades([0, 1, 2].map((n) => storedTrade(n, Date.now() - 10 * 60_000)));
    setLaunchPageServices({
      config: loadConfig(LaunchPageConfigSchema),
      page: h.page,
      trades: h.store,
      ingester: new LaunchTradeIngester({
        chain: h.live,
        store: h.store,
        launches: async () => [],
        pollMs: 10_000,
        backfillLimit: 0,
        enabled: false,
      }),
      // Four quotes or builds a minute per IP.
      tradeLimiter: new RateLimiter(4, 60_000),
    });
    server = new ExpressAppServer({ appName: 'launch-page-routes-test', port: 0 }).route(
      '/v1/launches',
      launchPageRouter,
    );
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}/v1/launches`;
  });

  afterAll(async () => {
    setLaunchPageServices(undefined);
    await server.stop();
    h.cleanup();
  });

  interface Reply {
    status: number;
    cache: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: { ok: boolean; data: any; error?: { code: string; message: string; details?: Record<string, unknown> } };
  }
  const call = async (path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json()) as Reply['body'] };
  };

  it('serves the read endpoints wrapped as { ok, data }, by mint or symbol', async () => {
    const market = await call('/rREH/market');
    expect(market).toMatchObject({
      status: 200,
      cache: 'no-store',
      body: { ok: true, data: { venue: 'dbc', status: 'curve' } },
    });
    const trades = await call(`/${MINT}/trades?limit=2`);
    expect(trades.body.data.trades).toHaveLength(2);
    expect(trades.body.data.nextCursor).toMatch(/^3001:/);
    const older = await call(`/${MINT}/trades?limit=2&before=${trades.body.data.nextCursor}`);
    expect(older.body.data.trades.map((trade: { slot: number }) => trade.slot)).toEqual([3_000]);
    expect((await call(`/${MINT}/candles?interval=1m`)).body.data).toMatchObject({ interval: '1m', basis: 'trades' });
    expect((await call(`/${MINT}/holders`)).body.data.count).toEqual({ all: 4, buyers: 1 });
    expect((await call(`/${MINT}/fees`)).body.data.toLenders.holder).toBe(REHEARSAL.feeClaimer);
    const page = await call(`/${MINT}/page`);
    expect(page.body.data).toMatchObject({ stream: { channel: `launch:${MINT}` }, unavailable: [] });
  });

  it('validates queries and keys', async () => {
    expect((await call(`/${MINT}/trades?limit=0`)).body.error?.code).toBe('BAD_REQUEST');
    expect((await call(`/${MINT}/trades?before=yesterday`)).status).toBe(400);
    expect((await call(`/${MINT}/candles?interval=2m`)).status).toBe(400);
    expect((await call('/rNOPE/market')).body.error?.code).toBe('NOT_FOUND');
    expect((await call('/not-a-key!/market')).status).toBe(400);
  });

  it('quotes, then builds only with consent; trade calls are rate-limited per IP', async () => {
    const quote = await call(`/${MINT}/quote`, { side: 'buy', amount: 0.1 });
    expect(quote).toMatchObject({
      status: 200,
      cache: 'no-store',
      body: { data: { quote: { side: 'buy', venue: 'dbc' } } },
    });
    expect((await call(`/${MINT}/quote`, { side: 'hold', amount: 1 })).status).toBe(400);
    const refused = await call(`/${MINT}/build`, { side: 'buy', amount: 0.1, owner: TRADER });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'CONSENT_REQUIRED' } } });
    const built = await call(`/${MINT}/build`, { side: 'buy', amount: 0.1, owner: TRADER, consent: true });
    expect(built.body.data).toMatchObject({ feePayer: TRADER, transaction: expect.any(String) });
    const limited = await call(`/${MINT}/quote`, { side: 'buy', amount: 0.1 });
    expect(limited).toMatchObject({ status: 429, body: { error: { code: 'TOO_MANY_REQUESTS' } } });
  });
});
