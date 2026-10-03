import { Logger } from '@epoch/logger';

import { feeIndex, finalizedIndex, key, swap } from '../__fixtures__/accounts';
import { atAddress, FakeChain, transientFailure } from '../__fixtures__/FakeChain';
import { finalizationsLeft, HISTORY_ALERT_REMAINING, SettleSwapsJob } from './SettleSwapsJob';

const range = (from: bigint, to: bigint): bigint[] => {
  const out: bigint[] = [];
  for (let e = from; e <= to; e++) out.push(e);
  return out;
};

describe('finalizationsLeft', () => {
  it('counts down from 16 as newer values are finalized, then the value is gone', () => {
    expect(finalizationsLeft(finalizedIndex([100n]), 100n)).toBe(16);
    expect(finalizationsLeft(finalizedIndex(range(100n, 101n)), 100n)).toBe(15);
    expect(finalizationsLeft(finalizedIndex(range(100n, 116n)), 100n)).toBe(0); // oldest of the 16 history entries
    expect(finalizationsLeft(finalizedIndex(range(100n, 117n)), 100n)).toBeNull(); // evicted
  });

  it('is null for an epoch that never had a final value', () => {
    expect(finalizationsLeft(finalizedIndex([98n, 100n]), 99n)).toBeNull();
    expect(finalizationsLeft(feeIndex(), 0n)).toBeNull();
  });
});

describe('SettleSwapsJob', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it('settles every open swap whose epoch is final, oldest first, paying the taker', async () => {
    const chain = new FakeChain();
    chain.feeIndexAccount = finalizedIndex([98n, 99n]);
    chain.swapAccounts = [
      atAddress(swap({ epoch: 99n, quote: key(61), taker: key(71) }), 131),
      atAddress(swap({ epoch: 100n, quote: key(62), taker: key(72) }), 132), // not final yet
      atAddress(swap({ epoch: 98n, quote: key(63), taker: key(73) }), 133),
    ];
    await expect(new SettleSwapsJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls.map((c) => c.label)).toEqual([
      `settle_swap ${key(133).toBase58()}`,
      `settle_swap ${key(131).toBase58()}`,
    ]);
    // Accounts: cranker, fee index, quote, taker, swap.
    const keys = chain.calls[1].instructions[0].keys;
    expect(keys[2].pubkey.equals(key(61))).toBe(true);
    expect(keys[3]).toEqual({ pubkey: key(71), isSigner: false, isWritable: true });
    expect(errors).not.toHaveBeenCalled();
  });

  it('alerts when a swap is close to leaving the history, and when it can never settle', async () => {
    const chain = new FakeChain();
    // Final values for 81..100 (current 100, history 84..99): 84 has 16 newer values, so the next finalize evicts
    // it; 81..83 are already gone; 97 has 3 newer values (13 left), no alert.
    chain.feeIndexAccount = finalizedIndex(range(81n, 100n));
    expect(finalizationsLeft(chain.feeIndexAccount, 84n)).toBe(0);
    expect(finalizationsLeft(chain.feeIndexAccount, 97n)).toBeGreaterThan(HISTORY_ALERT_REMAINING);
    chain.swapAccounts = [
      atAddress(swap({ epoch: 84n }), 141),
      atAddress(swap({ epoch: 82n }), 142),
      atAddress(swap({ epoch: 97n }), 143),
    ];
    chain.onExecute = () => transientFailure();
    const job = new SettleSwapsJob(chain);
    await expect(job.run(100n)).resolves.toBe('retry');
    const alerts = () => errors.mock.calls.map(([message]) => String(message)).filter((m) => m.startsWith('ALERT'));
    expect(alerts()).toEqual([
      expect.stringContaining('ALERT: swap can never settle'),
      expect.stringContaining('ALERT: swap is about to leave the 16-entry history'),
    ]);
    // The evicted swap is not attempted; the other two are.
    expect(chain.calls.map((c) => c.label)).toEqual([
      `settle_swap ${key(141).toBase58()}`,
      `settle_swap ${key(143).toBase58()}`,
    ]);

    // The same job does not repeat an alert on the next tick.
    errors.mockClear();
    await job.run(100n);
    expect(alerts()).toEqual([]);
  });

  it('does nothing before the FeeIndex exists', async () => {
    const chain = new FakeChain();
    chain.swapAccounts = [atAddress(swap(), 150)];
    await expect(new SettleSwapsJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });
});
