import { type WithdrawRequestAccount } from '@epoch/epoch-sdk';

import { key, params, pool, SOL, withdrawRequest } from '../__fixtures__/accounts';
import { type ChainCall, FakeChain, programFailure, sent, transientFailure } from '../__fixtures__/FakeChain';
import { headVerdict, ProcessWithdrawalsJob } from './ProcessWithdrawalsJob';

/** 1 SOL of shares at par (the first deposit mints 1,000 shares per lamport). */
const ONE_SOL_SHARES = SOL * 1_000n;

describe('headVerdict', () => {
  const base = pool({ cash: 10n * SOL, seniorAssets: 80n * SOL, juniorAssets: 20n * SOL });

  it('pays a request the vault has cash for', () => {
    expect(headVerdict(base, withdrawRequest({ shares: 5n * ONE_SOL_SHARES }))).toBe('pay');
  });

  it('waits when the cash is not there', () => {
    expect(headVerdict(base, withdrawRequest({ shares: 11n * ONE_SOL_SHARES }))).toBe('wait-for-cash');
  });

  it('skips a cancelled request whatever its size', () => {
    expect(headVerdict(base, withdrawRequest({ shares: 999n * ONE_SOL_SHARES, cancelled: true }))).toBe(
      'skip-cancelled',
    );
  });

  it('bounces a junior request that would breach the junior floor, even without cash', () => {
    // Junior 20 of 100 (20%); taking 12 leaves 8 of 88 = 9.09% < the 10% floor.
    const request = withdrawRequest({ tranche: 'junior', shares: 12n * ONE_SOL_SHARES });
    expect(headVerdict(base, request)).toBe('bounce');
    expect(headVerdict({ ...base, params: params({ minJuniorBps: 0 }) }, request)).toBe('wait-for-cash');
    // Taking 9 leaves 11 of 91 = 12.1%: paid.
    expect(headVerdict(base, withdrawRequest({ tranche: 'junior', shares: 9n * ONE_SOL_SHARES }))).toBe('pay');
  });
});

describe('ProcessWithdrawalsJob', () => {
  /** A queue of requests `seq = 0..n-1`; a sent process_withdrawal advances the head (and pays from cash). */
  function queue(requests: Partial<WithdrawRequestAccount>[], cash = 10n * SOL): FakeChain {
    const chain = new FakeChain();
    chain.poolAccount = pool({ cash, withdrawHead: 0n, withdrawTail: BigInt(requests.length) });
    requests.forEach((r, seq) => chain.requests.set(BigInt(seq), withdrawRequest({ seq: BigInt(seq), ...r })));
    chain.onExecute = (call: ChainCall) => {
      const account = chain.poolAccount!;
      chain.poolAccount = { ...account, withdrawHead: account.withdrawHead + 1n };
      return sent(call.label);
    };
    return chain;
  }

  it('works the queue in order until the head cannot be paid', async () => {
    const chain = queue([
      { cancelled: true },
      { shares: 2n * ONE_SOL_SHARES, owner: key(71) },
      { tranche: 'junior', shares: 12n * ONE_SOL_SHARES }, // bounced by the floor
      { shares: 50n * ONE_SOL_SHARES }, // needs 50 SOL, the vault has 10
      { shares: ONE_SOL_SHARES },
    ]);
    await expect(new ProcessWithdrawalsJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls.map((c) => c.label)).toEqual([
      'process_withdrawal #0',
      'process_withdrawal #1',
      'process_withdrawal #2',
    ]);
    // Accounts: cranker, pool, vault, owner, lender, request, system program.
    expect(chain.calls[1].instructions[0].keys[3].pubkey.equals(key(71))).toBe(true);
  });

  it('does nothing on an empty queue', async () => {
    const chain = queue([]);
    await expect(new ProcessWithdrawalsJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('stops on InsufficientLiquidity, re-reads after NotHeadOfQueue, retries transient failures', async () => {
    const chain = queue([{ shares: ONE_SOL_SHARES }]);
    chain.onExecute = () => programFailure('InsufficientLiquidity', 6010);
    await expect(new ProcessWithdrawalsJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls).toHaveLength(1);

    const raced = queue([{ shares: ONE_SOL_SHARES }]);
    raced.onExecute = () => {
      raced.poolAccount = { ...raced.poolAccount!, withdrawHead: 1n }; // processed by someone else
      return programFailure('NotHeadOfQueue', 6013);
    };
    await expect(new ProcessWithdrawalsJob(raced).run(100n)).resolves.toBe('done');
    expect(raced.calls).toHaveLength(1);

    const flaky = queue([{ shares: ONE_SOL_SHARES }]);
    flaky.onExecute = () => transientFailure();
    await expect(new ProcessWithdrawalsJob(flaky).run(100n)).resolves.toBe('retry');
  });

  it('stops after one simulation under DRY_RUN (the head does not move)', async () => {
    const chain = queue([{ shares: ONE_SOL_SHARES }, { shares: ONE_SOL_SHARES }]);
    chain.dryRun = true;
    await expect(new ProcessWithdrawalsJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls.map((c) => c.kind)).toEqual(['simulate']);
  });
});
