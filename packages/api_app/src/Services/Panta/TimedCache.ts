/** A value and when it was read from its source (epoch ms); `stale` when served past the TTL because a refresh failed. */
export interface Timed<T> {
  value: T;
  at: number;
  stale: boolean;
}

/**
 * Per-key cache for Panta reads: fresh within `ttlMs`; past it, one shared reload (single flight). Only when the reload
 * FAILS is the old value served, flagged `stale`, and only until `maxStaleMs`. So data is never shown as live when it
 * is not (Panta Terms §5), and Panta sees at most one read per key per TTL. Least recently used keys beyond `capacity`
 * are dropped.
 */
export class TimedCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inflight = new Map<string, Promise<Timed<T>>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxStaleMs: number,
    private readonly capacity = 500,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<Timed<T>> {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.at < this.ttlMs) {
      this.touch(key, entry);
      return { value: entry.value, at: entry.at, stale: false };
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.reload(key, load).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Stores a value read elsewhere (a poller's fresh read), as of now. */
  put(key: string, value: T): void {
    this.touch(key, { value, at: this.now() });
  }

  /** The cached entry without loading (any age), or undefined. */
  peek(key: string): Timed<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { value: entry.value, at: entry.at, stale: this.now() - entry.at >= this.ttlMs };
  }

  private async reload(key: string, load: () => Promise<T>): Promise<Timed<T>> {
    try {
      const value = await load();
      const at = this.now();
      this.touch(key, { value, at });
      return { value, at, stale: false };
    } catch (error) {
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.at < this.maxStaleMs) return { value: entry.value, at: entry.at, stale: true };
      throw error;
    }
  }

  private touch(key: string, entry: { value: T; at: number }): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }
}
