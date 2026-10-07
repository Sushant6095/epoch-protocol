import { feeIndex, indexBallot, key } from '../__fixtures__/accounts';
import { FakeChain, programFailure, transientFailure } from '../__fixtures__/FakeChain';
import { CloseBallotsJob } from './CloseBallotsJob';

describe('CloseBallotsJob', () => {
  const final = feeIndex({ epoch: 110n, value: 1_000n, finalizedSlot: 1n });

  it('closes settled ballots at least the retention behind the last final epoch, refunding each payer', async () => {
    const chain = new FakeChain();
    chain.feeIndexAccount = final;
    chain.ballotAccounts = [
      indexBallot(107n, { payer: key(61) }), // inside the retention (110 - 4 = 106)
      indexBallot(106n, { payer: key(62), consensusSlot: 5n, proposedSlot: 5n }),
      indexBallot(100n, { payer: key(60) }), // skipped over: settled without consensus
      indexBallot(111n), // still voting
    ];
    await expect(new CloseBallotsJob(chain, 4).run(111n)).resolves.toBe('done');
    expect(chain.calls.map((c) => c.label)).toEqual(['close_index_ballot 100', 'close_index_ballot 106']);
    // Accounts: cranker, fee index, ballot (writable), payer (writable, gets the rent).
    const keys = chain.calls[1].instructions[0].keys;
    expect(keys[3]).toMatchObject({ pubkey: key(62), isWritable: true, isSigner: false });
  });

  it('does nothing without a FeeIndex or with nothing old enough', async () => {
    const chain = new FakeChain();
    await expect(new CloseBallotsJob(chain).run(111n)).resolves.toBe('done');
    chain.feeIndexAccount = final;
    chain.ballotAccounts = [indexBallot(108n)];
    await expect(new CloseBallotsJob(chain).run(111n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('keeps going past a failure and asks for a retry only when one was transient', async () => {
    const chain = new FakeChain();
    chain.feeIndexAccount = final;
    chain.ballotAccounts = [indexBallot(100n), indexBallot(101n)];
    chain.onExecute = (call) =>
      call.label.endsWith('100') ? programFailure('BallotNotClosable', 6105) : transientFailure();
    await expect(new CloseBallotsJob(chain).run(111n)).resolves.toBe('retry');
    expect(chain.calls).toHaveLength(2);
  });
});
