import { TooManyRequestsException } from '@epoch/exceptions';

import { RateLimiter } from './RateLimiter';

describe('RateLimiter', () => {
  it('allows `limit` requests per window and key, then answers 429 with the wait', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) limiter.consume('a');
    limiter.consume('b');
    now += 20_000;
    let error: unknown;
    try {
      limiter.consume('a');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TooManyRequestsException);
    expect((error as TooManyRequestsException).statusCode).toBe(429);
    expect((error as TooManyRequestsException).details).toEqual({ retryAfterSeconds: 40 });
    now += 40_000;
    expect(() => limiter.consume('a')).not.toThrow();
  });

  it('never grows past maxKeys', () => {
    const limiter = new RateLimiter(1, 60_000, () => 0, 10);
    for (let i = 0; i < 25; i++) limiter.consume(`ip${i}`);
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(10);
  });
});
