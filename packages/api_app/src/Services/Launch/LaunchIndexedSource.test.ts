import { type DammIndexedPool, type DammProtocolMetrics } from '@epoch/meteora';

import { LaunchIndexedSource } from './LaunchIndexedSource';

const POOL = 'BKH29Cr5mZf8eahp7vD28jaBqU9HavY9v6SAbphbSA2D';

describe('LaunchIndexedSource', () => {
  it('reads each pool and series at most once a minute, and the protocol totals every five', async () => {
    let clock = Date.parse('2026-10-05T19:00:00Z');
    const api = {
      pool: jest.fn(async () => ({ name: 'SPEC-SOL' }) as DammIndexedPool),
      ohlcv: jest.fn(async () => ({ timeframe: '1h' as const, startTime: 0, endTime: 0, points: [] })),
      volumeHistory: jest.fn(async () => ({ timeframe: '5m' as const, startTime: 0, endTime: 0, points: [] })),
      protocolMetrics: jest.fn(async () => ({ pools: 1 }) as DammProtocolMetrics),
    };
    const source = new LaunchIndexedSource(api, { ttlMs: 60_000, now: () => clock });
    expect((await source.pool(POOL)).loadedAtMs).toBe(clock);
    await source.pool(POOL);
    await source.candles(POOL, '1h');
    await source.candles(POOL, '1h');
    await source.candles(POOL, '4h');
    await source.volume(POOL, '5m');
    await source.protocolMetrics();
    expect(api.pool).toHaveBeenCalledTimes(1);
    expect(api.ohlcv.mock.calls).toEqual([
      [POOL, { timeframe: '1h' }],
      [POOL, { timeframe: '4h' }],
    ]);
    expect(api.volumeHistory).toHaveBeenCalledWith(POOL, { timeframe: '5m' });
    // A minute later: the pool is served stale while it refreshes; the protocol totals are still fresh.
    clock += 61_000;
    await source.pool(POOL);
    await source.protocolMetrics();
    await new Promise((resolve) => setImmediate(resolve));
    expect(api.pool).toHaveBeenCalledTimes(2);
    expect(api.protocolMetrics).toHaveBeenCalledTimes(1);
  });
});
