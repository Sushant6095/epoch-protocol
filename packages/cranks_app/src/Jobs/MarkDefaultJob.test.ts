import { advance, key, params, pool, position } from '../__fixtures__/accounts';
import { atAddress, FakeChain, programFailure } from '../__fixtures__/FakeChain';
import { MarkDefaultJob } from './MarkDefaultJob';

describe('MarkDefaultJob', () => {
  let chain: FakeChain;
  beforeEach(() => {
    chain = new FakeChain();
    chain.poolAccount = pool({ params: params({ maxAdvanceEpochs: 30 }) });
    chain.positionAccounts = [
      // three late epochs: defaultable
      atAddress(position({ vote: key(20), status: 'late', lateEpochs: 3, openAdvance: key(80) }), 120),
      // two late epochs, young advance: not yet
      atAddress(position({ vote: key(21), status: 'late', lateEpochs: 2, openAdvance: key(81) }), 121),
      // on time but the advance is older than max_advance_epochs: defaultable
      atAddress(position({ vote: key(22), status: 'active', lateEpochs: 0, openAdvance: key(82) }), 122),
      // already defaulted
      atAddress(position({ vote: key(23), status: 'defaulted', lateEpochs: 9, openAdvance: key(83) }), 123),
      // no advance
      atAddress(position({ vote: key(24), status: 'late', lateEpochs: 5 }), 124),
    ];
    chain.advances.set(key(80).toBase58(), advance({ openedEpoch: 95n }));
    chain.advances.set(key(81).toBase58(), advance({ openedEpoch: 95n }));
    chain.advances.set(key(82).toBase58(), advance({ openedEpoch: 70n }));
    chain.advances.set(key(83).toBase58(), advance({ openedEpoch: 60n, state: 'defaulted' }));
  });

  it('simulates, then sends, mark_default for exactly the advances the program would accept', async () => {
    await expect(new MarkDefaultJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls.map((c) => [c.kind, c.name, c.label])).toEqual([
      ['simulate', 'mark_default', `mark_default ${key(20).toBase58()}`],
      ['execute', 'mark_default', `mark_default ${key(20).toBase58()}`],
      ['simulate', 'mark_default', `mark_default ${key(22).toBase58()}`],
      ['execute', 'mark_default', `mark_default ${key(22).toBase58()}`],
    ]);
    // Accounts: cranker, pool, position, advance.
    expect(chain.calls[1].instructions[0].keys[3].pubkey.equals(key(80))).toBe(true);
  });

  it('defaults an advance exactly at opened_epoch + max_advance_epochs, not one epoch before', async () => {
    chain.positionAccounts = [chain.positionAccounts[2]]; // opened in 70, max 30 epochs
    await new MarkDefaultJob(chain).run(99n);
    expect(chain.calls).toEqual([]);
    await new MarkDefaultJob(chain).run(100n);
    expect(chain.calls.map((c) => c.kind)).toEqual(['simulate', 'execute']);
  });

  it('does not send when the simulation fails', async () => {
    chain.onSimulate = () => programFailure('NotDefaultable', 6038);
    await expect(new MarkDefaultJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.executed()).toEqual([]);
  });

  it('only simulates under DRY_RUN', async () => {
    chain.dryRun = true;
    await new MarkDefaultJob(chain).run(100n);
    expect(chain.calls.every((c) => c.kind === 'simulate')).toBe(true);
    expect(chain.calls).toHaveLength(2);
  });
});
