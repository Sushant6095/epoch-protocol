import { SnapshotCache } from './SnapshotCache';

describe('SnapshotCache', () => {
  it('shares one load between concurrent callers and caches it for the TTL', async () => {
    let now = 0;
    let loads = 0;
    const cache = new SnapshotCache(
      't',
      1_000,
      async () => ++loads,
      10_000,
      () => now,
    );
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    now = 500;
    expect(await cache.get()).toBe(1);
    expect(loads).toBe(1);
  });

  it('serves a stale value while it refreshes, until maxStale', async () => {
    let now = 0;
    let loads = 0;
    const cache = new SnapshotCache(
      't',
      1_000,
      async () => ++loads,
      5_000,
      () => now,
    );
    await cache.get();
    now = 2_000;
    expect(await cache.get()).toBe(1); // stale, refresh started in the background
    await cache.refresh(); // joins the refresh already in flight
    expect(cache.peek()).toBe(2);
    expect(loads).toBe(2);
    now = 20_000;
    expect(await cache.get()).toBe(3); // too stale: waits for the load
  });

  it('keeps the last good value when a refresh fails', async () => {
    let now = 0;
    let fail = false;
    const cache = new SnapshotCache(
      't',
      1_000,
      async () => {
        if (fail) throw new Error('down');
        return 'ok';
      },
      5_000,
      () => now,
    );
    await cache.get();
    fail = true;
    now = 2_000;
    expect(await cache.get()).toBe('ok');
    await expect(cache.refresh()).rejects.toThrow('down');
    expect(cache.peek()).toBe('ok');
  });
});
