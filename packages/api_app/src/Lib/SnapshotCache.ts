import { Logger } from '@epoch/logger';

const logger = Logger.create('SnapshotCache');

/**
 * One cached value with a time-to-live. Concurrent callers share one load (single flight). A stale value
 * is served while it refreshes in the background, up to `maxStaleMs`; after that callers wait for the
 * refresh and see its error if it fails.
 */
export class SnapshotCache<T> {
  private value?: T;
  private loadedAt = 0;
  private inflight?: Promise<T>;

  constructor(
    readonly name: string,
    private readonly ttlMs: number,
    private readonly load: () => Promise<T>,
    private readonly maxStaleMs = ttlMs * 10,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<T> {
    const age = this.now() - this.loadedAt;
    if (this.value !== undefined && age < this.ttlMs) return this.value;
    if (this.value !== undefined && age < this.maxStaleMs) {
      this.refresh().catch(() => undefined);
      return this.value;
    }
    return this.refresh();
  }

  /** The last loaded value, or undefined; never triggers a load. */
  peek(): T | undefined {
    return this.value;
  }

  /** When the current value was loaded (epoch ms), or 0. */
  get loadedAtMs(): number {
    return this.loadedAt;
  }

  set(value: T): void {
    this.value = value;
    this.loadedAt = this.now();
  }

  refresh(): Promise<T> {
    if (!this.inflight) {
      this.inflight = this.load()
        .then((value) => {
          this.set(value);
          return value;
        })
        .catch((error: unknown) => {
          logger.warn('refresh failed', { cache: this.name, error: String(error) });
          throw error;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }
}
