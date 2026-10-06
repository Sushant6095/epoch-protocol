import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DammDataApi,
  DataApiError,
  mapIndexedCandles,
  mapIndexedPool,
  mapIndexedVolume,
  mapProtocolMetrics,
} from './dataApi';

/** Real answers of damm-v2.datapi.meteora.ag (5 Oct 2026) for SPEC-SOL, a DBC-graduated pool (`launchpad: met-dbc`). */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__/datapi', `${name}.json`), 'utf8')) as unknown;
const POOL = 'BKH29Cr5mZf8eahp7vD28jaBqU9HavY9v6SAbphbSA2D';

describe('DAMM v2 data API answers', () => {
  it('maps a pool: TVL, price, windows, locked liquidity, fee config', () => {
    const pool = mapIndexedPool(fixture('pool'));
    expect(pool).toMatchObject({
      address: POOL,
      name: 'SPEC-SOL',
      tvlUsd: 61069.62328202417,
      price: 2.4588178128006006e-6,
      tokenX: { symbol: 'SPEC', decimals: 6, holders: 3836 },
      tokenY: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
      permanentLockLiquidityUsd: 61625.17376472151,
      baseFeePct: 1,
      collectFeeMode: 1,
      dynamicFee: true,
      launchpad: 'met-dbc',
      isBlacklisted: false,
      createdAt: 1791052359000,
      cumulative: { volumeUsd: 13330844.739233412, feesUsd: 123398.90979228917 },
    });
    expect(pool.volumeUsd['24h']).toBe(1100046.379128219);
    expect(pool.feesUsd['1h']).toBe(255.5631248043478);
  });

  it('maps candles and volume buckets, oldest first', () => {
    const candles = mapIndexedCandles(fixture('ohlcv-1h'));
    expect(candles).toMatchObject({ timeframe: '1h', startTime: 1791208800, endTime: 1791223200 });
    expect(candles.points).toHaveLength(5);
    expect(candles.points[0].time).toBe(1791208800);
    expect(candles.points.every((c) => c.low <= c.open && c.open <= c.high && c.low <= c.close)).toBe(true);
    const volume = mapIndexedVolume(fixture('volume-history-1h'));
    expect(volume.points.map((b) => b.time)).toEqual(candles.points.map((c) => c.time));
    // The closed buckets' volume agrees with the candles'; the open (newest) bucket reads 0 in the volume history
    // until it closes, while its candle already counts the hour so far.
    const closed = (points: { volumeUsd: number }[]) => points.slice(0, -1).map((p) => Math.round(p.volumeUsd));
    expect(closed(volume.points)).toEqual(closed(candles.points));
    expect(volume.points[4].volumeUsd).toBe(0);
    expect(candles.points[4].volumeUsd).toBeGreaterThan(0);
  });

  it('maps the protocol totals', () => {
    expect(mapProtocolMetrics(fixture('protocol-metrics'))).toEqual({
      tvlUsd: 62167135.931697,
      volume24hUsd: 52367557.00683892,
      fees24hUsd: 255333.74025722023,
      totalVolumeUsd: 11143311154.3832,
      totalFeesUsd: 139615513.80641326,
      pools: 1596468,
      refreshedAt: 1791229080,
    });
  });

  it('refuses an answer of another shape', () => {
    expect(() => mapIndexedPool({ address: POOL })).toThrow(DataApiError);
    expect(() => mapIndexedCandles({ data: 'x' })).toThrow('not a list');
  });
});

describe('DammDataApi', () => {
  const answer = (status: number, body: unknown) =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('asks the documented endpoints and maps their answers', async () => {
    const asked: string[] = [];
    const api = new DammDataApi({
      baseUrl: 'https://damm-v2.datapi.meteora.ag/',
      fetch: (url) => {
        asked.push(url);
        if (url.endsWith(`/pools/${POOL}`)) return answer(200, fixture('pool'));
        if (url.includes('/ohlcv')) return answer(200, fixture('ohlcv-1h'));
        if (url.includes('/volume/history')) return answer(200, fixture('volume-history-1h'));
        return answer(200, fixture('protocol-metrics'));
      },
    });
    expect((await api.pool(POOL))?.name).toBe('SPEC-SOL');
    expect(
      (await api.ohlcv(POOL, { timeframe: '1h', startTime: 1791208800, endTime: 1791223200 })).points,
    ).toHaveLength(5);
    expect((await api.volumeHistory(POOL, { timeframe: '1h' })).timeframe).toBe('1h');
    expect((await api.protocolMetrics()).pools).toBe(1596468);
    expect(asked).toEqual([
      `https://damm-v2.datapi.meteora.ag/pools/${POOL}`,
      `https://damm-v2.datapi.meteora.ag/pools/${POOL}/ohlcv?timeframe=1h&start_time=1791208800&end_time=1791223200`,
      `https://damm-v2.datapi.meteora.ag/pools/${POOL}/volume/history?timeframe=1h`,
      'https://damm-v2.datapi.meteora.ag/stats/protocol_metrics',
    ]);
  });

  it('has no pool for a 404 (not mainnet, or not indexed yet), and reports other failures with their status', async () => {
    const api = new DammDataApi({
      fetch: (url) =>
        url.includes('/ohlcv')
          ? answer(400, 'Failed to deserialize query string: timeframe: unknown variant `1m`')
          : url.includes('/stats')
            ? answer(429, { message: 'Too many requests' })
            : answer(404, fixture('pool-not-found')),
    });
    expect(await api.pool('11111111111111111111111111111111')).toBeNull();
    await expect(api.ohlcv(POOL, { timeframe: '5m' })).rejects.toMatchObject({ status: 400 });
    await expect(api.protocolMetrics()).rejects.toThrow('data API 429: Too many requests');
    expect(() => api.ohlcv(POOL, { timeframe: '1m' as '5m' })).rejects.toThrow('timeframe must be one of');
    const down = new DammDataApi({ fetch: () => Promise.reject(new Error('ECONNRESET')) });
    await expect(down.protocolMetrics()).rejects.toMatchObject({ status: 0 });
  });
});
