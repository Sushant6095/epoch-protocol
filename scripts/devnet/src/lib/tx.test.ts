import {
  computeUnitLimit,
  isRetryableProgramError,
  isRetryableRpcError,
  MAX_COMPUTE_UNITS,
  TxError,
  withRpcRetry,
} from './tx';

describe('computeUnitLimit', () => {
  it('adds 15% and 1,000 units and caps at the transaction maximum', () => {
    expect(computeUnitLimit(0)).toBe(1_000);
    expect(computeUnitLimit(100_000)).toBe(116_000);
    expect(computeUnitLimit(1_300_000)).toBe(MAX_COMPUTE_UNITS);
  });
});

describe('isRetryableRpcError', () => {
  it('retries rate limits, gateway errors and dropped connections', () => {
    for (const m of [
      '429 Too Many Requests',
      'HTTP 503',
      'fetch failed',
      'read ECONNRESET',
      'Node is behind by 42 slots',
    ]) {
      expect(isRetryableRpcError(new Error(m))).toBe(true);
    }
    expect(isRetryableRpcError(Object.assign(new Error('fetch failed'), { cause: 'ETIMEDOUT' }))).toBe(true);
  });

  it('never retries program or signature errors', () => {
    for (const m of ['custom program error: 0x1771', 'Blockhash not found', 'missing required signature']) {
      expect(isRetryableRpcError(new Error(m))).toBe(false);
    }
  });
});

describe('withRpcRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries retryable errors with backoff, then succeeds', async () => {
    let calls = 0;
    const p = withRpcRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('429 Too Many Requests');
      return 'ok';
    });
    await jest.advanceTimersByTimeAsync(500 + 1_000);
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows a non-retryable error at once', async () => {
    let calls = 0;
    await expect(
      withRpcRetry(async () => {
        calls++;
        throw new Error('custom program error: 0x1');
      }),
    ).rejects.toThrow('0x1');
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    const p = withRpcRetry(async () => Promise.reject(new Error('503')), 2);
    const check = expect(p).rejects.toThrow('503');
    await jest.advanceTimersByTimeAsync(500);
    await check;
  });
});

describe('isRetryableProgramError', () => {
  it('retries only the named program errors of a failed transaction', () => {
    const rewards = new TxError('sweep v1', { code: 6037, name: 'RewardsInProgress', message: '' }, [], 'x');
    const other = new TxError('sweep v1', { code: 6036, name: 'AlreadySweptThisEpoch', message: '' }, [], 'x');
    expect(isRetryableProgramError(rewards, ['RewardsInProgress'])).toBe(true);
    expect(isRetryableProgramError(other, ['RewardsInProgress'])).toBe(false);
    expect(isRetryableProgramError(new TxError('x', undefined, [], 'blockhash not found'), ['RewardsInProgress'])).toBe(
      false,
    );
    expect(isRetryableProgramError(new Error('RewardsInProgress'), ['RewardsInProgress'])).toBe(false);
  });
});
