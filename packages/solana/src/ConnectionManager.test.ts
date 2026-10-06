import { ChainException } from '@epoch/exceptions';

import { ConnectionManager } from './ConnectionManager';

describe('ConnectionManager.withFailover', () => {
  it('keeps the original error (and its program logs) as the cause when there is no fallback', async () => {
    const manager = new ConnectionManager('http://127.0.0.1:1');
    const original = Object.assign(new Error('Simulation failed'), {
      logs: ['Program log: AnchorError occurred. Error Code: Paused. Error Number: 6003.'],
    });
    const failure = await manager.withFailover(() => Promise.reject(original)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChainException);
    expect((failure as ChainException & { cause?: unknown }).cause).toBe(original);
    expect((failure as ChainException).details).toEqual({ cause: String(original) });
  });

  it('retries on the fallback and returns its result', async () => {
    const manager = new ConnectionManager('http://127.0.0.1:1', 'http://127.0.0.1:2');
    let calls = 0;
    const result = await manager.withFailover(async (connection) => {
      calls += 1;
      if (connection === manager.primary) throw new Error('primary down');
      return 'from fallback';
    });
    expect(result).toBe('from fallback');
    expect(calls).toBe(2);
  });
});
