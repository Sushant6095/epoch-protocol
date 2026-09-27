import { retry } from './retry';

describe('retry', () => {
  it('returns the first successful result', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { retries: 5, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws the last error after the final attempt', async () => {
    await expect(retry(async () => Promise.reject(new Error('down')), { retries: 2, baseDelayMs: 1 })).rejects.toThrow(
      'down',
    );
  });
});
