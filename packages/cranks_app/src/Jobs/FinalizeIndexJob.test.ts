import { feeIndex, indexBallot } from '../__fixtures__/accounts';
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

  describe('operator consensus', () => {
    const free = feeIndex({ epoch: 99n, value: 1_000n, finalizedSlot: 1n });
    const queued = (epoch: bigint) => indexBallot(epoch, { consensusSlot: 7n, consensusValue: 1_004n });

    it('submits the lowest queued consensus once the FeeIndex is free', async () => {
      const chain = new FakeChain();
      chain.feeIndexAccount = free;
      chain.ballotAccounts = [queued(101n), indexBallot(99n), queued(100n)];
      await expect(new FinalizeIndexJob(chain).run(102n)).resolves.toBe('done');
      expect(chain.executed()).toEqual(['submit_index_ballot']);
      expect(chain.calls[0].label).toBe('submit_index_ballot 100');
    });

    it('does not submit while a proposal is pending, nor a ballot still voting, proposed or settled', async () => {
      const chain = new FakeChain();
      chain.feeIndexAccount = { ...pending, epoch: 99n };
      chain.slot = 5_001n;
      chain.ballotAccounts = [queued(101n)];
      await new FinalizeIndexJob(chain).run(102n);
      chain.feeIndexAccount = free;
      chain.ballotAccounts = [
        indexBallot(100n, { votesCast: 1, agreeingWeight: 1n }),
        indexBallot(98n, { consensusSlot: 3n, proposedSlot: 3n }),
        indexBallot(101n, { consensusSlot: 7n, proposedSlot: 9n }), // vetoed: its next vote reopens it
      ];
      await new FinalizeIndexJob(chain).run(102n);
      expect(chain.calls).toEqual([]);
    });

    it('treats a race as benign and retries transient failures', async () => {
      const chain = new FakeChain();
      chain.feeIndexAccount = free;
      chain.ballotAccounts = [queued(100n)];
      chain.onExecute = () => programFailure('DisputeWindowOpen', 6045);
      await expect(new FinalizeIndexJob(chain).run(102n)).resolves.toBe('done');
      chain.onExecute = () => transientFailure();
      await expect(new FinalizeIndexJob(chain).run(102n)).resolves.toBe('retry');
    });
  });
});
