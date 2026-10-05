import { PANTA_RATE_LIMITS, RequestBudget } from './budget';
import { PantaBudgetError } from './errors';

describe('RequestBudget', () => {
  it('takes a share of each documented per-account limit', () => {
    const budget = new RequestBudget({ share: 0.8 });
    expect(budget.capacity).toEqual({ read: 96, positions: 48, quote: 24, build: 16, register: 32, upload: 8 });
    expect(new RequestBudget({ share: 0.01 }).capacity.upload).toBe(1);
    expect(PANTA_RATE_LIMITS.build).toEqual({ max: 20, windowMs: 60_000 });
    expect(() => new RequestBudget({ share: 0 })).toThrow(RangeError);
    expect(() => new RequestBudget({ share: 1.5 })).toThrow(RangeError);
  });

  it('never lets more than its capacity through in any 60 s window', () => {
    let now = 0;
    const budget = new RequestBudget({ share: 1, limits: { build: { max: 3, windowMs: 60_000 } }, now: () => now });
    expect([budget.tryTake('build'), budget.tryTake('build')]).toEqual([0, 0]);
    now = 10_000;
    expect(budget.tryTake('build')).toBe(0);
    // Full: the next slot frees when the first request (t = 0) leaves the window, 50 s from now.
    expect(budget.tryTake('build')).toBe(50_000);
    now = 60_001;
    expect(budget.tryTake('build')).toBe(0); // both t = 0 requests left the window
    expect(budget.tryTake('build')).toBe(0);
    expect(budget.tryTake('build')).toBe(9_999); // t = 10,000 is still in the window
    expect(budget.snapshot().build).toEqual({ used: 3, capacity: 3, waitMs: 9_999 });
    // Other families are independent.
    expect(budget.tryTake('read')).toBe(0);
  });

  it('stays blocked until the time Panta named', () => {
    let now = 1_000;
    const budget = new RequestBudget({ now: () => now });
    budget.block('quote', 31_000);
    budget.block('quote', 5_000); // an earlier time never shortens a block
    expect(budget.waitMs('quote')).toBe(30_000);
    now = 31_000;
    expect(budget.tryTake('quote')).toBe(0);
  });

  it('waits up to maxWaitMs for a slot, then fails without sending', async () => {
    let now = 0;
    const budget = new RequestBudget({ share: 1, limits: { register: { max: 1, windowMs: 60_000 } }, now: () => now });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    };
    await budget.take('register', 0, 'POST /trades/', sleep);
    await budget.take('register', 60_000, 'POST /trades/', sleep);
    expect(sleeps).toEqual([60_000]);
    let error: unknown;
    try {
      await budget.take('register', 1_000, 'POST /trades/', sleep);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PantaBudgetError);
    expect(error).toMatchObject({ family: 'register', retryAfterSeconds: 60, endpoint: 'POST /trades/' });
  });
});
