import { isoIst, median, percentile, round, shortKey, superminority } from './Stats';

describe('Stats', () => {
  it('computes medians and percentiles', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.9)).toBe(0);
    expect(round(4.956, 2)).toBe(4.96);
  });

  it('finds the smallest set of the largest stakes holding more than a third', () => {
    expect(superminority([40, 30, 20, 10]).size).toBe(1);
    expect(superminority(Array(10).fill(10)).size).toBe(4);
    expect([...superminority([10, 50, 5])]).toEqual([1]);
    expect(superminority([]).size).toBe(0);
  });

  it('formats keys and times as the UI expects', () => {
    expect(shortKey('FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk')).toBe('FzUN…AmMk');
    expect(isoIst(new Date('2026-09-28T19:00:00Z'))).toBe('2026-09-29T00:30:00+05:30');
  });
});
