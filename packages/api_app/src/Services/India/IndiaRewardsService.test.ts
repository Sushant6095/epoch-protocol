import { financialYear } from '../../Lib/IndianFy';
import { type StakeAccountInfo, U64_MAX } from '../../Lib/StakeLayouts';
import { type EpochSpan } from './EpochCalendar';
import { type IndiaRewardsDeps, IndiaRewardsService, Semaphore } from './IndiaRewardsService';
import { type LivePrice, PriceBook, SOURCE_COINGECKO } from './InrPriceService';

const HOUR = 3_600_000;
const FY = financialYear(2026);
const WALLET = 'C9MDVY8HjxbsgiEDfPefxTvA63Ps39E5XHxGiZt4PDdd';
const OTHER = 'tboxpC4pHDqMfg5waLxSF7F2QaZvrUDge8MxSSnoZif';
const CURRENT = 1048;

const account = (pubkey: string, stakeSol = 10): StakeAccountInfo => ({
  pubkey,
  lamports: BigInt(stakeSol * 1e9),
  state: 'delegated',
  rentExemptReserve: 2_282_880n,
  staker: WALLET,
  withdrawer: WALLET,
  lockupUnixTimestamp: 0n,
  lockupEpoch: 0n,
  custodian: WALLET,
  voter: 'vote',
  stakeLamports: BigInt(stakeSol * 1e9),
  activationEpoch: 900n,
  deactivationEpoch: U64_MAX,
  creditsObserved: 0n,
});

/** Epochs 1040–1047, ending 32 hours apart from 1 Oct 2026 IST (all in FY 2026-27). */
const spans = new Map<number, EpochSpan>(
  Array.from({ length: 8 }, (_, i) => {
    const endMs = Date.parse('2026-09-22T00:00:00+05:30') + i * 32 * HOUR;
    return [1040 + i, { epoch: 1040 + i, startMs: endMs - 32 * HOUR, endMs }];
  }),
);

const live: LivePrice = {
  inr: 11_500,
  usd: 120,
  usdInr: 95.83,
  change24hPct: null,
  source: SOURCE_COINGECKO,
  observedAtMs: Date.now(),
  fetchedAtMs: Date.now(),
  stale: false,
  staleReason: null,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(over: Partial<IndiaRewardsDeps> = {}) {
  const gate = deferred();
  let gated = false;
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const rewards = {
    get: jest.fn(async (accounts: readonly string[], epoch: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(epoch);
      try {
        if (gated) await gate.promise;
        await new Promise((r) => setTimeout(r, 1));
        return new Map(accounts.map((a) => [a, 1_000_000] as [string, number | null]));
      } finally {
        active--;
      }
    }),
  };
  const deps: IndiaRewardsDeps = {
    stakeAccounts: jest.fn(async () => [account('stakeA'), account('stakeB', 20)]),
    rewards,
    calendar: { spans: async () => spans },
    currentEpoch: async () => CURRENT,
    prices: {
      live: async () => live,
      history: async () => ({
        book: new PriceBook(
          [...spans.values()].map((s) => ({ ms: s.endMs, inr: 10_000 + s.epoch, source: SOURCE_COINGECKO })),
        ),
        notes: [],
      }),
    },
    rpcConcurrency: 2,
    newReadsPerHour: 20,
    waitMs: 5_000,
    ...over,
  };
  return {
    service: new IndiaRewardsService(deps),
    deps,
    rewards,
    order,
    stats: () => ({ maxActive }),
    hold: () => (gated = true),
    release: () => {
      gated = false;
      gate.resolve();
    },
  };
}

describe('IndiaRewardsService', () => {
  it('answers partial while it reads, then the whole year; a finished year is kept', async () => {
    const t = setup({ waitMs: 20 });
    t.hold();
    const first = await t.service.get(WALLET, FY, { ip: '1.2.3.4' });
    expect(['loading', 'partial']).toContain(first.status);
    expect(first.retryAfterSeconds).toBe(4);
    expect(first.stage).toBe('rewards');
    t.release();
    let view = first;
    for (let i = 0; i < 50 && view.status !== 'complete'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      view = await t.service.get(WALLET, FY, { ip: '1.2.3.4' });
    }
    expect(view.status).toBe('complete');
    expect(view.retryAfterSeconds).toBeNull();
    expect(view.stage).toBe('done');
    expect(view.coverage).toMatchObject({ epochsInYear: 8, epochsRead: 8, epochsPending: 0, stakeAccounts: 2 });
    // Two accounts × 0.001 SOL per epoch.
    expect(view.totals.rewardSol).toBe(0.016);
    expect(view.epochs[0]).toMatchObject({ epoch: 1040, rewardSol: 0.002, priceInr: 11_040 });
    // The total is the sum of the rows as shown (each rounded to paise), so the CSV adds up: ₹176.69, not ₹176.696.
    expect(view.totals.rewardInr.inr).toBe(176.69);
    expect(view.epochs.reduce((sum, e) => sum + (e.rewardInr.inr ?? 0), 0)).toBeCloseTo(176.69, 9);
    const calls = t.rewards.get.mock.calls.length;
    expect(calls).toBe(8);
    expect(t.order).toEqual([1047, 1046, 1045, 1044, 1043, 1042, 1041, 1040]);
    await t.service.get(WALLET, FY, { ip: '1.2.3.4' });
    expect(t.rewards.get).toHaveBeenCalledTimes(calls);
  });

  it('keeps at most rpcConcurrency calls in flight across wallets', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.service.get(WALLET, FY, { ip: 'a' }), t.service.get(OTHER, FY, { ip: 'b' })]);
    expect([a.status, b.status]).toEqual(['complete', 'complete']);
    expect(t.stats().maxActive).toBe(2);
    expect(t.rewards.get).toHaveBeenCalledTimes(16);
  });

  it('retries a failed epoch once and reports the year incomplete when it still fails', async () => {
    let flaky = 0;
    const t = setup();
    t.rewards.get.mockImplementation(async (accounts: readonly string[], epoch: number) => {
      if (epoch === 1043) throw new Error('RPC getInflationReward failed');
      if (epoch === 1045 && flaky++ === 0) throw new Error('timeout');
      return new Map(accounts.map((a) => [a, 1_000_000] as [string, number | null]));
    });
    const view = await t.service.get(WALLET, FY);
    expect(view.status).toBe('incomplete');
    expect(view.coverage).toMatchObject({ epochsRead: 7, epochsFailed: 1, failedEpochs: [1043], epochsPending: 0 });
    // An incomplete year is not served for long: the CSV is still allowed, with the missing epochs listed.
    await expect(t.service.getFinished(WALLET, FY)).resolves.toMatchObject({ status: 'incomplete' });
  });

  it('treats a wallet without stake accounts as a complete year of nothing', async () => {
    const t = setup({ stakeAccounts: async () => [] });
    const view = await t.service.get(WALLET, FY);
    expect(view.status).toBe('complete');
    expect(view.coverage).toMatchObject({ epochsInYear: 8, epochsRead: 8, stakeAccounts: 0 });
    expect(view.totals).toMatchObject({ rewardSol: 0, rewardInr: { inr: 0 } });
    expect(view.note).toMatch(/no stake accounts/);
    expect(t.rewards.get).not.toHaveBeenCalled();
  });

  it('limits new wallet reads per IP, not polls of a read already running', async () => {
    const t = setup({ newReadsPerHour: 1 });
    await t.service.get(WALLET, FY, { ip: '9.9.9.9' });
    await t.service.get(WALLET, FY, { ip: '9.9.9.9' });
    await expect(t.service.get(OTHER, FY, { ip: '9.9.9.9' })).rejects.toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(t.service.get(OTHER, FY, { ip: '8.8.8.8' })).resolves.toMatchObject({ wallet: OTHER });
  });

  it('refuses the CSV while the year is still loading (503 REWARDS_LOADING)', async () => {
    const t = setup({ waitMs: 10 });
    t.hold();
    await expect(t.service.getFinished(WALLET, FY)).rejects.toMatchObject({
      statusCode: 503,
      code: 'REWARDS_LOADING',
      details: expect.objectContaining({ retryAfterSeconds: 4, epochsInYear: 8 }),
    });
    t.release();
  });

  it('answers 502 when the stake accounts cannot be read, and starts over on the next request', async () => {
    const stakeAccounts = jest.fn().mockRejectedValueOnce(new Error('RPC getProgramAccounts failed'));
    stakeAccounts.mockResolvedValue([account('stakeA')]);
    const t = setup({ stakeAccounts });
    await expect(t.service.get(WALLET, FY)).rejects.toMatchObject({ statusCode: 502, code: 'CHAIN_ERROR' });
    await expect(t.service.get(WALLET, FY)).resolves.toMatchObject({ status: 'complete' });
  });

  it('answers 503 EPOCH_TIMES_UNAVAILABLE when Stakewiz has never answered', async () => {
    const t = setup({
      calendar: {
        spans: async () => {
          throw new Error('HTTP 502 from api.stakewiz.com');
        },
      },
    });
    await expect(t.service.get(WALLET, FY)).rejects.toMatchObject({ statusCode: 503, code: 'EPOCH_TIMES_UNAVAILABLE' });
  });
});

describe('Semaphore', () => {
  it('never runs more than its limit and starts waiters in order', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        semaphore.run(async () => {
          started.push(i);
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
