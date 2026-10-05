import { Logger } from '@epoch/logger';
import { type PantaCreateQuoteRequest, pantaApiError } from '@epoch/panta';

import {
  BOT_WALLET,
  clockAt,
  FakeBotChain,
  FakePanta,
  key,
  MemoryIndexHistory,
  MemoryMarketStore,
  NOW,
  pantaMarket,
} from './__fixtures__/fakes';
import { SpendGuardError } from './Chain/BotChain';
import { type LifecycleConfig, MarketLifecycle } from './MarketLifecycle';
import { DEFAULT_SCHEDULE } from './Markets/EpochSchedule';
import { marketQuestion, marketTitle } from './Markets/MarketText';

const FEE_INDEX = { address: key(30), cluster: 'devnet' as const };

const config = (overrides: Partial<LifecycleConfig> = {}): LifecycleConfig => ({
  dryRun: false,
  dryRunReasons: [],
  marketsPerEpoch: 1,
  epochsAhead: 2,
  thresholdLookback: 16,
  schedule: DEFAULT_SCHEDULE,
  maxCreateUsdcBasePerDay: 100_000_000,
  maxLamportsPerCreate: 50_000_000,
  imageUrl: 'https://cdn.epoch.example/panta/fee-index-1024.png',
  publicApiUrl: 'https://api.epoch.example',
  methodologyUrl: 'https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md',
  feeIndexAccount: FEE_INDEX,
  graceHours: 48,
  region: 'Global',
  creatorFeeCheckMs: 6 * 3_600_000,
  maxAttempts: 3,
  ...overrides,
});

function setup(overrides: Partial<LifecycleConfig> = {}) {
  const clock = { now: NOW };
  const store = new MemoryMarketStore(() => clock.now);
  const chain = new FakeBotChain();
  const panta = new FakePanta();
  const history = new MemoryIndexHistory([
    { epoch: 1_049, value: 1_284 },
    { epoch: 1_048, value: 1_250 },
    { epoch: 1_047, value: 1_190 },
  ]);
  const lifecycle = new MarketLifecycle({
    config: config(overrides),
    chain,
    panta,
    store,
    history,
    now: () => clock.now,
  });
  /** Moves wall time and the slot clock together. */
  const advance = (ms: number) => {
    clock.now += ms;
    const slots = Math.round(ms / 400);
    const absoluteSlot = chain.snapshot.absoluteSlot + slots;
    chain.snapshot = clockAt({
      nowMs: clock.now,
      absoluteSlot,
      epoch: Math.floor(absoluteSlot / 432_000),
      slotIndex: absoluteSlot % 432_000,
    });
  };
  return { store, chain, panta, history, lifecycle, advance };
}

const quotes = (panta: FakePanta) =>
  panta.calls.filter((call) => call.name === 'quoteCreate').map((call) => call.body as PantaCreateQuoteRequest);

beforeAll(() => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe('MarketLifecycle (F10)', () => {
  it('creates one market per upcoming epoch from the last final value, then does nothing on the next tick', async () => {
    const { store, chain, panta, lifecycle } = setup();
    const summary = await lifecycle.tick();
    expect(summary).toMatchObject({
      epoch: 1_050,
      dryRun: false,
      targets: [
        { epoch: 1_051, thresholds: [1_300] },
        { epoch: 1_052, thresholds: [1_300] },
      ],
      planned: 2,
      errors: [],
      spent24hUsdc: '100.00',
      budgetUsdc: '100.00',
    });
    expect(summary.created).toHaveLength(2);
    expect(store.rows.map((row) => [row.epoch, row.threshold, row.status])).toEqual([
      [1_051, 1_300, 'registered'],
      [1_052, 1_300, 'registered'],
    ]);
    const [first] = quotes(panta);
    expect(first).toMatchObject({
      wallet: BOT_WALLET,
      question: 'Will the Solana Fee Index for epoch 1051 close above 1,300 micro-lamports per CU?',
      title: 'Solana Fee Index above 1,300 µL/CU in epoch 1051',
      category: 'crypto',
      marketType: 'standard',
      region: 'Global',
      imageUrl: 'https://cdn.epoch.example/panta/fee-index-1024.png',
      sourcesOfTruth: [
        'https://api.epoch.example/v1/index/epochs/1051',
        'https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md',
        `https://explorer.solana.com/address/${FEE_INDEX.address}?cluster=devnet`,
      ],
    });
    // Panta's ordering rule and minimum start delay; trading closes before epoch 1051 starts (~36.9 h away).
    const nowSec = NOW / 1_000;
    expect(first.startTime).toBeGreaterThanOrEqual(nowSec + 3_600);
    expect(first.startTime).toBeLessThan(first.endTime);
    expect(first.endTime).toBeLessThanOrEqual(first.resolutionTime);
    const epochStart = nowSec + 332_000 * 0.4;
    expect(first.endTime).toBeLessThan(epochStart - 3_600);
    expect(first.resolutionTime).toBeGreaterThan(epochStart + 432_000 * 0.4);
    expect(first.resolutionRule.length).toBeLessThanOrEqual(2_048);
    // Each create is guarded at its quoted fee, and its signature was stored before the broadcast.
    expect(chain.signed.map((s) => s.limits.maxUsdcBase)).toEqual([50_000_000, 50_000_000]);
    expect(store.rows.every((row) => row.createSignature && row.signedAt && row.paidUsdcBase === 50_000_000)).toBe(
      true,
    );

    const again = await lifecycle.tick();
    expect(again).toMatchObject({ planned: 0, created: [], errors: [] });
    expect(panta.count('quoteCreate')).toBe(2);
  });

  it('plans and logs only in a dry run: no quotes, no signatures, no rows', async () => {
    const { store, chain, panta, lifecycle } = setup({ dryRun: true, dryRunReasons: ['PANTA_API_KEY is unset'] });
    const summary = await lifecycle.tick();
    expect(summary).toMatchObject({ dryRun: true, planned: 0, created: [] });
    expect(summary.targets).toEqual([
      { epoch: 1_051, thresholds: [1_300] },
      { epoch: 1_052, thresholds: [1_300] },
    ]);
    expect(panta.calls).toEqual([]);
    expect(chain.signed).toEqual([]);
    expect(store.rows).toEqual([]);
  });

  it('stays inside the daily budget and resumes when the window rolls', async () => {
    const { store, panta, lifecycle, advance } = setup({ maxCreateUsdcBasePerDay: 60_000_000 });
    const first = await lifecycle.tick();
    expect(first.created).toHaveLength(1);
    expect(first.waiting).toBe(1);
    expect(store.byEpoch(1_052)[0].status).toBe('planned');
    expect(panta.count('quoteCreate')).toBe(1); // the first fee showed a second would break the budget

    advance(10 * 60_000);
    await lifecycle.tick();
    expect(panta.count('quoteCreate')).toBe(1); // no quote while over budget

    advance(24 * 3_600_000);
    const later = await lifecycle.tick();
    expect(later.created).toHaveLength(1);
    expect(store.byEpoch(1_052)[0].status).toBe('registered');
  });

  it('never creates when even one fee is over the budget', async () => {
    const { store, chain, lifecycle } = setup({ maxCreateUsdcBasePerDay: 40_000_000 });
    await lifecycle.tick();
    expect(chain.signed).toEqual([]);
    expect(store.rows.every((row) => row.status === 'planned')).toBe(true);
  });

  it('recovers after a crash: landed creates are registered, dead ones re-created, unknown ones kept', async () => {
    const { store, chain, panta, lifecycle } = setup({ epochsAhead: 1 });
    // Crash after broadcast: the create landed but the row still says signed.
    const landed = store.insert({
      epoch: 1_051,
      threshold: 1_300,
      status: 'signed',
      question: marketQuestion(1_051, 1_300),
      createId: 'cr_7',
      createSignature: 'sigLanded',
      signedTx: 'signed:tx',
      lastValidBlockHeight: 900,
      quotedUsdcBase: 50_000_000,
      signedAt: new Date(NOW - 60_000),
      expectedEventPda: key(107),
    });
    chain.states.set('sigLanded', 'confirmed');
    // An older epoch's create whose blockhash died before it landed.
    const dead = store.insert({
      epoch: 1_049,
      threshold: 1_250,
      status: 'signed',
      createSignature: 'sigDead',
      signedTx: 'signed:tx2',
      lastValidBlockHeight: 900,
      quotedUsdcBase: 50_000_000,
      signedAt: new Date(NOW - 60_000),
    });
    // A quote that was never signed.
    const quoted = store.insert({ epoch: 1_048, threshold: 1_200, status: 'quoted', createId: 'cr_old' });

    const summary = await lifecycle.tick();
    expect(store.rows.find((row) => row.id === landed.id)).toMatchObject({
      status: 'registered',
      marketId: key(107),
      paidUsdcBase: 50_000_000,
    });
    expect(panta.calls.find((call) => call.name === 'registerMarket')?.body).toEqual({
      createId: 'cr_7',
      signature: 'sigLanded',
    });
    // Height 1,000 > 900: back to planned with an attempt; its epoch has started, so it is given up when re-timed.
    expect(store.rows.find((row) => row.id === dead.id)).toMatchObject({ attempts: 1, createSignature: null });
    expect(store.rows.find((row) => row.id === quoted.id)?.createId).toBeNull();
    expect(summary.recovered).toBeGreaterThanOrEqual(3);
    // Epoch 1051 already has its market: nothing new was quoted for it.
    expect(quotes(panta).map((q) => q.question)).not.toContain(marketQuestion(1_051, 1_300));
  });

  it('keeps a create whose outcome is unknown as signed and resolves it next tick', async () => {
    const { store, chain, lifecycle } = setup({ epochsAhead: 1 });
    chain.sendOutcomes = ['rpc-error'];
    await lifecycle.tick();
    const [row] = store.byEpoch(1_051);
    expect(row).toMatchObject({ status: 'signed', createSignature: 'sig1' });

    // It did land: the next tick confirms and registers it without a second quote.
    chain.states.set('sig1', 'confirmed');
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0].status).toBe('registered');
    expect(chain.signed).toHaveLength(1);
  });

  it('re-quotes after an expired or failed broadcast and gives up after three attempts', async () => {
    const { store, chain, lifecycle } = setup({ epochsAhead: 1 });
    chain.sendOutcomes = ['expired', 'failed', 'expired'];
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'planned', attempts: 1 });
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'planned', attempts: 2 });
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(chain.sent).toHaveLength(3);
  });

  it('registers from the catalog when the create session expired, or flags it for a person', async () => {
    const { store, panta, lifecycle } = setup({ epochsAhead: 1 });
    const expired = pantaApiError({
      endpoint: 'POST /markets/register/',
      status: 400,
      code: 'CREATE_EXPIRED',
      message: 'gone',
    });
    panta.registerErrors = [expired];
    panta.markets.set(key(101), pantaMarket({ marketId: key(101) }));
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'registered', marketId: key(101) });

    const second = setup({ epochsAhead: 1 });
    second.panta.registerErrors = [expired];
    const summary = await second.lifecycle.tick();
    expect(second.store.byEpoch(1_051)[0].status).toBe('unregistered');
    expect(summary.errors.join(' ')).toContain('ask Panta');
  });

  it('adopts an existing market of ours on DUPLICATE_MARKET', async () => {
    const { store, panta, lifecycle } = setup({ epochsAhead: 1 });
    panta.quoteErrors = [
      pantaApiError({ endpoint: 'POST /markets/create/quote/', status: 400, code: 'DUPLICATE_MARKET', message: 'dup' }),
    ];
    panta.mine = [pantaMarket({ marketId: key(150), title: marketTitle(1_051, 1_300) })];
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'registered', marketId: key(150) });
    expect(panta.count('buildCreate')).toBe(0);
  });

  it('refuses to sign when the spend guard objects, and never retries it', async () => {
    const { store, chain, panta, lifecycle } = setup({ epochsAhead: 1 });
    chain.guardError = new SpendGuardError('The create would take more USDC than quoted', { usdcSpentBase: 9e9 });
    const summary = await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'failed', createSignature: null });
    expect(chain.sent).toEqual([]);
    expect(summary.errors.join(' ')).toContain('spend guard');
    await lifecycle.tick();
    expect(panta.count('quoteCreate')).toBe(1);
  });

  it('stops for the tick on a rate limit without spending an attempt', async () => {
    const { store, panta, lifecycle } = setup({ epochsAhead: 2 });
    panta.quoteErrors = [
      pantaApiError({ endpoint: 'POST /markets/create/quote/', status: 429, code: 'RATE_LIMITED', message: 'slow' }),
    ];
    const summary = await lifecycle.tick();
    expect(panta.count('quoteCreate')).toBe(1);
    expect(store.rows.map((row) => [row.status, row.attempts])).toEqual([
      ['planned', 0],
      ['planned', 0],
    ]);
    expect(summary.errors.join(' ')).toContain('stopped');
  });

  it('gives up a planned market whose epoch is about to start', async () => {
    const { store, lifecycle, advance } = setup({ epochsAhead: 1, maxCreateUsdcBasePerDay: 1 });
    await lifecycle.tick(); // planned, but no budget
    advance(36 * 3_600_000);
    await lifecycle.tick();
    expect(store.byEpoch(1_051)[0]).toMatchObject({ status: 'failed' });
    expect(store.byEpoch(1_051)[0].error).toContain('too late');
  });

  it('claims creator fees of graduated markets, at most every check interval', async () => {
    const { store, chain, panta, lifecycle, advance } = setup({ epochsAhead: 1 });
    await lifecycle.tick();
    const [row] = store.byEpoch(1_051);
    panta.markets.set(row.marketId as string, pantaMarket({ marketId: row.marketId as string, phase: 'primary' }));
    advance(7 * 3_600_000);
    await lifecycle.tick();
    expect(panta.count('buildCreatorFeeClaim')).toBe(0); // still in its primary phase

    panta.markets.set(row.marketId as string, pantaMarket({ marketId: row.marketId as string, phase: 'secondary' }));
    advance(7 * 3_600_000);
    const summary = await lifecycle.tick();
    expect(summary.creatorFeesClaimedUsdc).toBe('2.50');
    expect(chain.instructions).toHaveLength(1);
    expect(store.byEpoch(1_051)[0]).toMatchObject({
      creatorFeesClaimedUsdcBase: 2_500_000,
      lastCreatorFeeSignature: 'claim1',
    });

    await lifecycle.tick();
    expect(panta.count('buildCreatorFeeClaim')).toBe(1); // checked recently

    panta.creatorFeeError = pantaApiError({
      endpoint: 'POST /claim/creator-fees/build/',
      status: 400,
      code: 'NO_CREATOR_FEES',
      message: 'none',
    });
    advance(7 * 3_600_000);
    const quiet = await lifecycle.tick();
    expect(quiet.errors).toEqual([]);
  });

  it('opens a ladder of thresholds when asked for more markets per epoch', async () => {
    const { store, history, lifecycle } = setup({
      marketsPerEpoch: 3,
      epochsAhead: 1,
      maxCreateUsdcBasePerDay: 500_000_000,
    });
    history.values = Array.from({ length: 16 }, (_, i) => ({ epoch: 1_049 - i, value: 1_000 + i * 20 }));
    await lifecycle.tick();
    expect(store.byEpoch(1_051).map((row) => [row.threshold, row.status])).toEqual([
      [1_100, 'registered'],
      [1_150, 'registered'],
      [1_250, 'registered'],
    ]);
  });
});
