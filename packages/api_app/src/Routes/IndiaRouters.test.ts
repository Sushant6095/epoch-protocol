import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';

import { indiaProfile, indiaStakewiz, indiaTable, VOTES } from '../__fixtures__/IndiaFakes';
import { financialYearAt } from '../Lib/IndianFy';
import { RateLimiter } from '../Lib/RateLimiter';
import { type StakeAccountInfo, U64_MAX } from '../Lib/StakeLayouts';
import { setIndiaServices } from '../Services/India';
import chart from '../Services/India/__fixtures__/coingecko-market-chart.recorded.json';
import simple from '../Services/India/__fixtures__/coingecko-simple-price.recorded.json';
import stakewizEpochs from '../Services/India/__fixtures__/stakewiz-epochs.recorded.json';
import { buildEpochSpans } from '../Services/India/EpochCalendar';
import { IndiaRewardsService } from '../Services/India/IndiaRewardsService';
import { IndiaValidatorService } from '../Services/India/IndiaValidators';
import { InrPriceService } from '../Services/India/InrPriceService';
import {
  type IndiaPrice,
  type IndiaSummary,
  type IndiaValidatorList,
  type IndiaWalletRewards,
} from '../types/India.types';
import { indiaRouter } from './IndiaRouters';

const WALLET = 'C9MDVY8HjxbsgiEDfPefxTvA63Ps39E5XHxGiZt4PDdd';
const RECORDED_AT = Date.parse('2026-10-03T12:36:00Z');

function prices(down = false): InrPriceService {
  const fail = async (): Promise<never> => {
    throw new Error('source down');
  };
  return new InrPriceService({
    coingecko: {
      solInr: down
        ? fail
        : async () => ({
            inr: simple.body.solana.inr,
            usd: simple.body.solana.usd,
            inrChange24hPct: simple.body.solana.inr_24h_change,
            updatedAtMs: simple.body.solana.last_updated_at * 1_000,
          }),
      solInrDaily: async () => chart.body.prices.map(([ms, inr]) => ({ ms, inr })),
    },
    solUsd: down ? fail : async () => ({ value: 119.31, loadedAtMs: RECORDED_AT }),
    usdInr: down ? fail : async () => ({ value: 96.32, loadedAtMs: RECORDED_AT }),
    usdHistory: { solUsdDaily: fail },
    fxHistory: { usdInrDaily: fail },
    now: () => RECORDED_AT,
  });
}

const stakeAccount = (pubkey: string): StakeAccountInfo => ({
  pubkey,
  lamports: 10_000_000_000n,
  state: 'delegated',
  rentExemptReserve: 2_282_880n,
  staker: WALLET,
  withdrawer: WALLET,
  lockupUnixTimestamp: 0n,
  lockupEpoch: 0n,
  custodian: WALLET,
  voter: VOTES.mumbai,
  stakeLamports: 10_000_000_000n,
  activationEpoch: 900n,
  deactivationEpoch: U64_MAX,
  creditsObserved: 0n,
});

function services(options: { pricesDown?: boolean; csvPerMinute?: number } = {}) {
  const price = prices(options.pricesDown);
  const spans = buildEpochSpans(stakewizEpochs.body, 1048);
  const calendar = { spans: async () => spans };
  return {
    prices: price,
    validators: new IndiaValidatorService({
      table: async () => indiaTable(),
      stakewiz: async () => indiaStakewiz(),
      profile: async (vote: string) => indiaProfile(vote),
      prices: price,
      calendar,
      listedVotes: new Set([VOTES.listed]),
    }),
    rewards: new IndiaRewardsService({
      stakeAccounts: async () => [stakeAccount('stakeA'), stakeAccount('stakeB')],
      rewards: { get: async (accounts: readonly string[]) => new Map(accounts.map((a) => [a, 1_500_000])) },
      calendar,
      currentEpoch: async () => 1048,
      prices: price,
      rpcConcurrency: 2,
      newReadsPerHour: 100,
    }),
    limits: { rewards: new RateLimiter(100, 60_000), csv: new RateLimiter(options.csvPerMinute ?? 100, 60_000) },
  };
}

describe('India router (/v1/india)', () => {
  let server: ExpressAppServer;
  let base: string;

  beforeAll(async () => {
    setIndiaServices(services({ csvPerMinute: 3 }));
    server = new ExpressAppServer({ appName: 'india-routers-test', port: 0 }).route('/v1/india', indiaRouter);
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setIndiaServices(undefined);
    await server.stop();
  });

  interface Reply<T> {
    status: number;
    headers: Headers;
    body: { ok: boolean; data: T; error?: { code: string; message: string; details?: Record<string, unknown> } };
  }
  const get = async <T = Record<string, unknown>>(path: string): Promise<Reply<T>> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, headers: res.headers, body: (await res.json()) as Reply<T>['body'] };
  };

  it('GET /summary: price, the current FY, India on the map and the prospect', async () => {
    const { status, body } = await get<IndiaSummary>('/v1/india/summary');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      price: { inr: 11_496.63, formatted: '₹11,496.63', source: 'CoinGecko', stale: false },
      fy: { label: financialYearAt(Date.now()).label },
      network: { epoch: 1048, validators: 8 },
      validators: {
        status: 'ok',
        india: { validators: 3, listed: 1, rank: 4 },
        comparison: { india: { countryCode: 'IN', rank: 4 } },
      },
      errors: {},
    });
    expect(data.validators?.top.map((r) => r.name)).toEqual([
      'Mumbai One',
      'Listed Indian Operator',
      'Bengaluru Two',
      'Chennai Three',
    ]);
    expect(data.prospect?.tiers).toHaveLength(3);
    expect(data.disclaimer).toMatch(/not tax advice/);
  });

  it('GET /price: live SOL/INR with its age, and a daily sparkline on request', async () => {
    const { status, headers, body } = await get<IndiaPrice>('/v1/india/price?days=3');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      pair: 'SOL/INR',
      inr: 11_496.63,
      formatted: '₹11,496.63',
      usd: 119.35,
      source: 'CoinGecko',
      asOf: '2026-10-03T18:05:10+05:30',
      observedAt: '2026-10-03T18:05:10+05:30',
      stale: false,
      staleReason: null,
      refreshSeconds: 60,
    });
    expect(body.data.history).toEqual([
      { date: '2026-10-01', at: '2026-10-01T05:30:00+05:30', inr: 11_323.4 },
      { date: '2026-10-02', at: '2026-10-02T05:30:00+05:30', inr: 11_391.28 },
      { date: '2026-10-03', at: '2026-10-03T05:30:00+05:30', inr: 11_400.26 },
    ]);
    expect(headers.get('cache-control')).toBe('public, max-age=15');
    expect((await get('/v1/india/price?days=400')).status).toBe(400);
  });

  it('GET /price answers 503 PRICE_UNAVAILABLE when no source ever answered', async () => {
    setIndiaServices(services({ pricesDown: true }));
    try {
      const { status, body } = await get('/v1/india/price');
      expect(status).toBe(503);
      expect(body.error?.code).toBe('PRICE_UNAVAILABLE');
      // The summary still answers: the validators section does not need the price.
      const summary = await get<IndiaSummary>('/v1/india/summary');
      expect(summary.status).toBe(200);
      expect(summary.body.data.price).toBeNull();
      expect(summary.body.data.errors.price).toMatch(/unavailable/);
      expect(summary.body.data.validators?.india.stakeValueInr).toEqual({ inr: null, formatted: '—', compact: '—' });
    } finally {
      setIndiaServices(services({ csvPerMinute: 3 }));
    }
  });

  it('GET /validators: sorts, filters and pages like /v1/validators', async () => {
    const page = await get<IndiaValidatorList>('/v1/india/validators?sort=apy&limit=2');
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({ status: 'ok', total: 4, india: { validators: 3 } });
    expect(page.body.data.rows.map((r) => r.name)).toEqual(['Bengaluru Two', 'Listed Indian Operator']);
    expect(page.body.data.rows[0]).toMatchObject({
      inIndiaBy: 'ip-geolocation',
      city: 'Bengaluru',
      stakeValueInr: { inr: 574_831_500, formatted: '₹57,48,31,500.00', compact: '₹57.48 Cr' },
      revenue: { basis: 'validator-profile' },
      credit: { estimate: true },
    });
    const next = await get<IndiaValidatorList>(
      `/v1/india/validators?sort=apy&limit=2&cursor=${page.body.data.nextCursor ?? ''}`,
    );
    expect(next.body.data.rows.map((r) => r.name)).toEqual(['Mumbai One', 'Chennai Three']);
    const watch = await get<IndiaValidatorList>('/v1/india/validators?tab=watch');
    expect(watch.body.data.rows.map((r) => r.name)).toEqual(['Bengaluru Two']);
    expect(watch.body.data.facets.client).toEqual({ firedancer: 1 });
    expect((await get('/v1/india/validators?sort=nonsense')).status).toBe(400);
  });

  it('GET /wallets/:address/rewards: the year in SOL and rupees', async () => {
    const { status, headers, body } = await get<IndiaWalletRewards>(`/v1/india/wallets/${WALLET}/rewards?fy=2026-27`);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      wallet: WALLET,
      fy: { label: '2026-27', name: 'FY 2026-27', assessmentYear: 'AY 2027-28' },
      status: 'complete',
      stage: 'done',
      coverage: { epochsInYear: 9, epochsRead: 9, stakeAccounts: 2 },
      totals: { rewardSol: 0.027, epochsWithRewards: 9, epochsWithoutPrice: 0 },
      csvPath: `/v1/india/wallets/${WALLET}/rewards.csv?fy=2026-27`,
    });
    expect(body.data.epochs[0]).toMatchObject({
      epoch: 949,
      date: '2026-04-02',
      rewardSol: 0.003,
      priceDate: '2026-04-02',
    });
    expect(headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('rejects a bad address or financial year with 400', async () => {
    expect((await get('/v1/india/wallets/not-a-wallet/rewards')).status).toBe(400);
    for (const fy of ['2026-28', '2019-20', '2099-00', 'last-year']) {
      const reply = await get(`/v1/india/wallets/${WALLET}/rewards?fy=${fy}`);
      expect(reply.status).toBe(400);
      expect(reply.body.error?.code).toBe('BAD_REQUEST');
    }
  });

  it('GET /wallets/:address/rewards.csv: a UTF-8 CSV with a BOM, as an attachment; rate-limited', async () => {
    const res = await fetch(`${base}/v1/india/wallets/${WALLET}/rewards.csv?fy=2026-27`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="epoch-staking-rewards-FY2026-27-C9MD-PDdd.csv"',
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString('utf8').split('\r\n');
    expect(lines[0]).toMatch(/^Epoch,Credited at \(IST\),.*,"Reward \(₹, formatted\)"$/);
    expect(lines[1]).toMatch(
      /^949,2026-04-02 03:41:01,2026-04-02,2026-27,0\.003000000,7550\.59,2026-04-02,CoinGecko,22\.65,₹22\.65$/,
    );
    expect(lines.find((l) => l.startsWith('Total,'))).toMatch(/^Total,,,2026-27,0\.027000000,/);
    expect(lines.some((l) => l.startsWith('Disclaimer,"Informational only, not tax advice.'))).toBe(true);

    await fetch(`${base}/v1/india/wallets/${WALLET}/rewards.csv?fy=2026-27`);
    await fetch(`${base}/v1/india/wallets/${WALLET}/rewards.csv?fy=2026-27`);
    const limited = await get(`/v1/india/wallets/${WALLET}/rewards.csv?fy=2026-27`);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });
});
