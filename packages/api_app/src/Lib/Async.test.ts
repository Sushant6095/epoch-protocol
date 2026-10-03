import { mapLimit } from './Async';

describe('mapLimit', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 1], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20', '3:5', '4:1']);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});
