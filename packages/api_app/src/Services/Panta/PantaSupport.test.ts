import { Logger } from '@epoch/logger';
import { pantaApiError, PantaConfigError, PantaResponseError } from '@epoch/panta';

import { MemoryIndexReads } from '../../__fixtures__/PantaFakes';
import { toEpochException } from './PantaErrors';
import { PantaStreamPoller } from './PantaStreamPoller';
import { countryOf, IndexSnapshotSource, intelligenceFor, isGeoBlocked } from './PantaSupport';
import { TimedCache } from './TimedCache';

beforeAll(() => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe('geo', () => {
  const headers = ['cf-ipcountry', 'x-vercel-ip-country'];

  it('reads the first trusted header that names a country', () => {
    expect(countryOf({ 'cf-ipcountry': 'in' }, headers)).toBe('IN');
    expect(countryOf({ 'cf-ipcountry': 'XX', 'x-vercel-ip-country': 'DE' }, headers)).toBe('DE');
    expect(countryOf({ 'x-vercel-ip-country': ['US', 'GB'] }, headers)).toBe('US');
    expect(countryOf({ 'cf-ipcountry': 'T1' }, headers)).toBe('T1');
    expect(countryOf({ 'cf-ipcountry': 'Narnia' }, headers)).toBeNull();
    expect(countryOf({}, headers)).toBeNull();
  });

  it('blocks listed countries, and Tor once any blocklist is set', () => {
    expect(isGeoBlocked('US', ['US'])).toBe(true);
    expect(isGeoBlocked('IN', ['US'])).toBe(false);
    expect(isGeoBlocked('T1', ['US'])).toBe(true);
    expect(isGeoBlocked('T1', [])).toBe(false);
    expect(isGeoBlocked(null, ['US'])).toBe(false);
  });
});

describe('Fee Index intelligence (informational)', () => {
  const snapshot = {
    history: [1_400, 1_200, 1_350, 1_000].map((value, i) => ({ epoch: 100 - i, value })),
    last: { epoch: 100, value: 1_400, status: 'final' as const },
    running: null,
  };

  it('puts the market price next to the share of recent epochs above the threshold', () => {
    expect(intelligenceFor(snapshot, 1_300, 0.55, 30)).toMatchObject({
      label: 'informational',
      impliedProbability: 0.55,
      modelProbability: 0.5,
      gapPct: 5,
      model: { above: 2, sample: 4, lookbackEpochs: 30 },
      index: { unit: 'µL/CU', last: { epoch: 100, value: 1_400, status: 'final' } },
    });
    // Strictly above: a value equal to the threshold does not count.
    expect(intelligenceFor(snapshot, 1_350, null, 30)).toMatchObject({ modelProbability: 0.25, gapPct: null });
    expect(intelligenceFor(snapshot, 1_300, 0.55, 2).model).toMatchObject({ above: 1, sample: 2 });
    expect(intelligenceFor({ history: [], last: null, running: null }, 1, 1.5, 30)).toMatchObject({
      impliedProbability: null,
      modelProbability: null,
    });
    expect(intelligenceFor(snapshot, 1_300, 0.5, 30).note).toContain('not advice');
  });

  it('shows the running epoch only while it is newer than the last computed one', async () => {
    const reads = new MemoryIndexReads([{ epoch: 99, value: 1_200 }], { epoch: 100, value: 1_250, slots: 10 });
    const live = await new IndexSnapshotSource(reads, null, 30).get();
    expect(live).toMatchObject({ last: { epoch: 99, status: 'computed' }, running: { epoch: 100 } });
    const finals = { latestFinal: async () => ({ epoch: 99, value: 1_210 }) };
    reads.live = { epoch: 99, value: 1_250, slots: 10 };
    const settled = await new IndexSnapshotSource(reads, finals, 30).get();
    expect(settled).toMatchObject({ last: { epoch: 99, value: 1_210, status: 'final' }, running: null });
  });
});

describe('TimedCache', () => {
  it('serves fresh values, reloads once per key, and serves stale only when a reload fails', async () => {
    let now = 0;
    const cache = new TimedCache<number>(1_000, 10_000, 10, () => now);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
    expect([a.value, b.value, loads]).toEqual([1, 1, 1]);
    now = 500;
    expect(await cache.get('k', load)).toEqual({ value: 1, at: 0, stale: false });
    now = 1_500;
    expect(await cache.get('k', load)).toEqual({ value: 2, at: 1_500, stale: false });
    now = 3_000;
    const failing = async (): Promise<number> => {
      throw new Error('down');
    };
    expect(await cache.get('k', failing)).toEqual({ value: 2, at: 1_500, stale: true });
    now = 20_000;
    await expect(cache.get('k', failing)).rejects.toThrow('down');
    cache.put('k', 9);
    expect(cache.peek('k')).toEqual({ value: 9, at: 20_000, stale: false });
    expect(cache.peek('none')).toBeUndefined();
  });

  it('keeps at most `capacity` keys', async () => {
    const cache = new TimedCache<number>(1_000, 1_000, 2);
    for (const key of ['a', 'b', 'c']) await cache.get(key, async () => 1);
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('c')).toBeDefined();
  });
});

describe('PantaStreamPoller', () => {
  it('polls only while someone listens, pushes after a read, and backs off on failures', async () => {
    let listeners = 0;
    const pushes: string[] = [];
    let fail = false;
    const poller = new PantaStreamPoller({
      hub: { subscriberCount: () => listeners, refresh: (channel) => void pushes.push(channel) },
      refresh: async () => {
        if (fail) throw pantaApiError({ endpoint: 'GET', status: 429, code: 'RATE_LIMITED', message: 'slow' });
      },
      intervalMs: 15_000,
      maxIntervalMs: 50_000,
    });
    await poller.tick();
    expect(pushes).toEqual([]);
    listeners = 1;
    await poller.tick();
    expect(pushes).toEqual(['predict:panta']);
    fail = true;
    await poller.tick();
    await poller.tick();
    expect(poller.currentDelayMs).toBe(50_000);
    expect(pushes).toHaveLength(1);
    fail = false;
    await poller.tick();
    expect(poller.currentDelayMs).toBe(15_000);
    poller.start();
    poller.stop();
  });
});

describe('toEpochException', () => {
  it('keeps Panta’s words in details and never blames the user for our key', () => {
    const invalid = toEpochException(
      pantaApiError({
        endpoint: 'POST /primaryorderquote/',
        status: 400,
        code: 'INVALID_MARKET_PARAMS',
        message: 'amountUsdc: bad',
        field: 'amountUsdc',
      }),
    );
    expect(invalid).toMatchObject({
      statusCode: 400,
      code: 'PANTA_INVALID_PARAMS',
      details: { pantaCode: 'INVALID_MARKET_PARAMS', pantaMessage: 'amountUsdc: bad', field: 'amountUsdc' },
    });
    expect(toEpochException(new PantaConfigError('no key', 'x'))).toMatchObject({
      statusCode: 503,
      code: 'PANTA_NOT_CONFIGURED',
    });
    expect(toEpochException(new PantaResponseError('shape', 'x', ['a: b']))).toMatchObject({
      statusCode: 502,
      code: 'PANTA_BAD_RESPONSE',
    });
    expect(
      toEpochException(pantaApiError({ endpoint: 'x', status: 418, code: 'SOMETHING_NEW', message: 'teapot' })),
    ).toMatchObject({ statusCode: 418, code: 'PANTA_ERROR', details: { pantaCode: 'SOMETHING_NEW' } });
    expect(
      toEpochException(pantaApiError({ endpoint: 'x', status: 403, code: 'GEO_RESTRICTED', message: 'region' })),
    ).toMatchObject({ statusCode: 403, code: 'PANTA_FORBIDDEN' });
  });
});
