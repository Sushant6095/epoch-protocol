import { TooManyRequestsException } from '@epoch/exceptions';

/** Fixed-window request counter per key (an IP, a wallet), in this process's memory. */
export class RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Counts one request for `key`; 429 TOO_MANY_REQUESTS (with `retryAfterSeconds`) once over the limit. */
  consume(key: string, message = 'Too many requests, try again shortly'): void {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count++;
    if (window.count > this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1_000));
      throw new TooManyRequestsException(message, { retryAfterSeconds });
    }
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    // Still full (a flood of distinct keys): start over rather than grow without bound.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
