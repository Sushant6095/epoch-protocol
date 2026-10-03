import { key, pool } from '../__fixtures__/accounts';
import { FakeChain, programFailure, transientFailure } from '../__fixtures__/FakeChain';
import { AccrueJob } from './AccrueJob';

describe('AccrueJob', () => {
  it('accrues once per epoch, paying the protocol fee to the pool treasury', async () => {
    const chain = new FakeChain();
    chain.poolAccount = pool({ lastAccruedEpoch: 99n, treasury: key(2) });
    await expect(new AccrueJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.executed()).toEqual(['accrue']);
    // Accounts: cranker, pool, vault, treasury, system program.
    expect(chain.calls[0].instructions[0].keys[3]).toEqual({ pubkey: key(2), isSigner: false, isWritable: true });
  });

  it('does nothing when this epoch is already accrued or the pool does not exist', async () => {
    const chain = new FakeChain();
    chain.poolAccount = pool({ lastAccruedEpoch: 100n });
    await expect(new AccrueJob(chain).run(100n)).resolves.toBe('done');
    chain.poolAccount = null;
    await expect(new AccrueJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('retries transient failures only', async () => {
    const chain = new FakeChain();
    chain.poolAccount = pool({ lastAccruedEpoch: 99n });
    chain.onExecute = () => transientFailure();
    await expect(new AccrueJob(chain).run(100n)).resolves.toBe('retry');
    chain.onExecute = () => programFailure('AlreadyAccrued', 6015);
    await expect(new AccrueJob(chain).run(100n)).resolves.toBe('done');
    chain.onExecute = () => programFailure('VaultLedgerMismatch', 6016);
    await expect(new AccrueJob(chain).run(100n)).resolves.toBe('done');
  });
});
