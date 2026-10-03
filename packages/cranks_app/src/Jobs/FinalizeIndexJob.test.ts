import { feeIndex } from '../__fixtures__/accounts';
import { FakeChain, programFailure, transientFailure } from '../__fixtures__/FakeChain';
import { FinalizeIndexJob } from './FinalizeIndexJob';

describe('FinalizeIndexJob', () => {
  const pending = feeIndex({
    epoch: 99n,
    value: 1_000n,
    finalizedSlot: 1n,
    hasProposal: true,
    proposedEpoch: 100n,
    proposedValue: 1_100n,
    proposedSlot: 5_000n,
    disputeWindowSlots: 9_000n,
  });

  it('does nothing without a FeeIndex or a pending proposal', async () => {
    const chain = new FakeChain();
    await expect(new FinalizeIndexJob(chain).run(100n)).resolves.toBe('done');
    chain.feeIndexAccount = feeIndex({ hasProposal: false });
    await expect(new FinalizeIndexJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('waits out the dispute window, then finalizes at proposed_slot + dispute_window_slots', async () => {
    const chain = new FakeChain();
    chain.feeIndexAccount = pending;
    chain.slot = 13_999n;
    await new FinalizeIndexJob(chain).run(100n);
    expect(chain.calls).toEqual([]);

    chain.slot = 14_000n;
    await expect(new FinalizeIndexJob(chain).run(100n)).resolves.toBe('done');
    expect(chain.executed()).toEqual(['finalize_index']);
    expect(chain.calls[0].label).toBe('finalize_index 100');
    // Accounts: cranker (signer), fee index (writable).
    const [cranker, index] = chain.calls[0].instructions[0].keys;
    expect(cranker).toMatchObject({ isSigner: true, isWritable: false });
    expect(index).toMatchObject({ isSigner: false, isWritable: true });
  });

  it('is harmless when someone else finalized first, and retries transient failures', async () => {
    const chain = new FakeChain();
    chain.feeIndexAccount = pending;
    chain.slot = 20_000n;
    chain.onExecute = () => programFailure('NoProposal', 6044);
    await expect(new FinalizeIndexJob(chain).run(100n)).resolves.toBe('done');
    chain.onExecute = () => transientFailure();
    await expect(new FinalizeIndexJob(chain).run(100n)).resolves.toBe('retry');
  });
});
