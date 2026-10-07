import { type AddressInfo } from 'net';

import { createRouter, ExpressAppServer, handle } from '@epoch/common_http_server';

import { fakeDeps, validatorRow } from '../__fixtures__/ProgramFakes';
import { key, ProgramSim, sol } from '../__fixtures__/ProgramSim';
import { SESSION_LOCALS_KEY } from '../Lib/Session';
import { createProgramServices, setProgramServices } from '../Services/Program/ProgramServices';
import { lenderRouter, marketRouter, validatorPositionRouter, vaultRouter } from './ProgramRouters';

const W = (label: string): string => key(label).toBase58();
const LENDER = W('lender');
const OPERATOR = W('operator');
const VOTE = W('vote');

describe('Program routers', () => {
  let server: ExpressAppServer;
  let base: string;
  let session: string | undefined;

  beforeAll(async () => {
    const sim = new ProgramSim(1100);
    sim.marketMaker = key('maker');
    sim.initialize();
    sim.initializeIndex();
    sim.deposit(LENDER, 'junior', sol(100));
    sim.onboard(VOTE, OPERATOR, { bond: sol(5) });
    sim.initHistory(VOTE);
    sim.copyVoteAccount(VOTE);
    setProgramServices(
      createProgramServices(
        fakeDeps(sim, await sim.store(), { rows: [validatorRow({ name: 'Mainnet One', vote: W('mainnet') })] }),
      ),
    );
    server = new ExpressAppServer({ appName: 'program-routers-test', port: 0 })
      // Stand-in for the session middleware (request #7): sets res.locals.session for signed-in requests.
      .use((_req, res, next) => {
        if (session) res.locals[SESSION_LOCALS_KEY] = { id: 'x', address: session, expiresAt: '' };
        next();
      })
      // Another router on the same prefix, like validatorsRouter's `/:vote`: requests fall through to ours.
      .route(
        '/v1/validators',
        createRouter().get(
          '/:vote',
          handle(async () => ({ profile: true })),
        ),
      )
      .route('/v1/vault', vaultRouter)
      .route('/v1/validators', validatorPositionRouter)
      .route('/v1/wallets', lenderRouter)
      .route('/v1/market', marketRouter);
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setProgramServices(undefined);
    await server.stop();
  });

  interface Reply<T> {
    status: number;
    body: { ok: boolean; data: T; error?: { code: string } };
  }
  const get = async <T = Record<string, unknown>>(path: string): Promise<Reply<T>> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Reply<T>['body'] };
  };

  it('serves the four endpoints wrapped as { ok, data }', async () => {
    const vault = await get('/v1/vault');
    expect(vault.status).toBe(200);
    expect(vault.body).toMatchObject({ ok: true, data: { kind: 'real', pool: { tvlSol: 100 } } });
    expect((await get(`/v1/validators/${VOTE}/position`)).body).toMatchObject({
      ok: true,
      data: { vote: VOTE, state: 'onboarded', bondSol: 5 },
    });
    expect((await get(`/v1/wallets/${LENDER}/lender`)).body).toMatchObject({
      ok: true,
      data: { owner: LENDER, tranches: [{ tranche: 'junior', valueSol: 100 }] },
    });
    expect((await get('/v1/market')).body).toMatchObject({ ok: true, data: { currentEpoch: 1100, quotes: [] } });
    expect((await get(`/v1/validators/${VOTE}`)).body).toEqual({ ok: true, data: { profile: true } });
  });

  it('answers 400 for a vote or wallet that is not a base58 public key, 404 for an unknown validator', async () => {
    const badVote = await get('/v1/validators/not-a-key/position');
    expect(badVote.status).toBe(400);
    expect(badVote.body.error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((await get('/v1/wallets/0OIl/lender')).status).toBe(400);
    expect((await get(`/v1/validators/${W('nobody')}/position`)).status).toBe(404);
  });

  it('serves the on-chain history with its freshness and cache header; 400 for a bad key, 404 without a history', async () => {
    const res = await fetch(`${base}/v1/validators/${VOTE}/history`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    const body = (await res.json()) as Reply<{ entries: unknown[] }>['body'];
    expect(body).toMatchObject({
      ok: true,
      data: {
        vote: VOTE,
        currentEpoch: 1100,
        freshness: { status: 'fresh', lastVoteCopyEpoch: 1100, refreshReady: false },
        lastRefresh: null,
      },
    });
    expect(body.data.entries).toHaveLength(11);
    expect((await get(`/v1/validators/${VOTE}/position`)).body.data).toMatchObject({
      scoreBreakdown: { source: 'scorer', history: { freshness: 'fresh' } },
    });
    const bad = await get('/v1/validators/not-a-key/history');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((await get(`/v1/validators/${W('nobody')}/history`)).status).toBe(404);
  });

  it('uses the session for isMine and myHedge', async () => {
    session = OPERATOR;
    try {
      const market = await get<{ myHedge: unknown }>('/v1/market');
      expect(market.body.data.myHedge).toMatchObject({ vote: VOTE, hedgedEpochs: [], epochsToHedge: [] });
    } finally {
      session = undefined;
    }
    expect((await get<{ myHedge: unknown }>('/v1/market')).body.data.myHedge).toBeNull();
  });
});
