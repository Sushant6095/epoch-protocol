import { KeyedSnapshotCache } from './KeyedSnapshotCache';

describe('KeyedSnapshotCache', () => {
  it('loads each key once within the TTL and shares concurrent loads', async () => {
    let now = 0;
    const load = jest.fn(async (key: string) => `${key}@${now}`);
    const cache = new KeyedSnapshotCache('t', 10, 1_000, load, 5_000, () => now);
    const [a, b] = await Promise.all([cache.get('a'), cache.get('a')]);
    expect([a, b]).toEqual(['a@0', 'a@0']);
    now = 999;
    expect(await cache.get('a')).toBe('a@0');
    expect(load).toHaveBeenCalledTimes(1);
    now = 6_000;
    expect(await cache.get('a')).toBe('a@6000');
  });

  it('drops the least recently used key beyond its capacity', async () => {
    const load = jest.fn(async (key: string) => key);
    const cache = new KeyedSnapshotCache('t', 2, 60_000, load);
    await cache.get('a');
    await cache.get('b');
    await cache.get('a');
    await cache.get('c');
    expect(cache.size).toBe(2);
    await cache.get('a');
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get('b');
    expect(load).toHaveBeenCalledTimes(4);
  });
});
