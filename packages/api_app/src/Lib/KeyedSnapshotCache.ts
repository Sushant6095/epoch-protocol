import { SnapshotCache } from './SnapshotCache';
import { shortKey } from './Stats';

/**
 * One SnapshotCache per key (a validator, a wallet) with the same TTL and stale window; beyond `capacity` keys the
 * least recently used one is dropped. Concurrent requests for one key share a single load.
 */
export class KeyedSnapshotCache<T> {
  private readonly caches = new Map<string, SnapshotCache<T>>();

  constructor(
    readonly name: string,
    private readonly capacity: number,
    private readonly ttlMs: number,
    private readonly load: (key: string) => Promise<T>,
    private readonly maxStaleMs = ttlMs * 10,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Promise<T> {
    let cache = this.caches.get(key);
    if (cache) {
      this.caches.delete(key);
    } else {
      // Keys are addresses: log them short.
      cache = new SnapshotCache(
        `${this.name}:${shortKey(key)}`,
        this.ttlMs,
        () => this.load(key),
        this.maxStaleMs,
        this.now,
      );
    }
    this.caches.set(key, cache);
    for (const oldest of this.caches.keys()) {
      if (this.caches.size <= this.capacity) break;
      this.caches.delete(oldest);
    }
    return cache.get();
  }

  get size(): number {
    return this.caches.size;
  }
}
