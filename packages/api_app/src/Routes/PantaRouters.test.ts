import { randomBytes } from 'crypto';
import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import { base58Encode } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { PantaBudgetError, pantaApiError, PantaNetworkError } from '@epoch/panta';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import {
  BLOCKHASH,
  FakeApiPanta,
  FakePantaChain,
  feeIndexRow,
  MemoryIndexReads,
  MemoryPantaMarketReader,
  MemoryPantaTradeStore,
  pantaMarket,
  pkey,
  walletInstruction,
} from '../__fixtures__/PantaFakes';
import { SESSION_LOCALS_KEY } from '../Lib/Session';
import { buildPantaServices, type PantaServices, setPantaServices } from '../Services/Panta';
import { BroadcastRejected } from '../Services/Panta/PantaChain';
import { FeeIndexEpochService, setFeeIndexEpochService } from '../Services/Program/FeeIndexEpochService';
import { feeIndexRouter } from './FeeIndexRouter';
import { feeIndexEpochRouter, pantaRouter } from './PantaRouters';

const KEY = 'pk_live_test_only_not_real';
const OUR = pkey(80);
const OTHER = pkey(60);
const GOLD = pkey(62);
const T0 = Date.parse('2026-10-03T12:00:00Z');

interface Harness {
  panta: FakeApiPanta;
  chain: FakePantaChain;
  trades: MemoryPantaTradeStore;
  clock: { now: number };
  services: PantaServices;
}

/** Two more strikes on epoch 1051 (the forecast's ladder). */
const LOW = pkey(81);
const HIGH = pkey(82);

/**
 * Services on fakes: our market on epoch 1051 at 1,300 µL/CU, two catalog markets, ten epochs of index history.
 * `ladder`: also strikes 1,100 and 1,500 on epoch 1051.
 */
function harness(env: Record<string, string> = {}, configured = true, ladder = false): Harness {
  const panta = new FakeApiPanta();
  panta.configured = configured;
  panta.markets.set(
    OUR,
    pantaMarket({
      marketId: OUR,
      title: 'Solana Fee Index above 1,300 µL/CU in epoch 1051',
      yesPrice: '0.62',
      noPrice: '0.38',
      createdByPartner: true,
    }),
  );
  panta.markets.set(OTHER, pantaMarket());
  panta.catalog = [
    pantaMarket({
      marketId: OUR,
      title: 'Solana Fee Index above 1,300 µL/CU in epoch 1051',
      createdByPartner: true,
      totalVolumeUsdc: '1250.40',
    }),
    pantaMarket(),
    pantaMarket({ marketId: GOLD, title: 'Will BTC flip gold?' }),
  ];
  if (ladder) {
    panta.markets.set(LOW, pantaMarket({ marketId: LOW, yesPrice: '0.85', noPrice: '0.15', volumeUsdc: '300.00' }));
    panta.markets.set(HIGH, pantaMarket({ marketId: HIGH, yesPrice: '0.30', noPrice: '0.70', volumeUsdc: '80.00' }));
  }
  const chain = new FakePantaChain();
  const trades = new MemoryPantaTradeStore();
  // Four of the last ten epochs closed above 1,300.
  const values = [1_250, 1_400, 1_100, 1_320, 1_280, 1_500, 1_200, 1_310, 1_290, 1_000];
  const reads = new MemoryIndexReads(
    values.map((value, i) => ({ epoch: 1_049 - i, value })),
    { epoch: 1_050, value: 1_275, slots: 120_000 },
  );
  const clock = { now: T0 };
  const services = buildPantaServices({
    env: { PANTA_API_KEY: configured ? KEY : '', PANTA_MODEL_LOOKBACK_EPOCHS: '10', ...env },
    panta,
    chain,
    trades,
    markets: new MemoryPantaMarketReader([
      feeIndexRow(1_051, 1_300, OUR),
      ...(ladder
        ? [
            { ...feeIndexRow(1_051, 1_100, LOW), id: 2 },
            { ...feeIndexRow(1_051, 1_500, HIGH), id: 3 },
          ]
        : []),
    ]),
    reads,
    finals: null,
    now: () => clock.now,
  });
  return { panta, chain, trades, clock, services };
}

describe('Panta routes (/v1/predict/panta)', () => {
  let server: ExpressAppServer;
  let base = '';
  let session: string | undefined;

  beforeAll(async () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    server = new ExpressAppServer({ appName: 'panta-routes-test', port: 0 })
      // Stand-in for the SIWS session middleware.
      .use((_req, res, next) => {
        if (session) res.locals[SESSION_LOCALS_KEY] = { id: 'test', address: session, expiresAt: '' };
        next();
      })
      .route('/v1/index', feeIndexRouter)
      .route('/v1/index/epochs', feeIndexEpochRouter)
      .route('/v1/predict/panta', pantaRouter);
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setPantaServices(undefined);
    setFeeIndexEpochService(undefined);
    await server.stop();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    session = undefined;
  });

  interface Reply {
    status: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: { ok: boolean; data: any; error: { code: string; message: string; details?: any } };
    headers: Headers;
  }
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Reply['body'], headers: res.headers };
  }
  const use = (h: Harness): Harness => {
    setPantaServices(h.services);
    return h;
  };

  /** Quote and build a buy for `wallet` (signed in), returning the build's data. */
  async function built(wallet: Keypair) {
    session = wallet.publicKey.toBase58();
    const quote = await call('POST', '/v1/predict/panta/quote', {
      wallet: session,
      marketId: OTHER,
      side: 'yes',
      amountUsdc: '20',
    });
    const build = await call('POST', '/v1/predict/panta/build', {
      quoteId: quote.body.data.quoteId,
      wallet: session,
      consent: true,
    });
    expect(build.status).toBe(200);
    return build.body.data as { tradeId: string; transaction: string; summary: string; review: object };
  }

  const signTx = (transaction: string, wallet: Keypair): { signed: string; signature: string } => {
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    tx.sign([wallet]);
    return { signed: Buffer.from(tx.serialize()).toString('base64'), signature: base58Encode(tx.signatures[0]) };
  };

  it('serves our Fee Index markets with informational intelligence next to the catalog, powered by Panta', async () => {
    use(harness());
    const res = await call('GET', '/v1/predict/panta/markets');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      kind: 'real',
      poweredBy: 'Panta',
      poweredByUrl: 'https://panta.market',
      stale: false,
      ageSeconds: 0,
      access: { tradingEnabled: true, geoBlocked: false, country: null, reason: null, signInRequired: true },
    });
    expect(res.body.data.asOf).toMatch(/\+05:30$/);
    const [ours] = res.body.data.ours;
    expect(ours).toMatchObject({
      marketId: OUR,
      ours: true,
      epoch: 1_051,
      thresholdMicroLamports: 1_300,
      yesPrice: 0.62,
      tradable: true,
      resolutionUrl: 'https://api.epoch.example/v1/index/epochs/1051',
      pricesStale: false,
      intelligence: {
        label: 'informational',
        impliedProbability: 0.62,
        modelProbability: 0.4,
        gapPct: 22,
        model: { lookbackEpochs: 10, above: 4, sample: 10 },
        index: {
          unit: 'µL/CU',
          last: { epoch: 1_049, value: 1_250, status: 'computed' },
          running: { epoch: 1_050, value: 1_275 },
        },
      },
    });
    expect(res.body.data.discover.items.map((m: { marketId: string }) => m.marketId)).toEqual([OTHER, GOLD]);
    expect(res.body.data.discover.items[0]).toMatchObject({ ours: false, yesPrice: null });

    const search = await call('GET', '/v1/predict/panta/markets?q=gold');
    expect(search.body.data.discover).toMatchObject({ q: 'gold', searched: 3, nextCursor: null });
    expect(search.body.data.discover.items.map((m: { title: string }) => m.title)).toEqual(['Will BTC flip gold?']);
    expect((await call('GET', '/v1/predict/panta/markets?limit=500')).status).toBe(400);
  });

  it('labels cached data stale when Panta cannot be read, and fails once it is too old', async () => {
    const h = use(harness());
    const fresh = await call('GET', `/v1/predict/panta/markets/${OTHER}`);
    expect(fresh.body.data).toMatchObject({ stale: false, market: { marketId: OTHER, ours: false } });
    // Panta's live tape sends base units: 10,000,000 → 10 shares, fee 50,000 → 0.05, amount 10,200,000 → 10.20.
    expect(fresh.body.data.trades[0]).toMatchObject({
      side: 'yes',
      yesShares: '10',
      noShares: '0',
      feeUsdc: '0.05',
      amountUsdc: '10.20',
      kind: 'buy',
      isPrimary: true,
    });

    h.clock.now += 20_000;
    h.panta.failNext.getMarket = new PantaNetworkError('down', 'GET /markets/x/', false);
    const stale = await call('GET', `/v1/predict/panta/markets/${OTHER}`);
    expect(stale.status).toBe(200);
    expect(stale.body.data).toMatchObject({ stale: true, ageSeconds: 20, asOf: fresh.body.data.asOf });

    h.clock.now += 11 * 60_000;
    h.panta.failNext.getMarket = new PantaNetworkError('down', 'GET /markets/x/', true);
    const gone = await call('GET', `/v1/predict/panta/markets/${OTHER}`);
    expect([gone.status, gone.body.error.code]).toEqual([502, 'PANTA_UNAVAILABLE']);
  });

  it('answers 503 to trades while trading is off, and to everything without an API key', async () => {
    use(harness({ PANTA_TRADING_ENABLED: 'false' }));
    for (const [path, body] of [
      ['/v1/predict/panta/quote', { wallet: OTHER, marketId: OTHER, side: 'yes', amountUsdc: '20' }],
      ['/v1/predict/panta/build', { quoteId: 'qt_1', wallet: OTHER, consent: true }],
      ['/v1/predict/panta/submit', { tradeId: 'ptr_abcdefgh', signature: 'x'.repeat(88) }],
      ['/v1/predict/panta/claim/build', { wallet: OTHER, marketId: OTHER, consent: true }],
    ] as const) {
      const res = await call('POST', path, body);
      expect([path, res.status, res.body.error.code]).toEqual([path, 503, 'PANTA_TRADING_DISABLED']);
    }
    const page = await call('GET', '/v1/predict/panta/markets');
    expect(page.status).toBe(200);
    expect(page.body.data.access).toMatchObject({
      tradingEnabled: false,
      reason: 'Real-money trading is switched off right now',
    });

    use(harness({}, false));
    expect((await call('GET', '/v1/predict/panta/markets')).body.error.code).toBe('PANTA_NOT_CONFIGURED');
    const quote = await call('POST', '/v1/predict/panta/quote', {
      wallet: OTHER,
      marketId: OTHER,
      side: 'yes',
      amountUsdc: '20',
    });
    expect([quote.status, quote.body.error.code]).toEqual([503, 'PANTA_NOT_CONFIGURED']);
  });

  it('lets blocked countries browse but not trade', async () => {
    use(harness({ PANTA_BLOCKED_COUNTRIES: 'US,GB' }));
    const quote = { wallet: OTHER, marketId: OTHER, side: 'yes', amountUsdc: '20' };
    const blocked = await call('POST', '/v1/predict/panta/quote', quote, { 'cf-ipcountry': 'US' });
    expect([blocked.status, blocked.body.error.code, blocked.body.error.details]).toEqual([
      403,
      'PANTA_GEO_BLOCKED',
      { country: 'US' },
    ]);
    expect((await call('POST', '/v1/predict/panta/quote', quote, { 'x-vercel-ip-country': 'gb' })).status).toBe(403);
    expect((await call('POST', '/v1/predict/panta/quote', quote, { 'cf-ipcountry': 'T1' })).status).toBe(403);
    expect((await call('POST', '/v1/predict/panta/quote', quote, { 'cf-ipcountry': 'IN' })).status).toBe(200);
    const page = await call('GET', '/v1/predict/panta/markets', undefined, { 'cf-ipcountry': 'US' });
    expect(page.status).toBe(200);
    expect(page.body.data.access).toMatchObject({ geoBlocked: true, country: 'US', tradingEnabled: true });
    expect(page.body.data.access.reason).toContain('region');
  });

  it('refuses trades from an unknown country only with PANTA_GEO_FAIL_CLOSED', async () => {
    const quote = { wallet: OTHER, marketId: OTHER, side: 'yes', amountUsdc: '20' };
    use(harness());
    expect((await call('POST', '/v1/predict/panta/quote', quote)).status).toBe(200);
    use(harness({ PANTA_GEO_FAIL_CLOSED: 'true' }));
    const unknown = await call('POST', '/v1/predict/panta/quote', quote);
    expect([unknown.status, unknown.body.error.code, unknown.body.error.details]).toEqual([
      403,
      'PANTA_GEO_BLOCKED',
      { country: null },
    ]);
    expect(unknown.body.error.message).toContain('could not be determined');
    expect((await call('POST', '/v1/predict/panta/quote', quote, { 'cf-ipcountry': 'IN' })).status).toBe(200);
    const page = await call('GET', '/v1/predict/panta/markets');
    expect(page.body.data.access).toMatchObject({ geoBlocked: true, country: null });
    expect(page.body.data.access.reason).toBe('Trading needs your region, which could not be determined');
  });

  it('quotes publicly, inside the trade limits', async () => {
    const h = use(harness({ PANTA_MAX_TRADE_USDC: '100' }));
    const tooSmall = await call('POST', '/v1/predict/panta/quote', {
      wallet: OTHER,
      marketId: OTHER,
      side: 'yes',
      amountUsdc: '0.5',
    });
    expect([tooSmall.status, tooSmall.body.error.code]).toEqual([400, 'PANTA_AMOUNT_OUT_OF_RANGE']);
    expect(
      (
        await call('POST', '/v1/predict/panta/quote', {
          wallet: OTHER,
          marketId: OTHER,
          side: 'yes',
          amountUsdc: '101',
        })
      ).status,
    ).toBe(400);
    const ok = await call('POST', '/v1/predict/panta/quote', {
      wallet: OTHER,
      marketId: OTHER,
      side: 'no',
      amountUsdc: '20',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ quoteId: 'qt_1', side: 'no', payoutIfWinUsdc: '38.42', poweredBy: 'Panta' });
    expect(ok.body.data.summary).toContain('Powered by Panta');
    expect(h.panta.calls.at(-1)).toEqual({
      name: 'quoteBuy',
      body: { wallet: OTHER, marketId: OTHER, side: 'no', amountUsdc: '20.00' },
    });
  });

  it('builds only with consent and the trading wallet’s session', async () => {
    const h = use(harness());
    const wallet = Keypair.generate();
    const address = wallet.publicKey.toBase58();
    const body = { quoteId: 'qt_1', wallet: address, consent: true };
    expect((await call('POST', '/v1/predict/panta/build', body)).status).toBe(401);
    session = pkey(99);
    const mismatch = await call('POST', '/v1/predict/panta/build', body);
    expect([mismatch.status, mismatch.body.error.code]).toEqual([403, 'WALLET_MISMATCH']);
    session = address;
    for (const consent of [undefined, false]) {
      const res = await call('POST', '/v1/predict/panta/build', { ...body, consent });
      expect([res.status, res.body.error.code]).toEqual([400, 'CONSENT_REQUIRED']);
    }
    expect(h.panta.count('buildBuy')).toBe(0);

    const res = await call('POST', '/v1/predict/panta/build', { ...body, maxSlippageBps: 200 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      action: 'buy',
      orderId: 'ord_1',
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 5_000,
      poweredBy: 'Panta',
      review: {
        action: 'buy',
        side: 'yes',
        amountUsdc: '20.00',
        feeUsdc: '0.40',
        maxSlippageBps: 200,
        wallet: address,
      },
    });
    expect(res.body.data.summary).toContain('Buy YES on "ETH above 5k?" for 20.00 USDC');
    expect(res.body.data.summary).toContain('up to 2%');
    const tx = VersionedTransaction.deserialize(Buffer.from(res.body.data.transaction, 'base64'));
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(address);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    const stored = await h.trades.get(res.body.data.tradeId);
    expect(stored).toMatchObject({
      kind: 'buy',
      wallet: address,
      status: 'built',
      orderId: 'ord_1',
      quoteId: 'qt_1',
      amountUsdcBase: 20_000_000,
      sessionAddress: address,
      summary: res.body.data.summary,
    });
    expect(stored?.consentAt).toBeInstanceOf(Date);
  });

  it('submits the signed transaction, broadcasts it, tells Panta and reports the trade for attribution', async () => {
    const h = use(harness());
    const wallet = Keypair.generate();
    const build = await built(wallet);
    const { signed, signature } = signTx(build.transaction, wallet);

    const submit = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signedTransaction: signed,
    });
    expect(submit.status).toBe(200);
    expect(submit.body.data).toMatchObject({
      tradeId: build.tradeId,
      signature,
      status: 'submitted',
      broadcastBy: 'epoch',
    });
    expect(submit.body.data.explorerUrl).toBe(`https://explorer.solana.com/tx/${signature}`);
    expect(h.chain.broadcasts).toHaveLength(1);
    expect(h.panta.calls.find((c) => c.name === 'submitBuy')?.body).toEqual({
      orderId: 'ord_2',
      signature,
      wallet: wallet.publicKey.toBase58(),
    });

    session = undefined; // status is public
    const pending = await call('GET', `/v1/predict/panta/status/${build.tradeId}`);
    expect(pending.body.data).toMatchObject({ status: 'submitted', attribution: 'pending', action: 'buy' });

    h.chain.states.set(signature, 'confirmed');
    const done = await call('GET', `/v1/predict/panta/status/${build.tradeId}`);
    expect(done.body.data).toMatchObject({
      status: 'confirmed',
      attribution: 'processed',
      orderStatus: 'confirmed',
      marketId: OTHER,
      side: 'yes',
      amountUsdc: '20.00',
    });
    expect(h.panta.calls.find((c) => c.name === 'reportTrade')?.body).toEqual({
      signature,
      wallet: wallet.publicKey.toBase58(),
      marketId: OTHER,
      quoteId: 'qt_1',
      clientOrderId: build.tradeId,
    });

    session = wallet.publicKey.toBase58();
    const again = await call('POST', '/v1/predict/panta/submit', { tradeId: build.tradeId, signedTransaction: signed });
    expect(again.body.data).toMatchObject({ status: 'confirmed', signature });
    const other = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signature: base58Encode(randomBytes(64)),
    });
    expect([other.status, other.body.error.code]).toEqual([409, 'TRADE_ALREADY_SUBMITTED']);
  });

  it('refuses a modified, unsigned or rejected transaction', async () => {
    const h = use(harness());
    const wallet = Keypair.generate();
    const build = await built(wallet);

    // Same instructions, another blockhash: not the message that was built.
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: new PublicKey(randomBytes(32)).toBase58(),
      instructions: [],
    }).compileToV0Message();
    const modified = new VersionedTransaction(message);
    modified.sign([wallet]);
    const res = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signedTransaction: Buffer.from(modified.serialize()).toString('base64'),
    });
    expect([res.status, res.body.error.code]).toEqual([400, 'TX_MODIFIED']);

    const forged = VersionedTransaction.deserialize(Buffer.from(build.transaction, 'base64'));
    forged.signatures[0] = new Uint8Array(randomBytes(64));
    const bad = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signedTransaction: Buffer.from(forged.serialize()).toString('base64'),
    });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'TX_NOT_SIGNED']);
    const unsigned = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signedTransaction: build.transaction,
    });
    expect(unsigned.body.error.code).toBe('TX_NOT_SIGNED');

    h.chain.broadcastError = new BroadcastRejected('Transaction simulation failed: custom program error: 0x1', ['log']);
    const rejected = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signedTransaction: signTx(build.transaction, wallet).signed,
    });
    expect([rejected.status, rejected.body.error.code]).toEqual([400, 'TX_REJECTED']);
    expect((await h.trades.get(build.tradeId))?.status).toBe('failed');
    expect(h.panta.count('submitBuy')).toBe(0);

    const both = await call('POST', '/v1/predict/panta/submit', {
      tradeId: build.tradeId,
      signature: 'x'.repeat(88),
      signedTransaction: 'y'.repeat(200),
    });
    expect(both.status).toBe(400);
    expect(
      (await call('POST', '/v1/predict/panta/submit', { tradeId: 'nope', signature: 'x'.repeat(88) })).status,
    ).toBe(400);
    const missing = await call('GET', '/v1/predict/panta/status/ptr_doesnotexist');
    expect([missing.status, missing.body.error.code]).toEqual([404, 'TRADE_NOT_FOUND']);
  });

  it('follows wallet-broadcast trades on chain and reports every confirmed one (attribution job)', async () => {
    const h = use(harness());
    const wallet = Keypair.generate();
    const first = await built(wallet);
    const sig1 = base58Encode(randomBytes(64));
    const submit = await call('POST', '/v1/predict/panta/submit', { tradeId: first.tradeId, signature: sig1 });
    expect(submit.body.data).toMatchObject({ status: 'submitted', broadcastBy: 'wallet' });
    expect(h.chain.broadcasts).toHaveLength(0);

    const second = await built(wallet);
    const sig2 = base58Encode(randomBytes(64));
    await call('POST', '/v1/predict/panta/submit', { tradeId: second.tradeId, signature: sig2 });

    expect(await h.services.service.reconcile()).toMatchObject({ checked: 2, confirmed: 0, reported: 0 });
    h.chain.states.set(sig1, 'confirmed');
    h.chain.height = 5_000 + 151; // past sig2's last valid block height: it can never land
    expect(await h.services.service.reconcile()).toMatchObject({ confirmed: 1, reported: 1, expired: 1 });
    expect(await h.trades.get(first.tradeId)).toMatchObject({ status: 'confirmed', reportStatus: 'processed' });
    expect(await h.trades.get(second.tradeId)).toMatchObject({ status: 'expired', reportStatus: 'failed' });
    expect(await h.services.service.reconcile()).toMatchObject({ checked: 0 });

    // Panta not ready yet: stays pending and is retried.
    const third = await built(wallet);
    const sig3 = base58Encode(randomBytes(64));
    await call('POST', '/v1/predict/panta/submit', { tradeId: third.tradeId, signature: sig3 });
    h.chain.states.set(sig3, 'confirmed');
    h.panta.failNext.reportTrade = pantaApiError({
      endpoint: 'POST /trades/',
      status: 404,
      code: 'TX_NOT_FOUND',
      message: 'not yet',
    });
    await h.services.service.reconcile();
    expect(await h.trades.get(third.tradeId)).toMatchObject({
      status: 'confirmed',
      reportStatus: 'pending',
      reportAttempts: 1,
    });
    await h.services.service.reconcile();
    expect(await h.trades.get(third.tradeId)).toMatchObject({ reportStatus: 'processed' });
  });

  it('builds a win claim with consent and reports it once confirmed', async () => {
    const h = use(harness());
    const wallet = Keypair.generate();
    session = wallet.publicKey.toBase58();
    const body = { wallet: session, marketId: OTHER };
    expect((await call('POST', '/v1/predict/panta/claim/build', body)).body.error.code).toBe('CONSENT_REQUIRED');
    const claim = await call('POST', '/v1/predict/panta/claim/build', { ...body, consent: true });
    expect(claim.status).toBe(200);
    expect(claim.body.data).toMatchObject({
      action: 'claim',
      orderId: null,
      review: { action: 'claim', side: 'yes', amountUsdc: '38' },
    });
    expect(claim.body.data.summary).toContain('Claim winnings on "ETH above 5k?": 38 winning YES shares');
    const { signed, signature } = signTx(claim.body.data.transaction, wallet);
    await call('POST', '/v1/predict/panta/submit', { tradeId: claim.body.data.tradeId, signedTransaction: signed });
    h.chain.states.set(signature, 'confirmed');
    await h.services.service.reconcile();
    expect(
      h.panta.calls.filter((c) => c.name === 'reportTrade').map((c) => (c.body as { signature: string }).signature),
    ).toEqual([signature]);
    expect(h.panta.count('submitBuy')).toBe(0); // claims have no order session
  });

  it('shows positions with claimability and a display-only value', async () => {
    const h = use(harness());
    const wallet = pkey(70);
    h.panta.positionsByWallet.set(wallet, [
      {
        marketId: OTHER,
        category: 'crypto',
        side: 'yes',
        shares: '38.40',
        phase: 'primary',
        claimable: false,
        claimed: false,
        outcome: null,
      },
      {
        marketId: OUR,
        category: 'crypto',
        side: 'no',
        shares: '10',
        phase: 'resolved',
        claimable: true,
        claimed: false,
        outcome: 'no',
      },
      {
        marketId: GOLD,
        category: 'crypto',
        side: 'yes',
        shares: '5',
        phase: 'resolved',
        claimable: false,
        claimed: false,
        outcome: 'no',
      },
    ]);
    const res = await call('GET', `/v1/predict/panta/positions?wallet=${wallet}`);
    expect(res.status).toBe(200);
    expect(res.body.data.claimableCount).toBe(1);
    expect(res.body.data.positions.map((p: object) => p)).toEqual([
      expect.objectContaining({
        marketId: OTHER,
        state: 'open',
        price: 0.52,
        estValueUsdc: '19.97',
        ours: false,
        title: 'ETH above 5k?',
      }),
      expect.objectContaining({ marketId: OUR, state: 'claimable', estValueUsdc: '10.00', ours: true }),
      expect.objectContaining({ marketId: GOLD, state: 'lost', estValueUsdc: '0.00', title: null }),
    ]);
    expect((await call('GET', '/v1/predict/panta/positions?wallet=nope')).status).toBe(400);
  });

  it('maps Panta errors to stable codes', async () => {
    const h = use(harness());
    const quote = { wallet: OTHER, marketId: OTHER, side: 'yes', amountUsdc: '20' };
    const cases: [Error, number, string][] = [
      [
        pantaApiError({ endpoint: 'q', status: 400, code: 'AMOUNT_TOO_SMALL', message: 'min 1' }),
        400,
        'PANTA_AMOUNT_TOO_SMALL',
      ],
      [
        pantaApiError({ endpoint: 'q', status: 400, code: 'MARKET_NOT_IN_PRIMARY', message: 'closed' }),
        409,
        'PANTA_MARKET_CLOSED',
      ],
      [
        pantaApiError({ endpoint: 'q', status: 401, code: 'UNAUTHORIZED', message: 'bad key' }),
        503,
        'PANTA_AUTH_FAILED',
      ],
      [pantaApiError({ endpoint: 'q', status: 403, code: 'FORBIDDEN', message: 'region' }), 403, 'PANTA_FORBIDDEN'],
      [
        pantaApiError({ endpoint: 'q', status: 429, code: 'RATE_LIMITED', message: 'slow', retryAfterSeconds: 9 }),
        429,
        'PANTA_RATE_LIMITED',
      ],
      [new PantaBudgetError('q', 'quote', 12), 429, 'PANTA_BUSY'],
      [
        pantaApiError({ endpoint: 'q', status: 500, code: 'INTERNAL_ERROR', message: 'oops' }),
        502,
        'PANTA_UNAVAILABLE',
      ],
    ];
    for (const [error, status, code] of cases) {
      h.panta.failNext.quoteBuy = error;
      const res = await call('POST', '/v1/predict/panta/quote', quote);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
    }
    h.panta.failNext.quoteBuy = pantaApiError({
      endpoint: 'q',
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow',
      retryAfterSeconds: 9,
    });
    expect((await call('POST', '/v1/predict/panta/quote', quote)).body.error.details).toMatchObject({
      retryAfterSeconds: 9,
    });
    session = pkey(71);
    h.panta.failNext.buildBuy = pantaApiError({ endpoint: 'b', status: 400, code: 'QUOTE_STALE', message: 'moved' });
    const stale = await call('POST', '/v1/predict/panta/build', { quoteId: 'qt_9', wallet: pkey(71), consent: true });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'PANTA_QUOTE_STALE']);
  });

  it('rate-limits quotes per IP', async () => {
    use(harness());
    const quote = { wallet: OTHER, marketId: OTHER, side: 'yes', amountUsdc: '20' };
    for (let i = 0; i < 20; i++) expect((await call('POST', '/v1/predict/panta/quote', quote)).status).toBe(200);
    const limited = await call('POST', '/v1/predict/panta/quote', quote);
    expect([limited.status, limited.body.error.code]).toEqual([429, 'TOO_MANY_REQUESTS']);
  });

  it('reports traction from our records and Panta’s metrics', async () => {
    const h = use(harness());
    h.panta.attributed = [
      {
        signature: base58Encode(randomBytes(64)),
        wallet: pkey(71),
        marketId: OUR,
        side: 'yes',
        kind: 'buy',
        amountUsdc: '40.00',
        amountUsdcBase: '40000000',
        status: 'processed',
        createdAt: null,
      },
    ];
    const wallet = Keypair.generate();
    const build = await built(wallet);
    const signature = base58Encode(randomBytes(64));
    await call('POST', '/v1/predict/panta/submit', { tradeId: build.tradeId, signature });
    h.chain.states.set(signature, 'confirmed');
    await h.services.service.reconcile();
    const stats = await call('GET', '/v1/predict/panta/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.data).toMatchObject({
      poweredBy: 'Panta',
      epoch: {
        trades: 1,
        buys: 1,
        uniqueWallets: 1,
        volumeUsdc: '20.00',
        attributedTrades: 1,
        pendingAttribution: 0,
        marketsCreated: 1,
        marketsLive: 1,
        creationFeesPaidUsdc: '50.00',
      },
      panta: { attributedTrades: 3, attributedVolumeUsdc: '60.00', byKind: { buy: 2, claim: 1 } },
    });
    // Epoch on Panta: Panta's dashboard, metrics, creates, attributed trades and own catalog, joined with our records.
    expect(stats.body.data.traction).toMatchObject({
      stale: false,
      account: { status: 'active', canCreateMarkets: true },
      marketsCreated: 2,
      createsByStatus: { registered: 2, pending: 1 },
      attributedVolumeUsdc: '60.00',
      marketsVolumeUsdc: '1250.40',
      traders: 2,
      tradersComplete: false,
      attributedTrades: 3,
      tradesByKind: { buy: 2, claim: 1 },
      creatorFeesClaimedUsdc: '0.00',
      creationFeesPaidUsdc: '50.00',
      estimatedProtocolFeesUsdc: '0.40',
      sources: { dashboard: true, metrics: true, creates: true, trades: true, catalog: true },
    });
    expect(stats.body.data.traction.asOf).toMatch(/\+05:30$/);
    for (const name of ['dashboard', 'metrics', 'creates', 'attributedTrades']) expect(h.panta.count(name)).toBe(1);

    // Cached for two minutes; afterwards a Panta outage serves the cached copy, flagged stale.
    await call('GET', '/v1/predict/panta/stats');
    expect(h.panta.count('dashboard')).toBe(1);
    h.clock.now += 121_000;
    for (const name of ['dashboard', 'metrics', 'creates', 'attributedTrades', 'listMarkets']) {
      h.panta.failNext[name] = new PantaNetworkError('down', name, false);
    }
    const stale = await call('GET', '/v1/predict/panta/stats');
    expect(stale.body.data.traction).toMatchObject({ stale: true, marketsCreated: 2, traders: 2 });
  });

  it('forecasts an epoch’s index from its strike ladder, with the monotonic fit and an 80% band', async () => {
    const h = use(harness({}, true, true));
    const res = await call('GET', '/v1/predict/panta/forecast');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      poweredBy: 'Panta',
      label: 'informational',
      stale: false,
      epoch: 1_051,
      epochs: [1_051],
      unit: 'µL/CU',
      fit: { method: 'lognormal-fit', strikesUsed: 3 },
      lastValue: { epoch: 1_049, value: 1_250 },
      reason: null,
    });
    expect(data.strikes.map((s: { strikeMicroLamports: number }) => s.strikeMicroLamports)).toEqual([
      1_100, 1_300, 1_500,
    ]);
    expect(data.strikes.map((s: { impliedProbability: number }) => s.impliedProbability)).toEqual([0.85, 0.62, 0.3]);
    expect(data.strikes.map((s: { empiricalProbability: number }) => s.empiricalProbability)).toEqual([0.8, 0.4, 0]);
    // P(index > 1,300) = 0.62 and P(index > 1,500) = 0.30: the median lies between the two strikes.
    expect(data.median).toBeGreaterThan(1_300);
    expect(data.median).toBeLessThan(1_500);
    expect(data.expected).toBeGreaterThan(data.median);
    expect(data.band.low).toBeLessThan(1_100);
    expect(data.band.high).toBeGreaterThan(1_500);
    expect(data.band.coverage).toBe(0.8);
    expect(data.disclaimer).toContain('not advice');

    const none = await call('GET', '/v1/predict/panta/forecast?epoch=999');
    expect(none.body.data).toMatchObject({
      epoch: 999,
      strikes: [],
      median: null,
      reason: 'no markets on this epoch yet',
    });
    expect((await call('GET', '/v1/predict/panta/forecast?epoch=abc')).status).toBe(400);

    // The WS predict:panta frame carries the same forecast, from the same prices.
    const frame = await h.services.service.streamSnapshot();
    expect(frame.forecasts).toEqual([
      {
        epoch: 1_051,
        median: data.median,
        expected: data.expected,
        band: data.band,
        method: 'lognormal-fit',
        strikes: 3,
      },
    ]);

    // The Terminal's Fee Index card: the same forecast, compact.
    const card = await call('GET', '/v1/index/forecast');
    expect(card.status).toBe(200);
    expect(card.body.data).toMatchObject({
      available: true,
      epoch: 1_051,
      median: data.median,
      expected: data.expected,
      band: data.band,
      method: 'lognormal-fit',
      strikes: 3,
      poweredBy: 'Panta',
      details: '/v1/predict/panta/forecast?epoch=1051',
    });
    use(harness({}, false));
    expect((await call('GET', '/v1/index/forecast')).body.data).toMatchObject({
      available: false,
      reason: 'Panta is not configured on this server',
      median: null,
    });
  });

  it('serves the markets’ 1024×1024 catalog image', async () => {
    use(harness());
    const res = await fetch(`${base}/v1/predict/panta/market-image.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    const png = Buffer.from(await res.arrayBuffer());
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1_024, 1_024]);
    const etag = res.headers.get('etag') as string;
    const again = await fetch(`${base}/v1/predict/panta/market-image.png`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });

  it('serves one epoch’s Fee Index as the resolution source', async () => {
    const programId = Keypair.generate().publicKey.toBase58();
    setFeeIndexEpochService(
      new FeeIndexEpochService({
        computed: async (epoch) => (epoch === 1_051 ? { value: 1_400, postedSignature: 'postSig' } : null),
        programPoint: async (programEpoch) => (programEpoch === 1_176 ? { value: 1_400, status: 'final' } : null),
        postedEpoch: async (signature) => (signature === 'postSig' ? 1_176 : null),
        program: { programId, cluster: 'devnet' },
        methodologyUrl: 'https://github.com/x/methodology',
      }),
    );
    const res = await call('GET', '/v1/index/epochs/1051');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      epoch: 1_051,
      value: 1_400,
      status: 'final',
      final: true,
      unit: 'µL/CU',
      computedValue: 1_400,
      onChain: { cluster: 'devnet', programId, programEpoch: 1_176, postSignature: 'postSig' },
    });
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect((await call('GET', '/v1/index/epochs/1052')).body.data).toMatchObject({
      status: 'pending',
      value: null,
      final: false,
    });
    expect((await call('GET', '/v1/index/epochs/abc')).status).toBe(400);
  });

  it('compiles builds from Panta’s instructions only when the wallet is the sole signer', async () => {
    const h = use(harness());
    const wallet = Keypair.generate();
    session = wallet.publicKey.toBase58();
    const original = h.panta.buildBuy.bind(h.panta);
    h.panta.buildBuy = async (body) => ({
      ...(await original(body)),
      instructions: [walletInstruction(pkey(33))],
    });
    const res = await call('POST', '/v1/predict/panta/build', { quoteId: 'qt_1', wallet: session, consent: true });
    expect([res.status, res.body.error.code]).toEqual([502, 'PANTA_BAD_RESPONSE']);
    expect(h.trades.rows.size).toBe(0);
  });
});
