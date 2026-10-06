import {
  type DammDataApi,
  type DammIndexedCandle,
  type DammIndexedPool,
  type DammIndexedVolume,
  type DammProtocolMetrics,
  type DataApiSeries,
  type DataApiTimeframe,
} from '@epoch/meteora';

import { SnapshotCache } from '../../Lib/SnapshotCache';

/** A cached read and when it was loaded (epoch ms). */
export interface IndexedRead<T> {
  value: T;
  loadedAtMs: number;
}

/**
 * Meteora's indexed view of graduated launch pools (the DAMM v2 data API, `@epoch/meteora` `DammDataApi`), cached so the
 * page stays well under the API's 10 requests a second: each pool, candle series and volume series is read at most once
 * per `ttlMs` (served stale while it refreshes), the protocol totals every five minutes.
 */
export class LaunchIndexedSource {
  private readonly pools = new Map<string, SnapshotCache<DammIndexedPool | null>>();
  private readonly candleSeries = new Map<string, SnapshotCache<DataApiSeries<DammIndexedCandle>>>();
  private readonly volumeSeries = new Map<string, SnapshotCache<DataApiSeries<DammIndexedVolume>>>();
  private readonly protocol: SnapshotCache<DammProtocolMetrics>;
  private readonly now: () => number;

  constructor(
    private readonly api: Pick<DammDataApi, 'pool' | 'ohlcv' | 'volumeHistory' | 'protocolMetrics'>,
    private readonly options: { ttlMs: number; now?: () => number },
  ) {
    this.now = options.now ?? Date.now;
    this.protocol = new SnapshotCache(
      'launch.indexed.protocol',
      Math.max(options.ttlMs, 300_000),
      () => this.api.protocolMetrics(),
      Math.max(options.ttlMs, 300_000) * 3,
      this.now,
    );
  }

  /** The pool's indexed state; `value` null when Meteora does not know the pool (not indexed yet). */
  pool(address: string): Promise<IndexedRead<DammIndexedPool | null>> {
    return this.read(this.pools, address, () => this.api.pool(address));
  }

  candles(address: string, timeframe: DataApiTimeframe): Promise<IndexedRead<DataApiSeries<DammIndexedCandle>>> {
    return this.read(this.candleSeries, `${address}:${timeframe}`, () => this.api.ohlcv(address, { timeframe }));
  }

  volume(address: string, timeframe: DataApiTimeframe): Promise<IndexedRead<DataApiSeries<DammIndexedVolume>>> {
    return this.read(this.volumeSeries, `${address}:${timeframe}`, () =>
      this.api.volumeHistory(address, { timeframe }),
    );
  }

  async protocolMetrics(): Promise<IndexedRead<DammProtocolMetrics>> {
    const value = await this.protocol.get();
    return { value, loadedAtMs: this.protocol.loadedAtMs };
  }

  private async read<T>(
    map: Map<string, SnapshotCache<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<IndexedRead<T>> {
    let cache = map.get(key);
    if (!cache) {
      cache = new SnapshotCache(`launch.indexed.${key}`, this.options.ttlMs, load, this.options.ttlMs * 3, this.now);
      map.set(key, cache);
    }
    const value = await cache.get();
    return { value, loadedAtMs: cache.loadedAtMs };
  }
}
