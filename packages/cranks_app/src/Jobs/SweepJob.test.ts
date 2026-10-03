import { advance, key, position, PROGRAM_ID } from '../__fixtures__/accounts';
import { atAddress, FakeChain, programFailure, transientFailure } from '../__fixtures__/FakeChain';
import { SweepJob } from './SweepJob';

describe('SweepJob', () => {
  let chain: FakeChain;
  beforeEach(() => {
    chain = new FakeChain();
    chain.positionAccounts = [
      atAddress(position({ vote: key(20), status: 'active', lastSweptEpoch: 99n }), 120),
      atAddress(position({ vote: key(21), status: 'late', lastSweptEpoch: 98n, openAdvance: key(80) }), 121),
      atAddress(position({ vote: key(22), status: 'defaulted', lastSweptEpoch: 99n, openAdvance: key(81) }), 122),
      atAddress(position({ vote: key(23), status: 'released', lastSweptEpoch: 50n }), 123),
      atAddress(position({ vote: key(24), status: 'active', lastSweptEpoch: 100n }), 124),
    ];
    chain.advances.set(key(80).toBase58(), advance());
  });

  it('waits while the cluster is still paying epoch rewards', async () => {
    chain.rewardsActive = true;
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('retry');
    expect(chain.calls).toEqual([]);
  });

  it('sweeps every unreleased position not swept this epoch, with its advance and payout', async () => {
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls.map((c) => c.label)).toEqual([
      `sweep ${key(20).toBase58()}`,
      `sweep ${key(21).toBase58()}`,
      `sweep ${key(22).toBase58()}`,
    ]);
    expect(chain.executed()).toEqual(['sweep', 'sweep', 'sweep']);
    const [noAdvance, withAdvance] = chain.calls.map((c) => c.instructions[0].keys);
    // Accounts: cranker, pool, vault, position, vote, vote_auth, escrow, payout, advance (Option), ...
    expect(noAdvance[0].pubkey.equals(chain.crank!)).toBe(true);
    expect(noAdvance[7].pubkey.equals(key(23))).toBe(true);
    expect(noAdvance[8]).toEqual({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false }); // None
    expect(withAdvance[8]).toEqual({ pubkey: key(80), isSigner: false, isWritable: true });
  });

  it('retries on a transient failure or RewardsInProgress, but not on a program rejection', async () => {
    chain.onExecute = (call) =>
      call.label.endsWith(key(21).toBase58()) ? transientFailure() : programFailure('IdentityMismatch', 6021);
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('retry');

    chain.onExecute = () => programFailure('RewardsInProgress', 6037);
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('retry');

    chain.onExecute = () => programFailure('IdentityMismatch', 6021);
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('done');
  });

  it('treats a position someone else already swept as done', async () => {
    chain.onExecute = () => programFailure('AlreadySweptThisEpoch', 6036);
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('done');
  });

  it('only simulates under DRY_RUN', async () => {
    chain.dryRun = true;
    await expect(new SweepJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls.every((c) => c.kind === 'simulate')).toBe(true);
    expect(chain.calls).toHaveLength(3);
  });
});
