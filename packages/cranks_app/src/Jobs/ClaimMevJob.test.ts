import { PublicKey } from '@solana/web3.js';

import { position } from '../__fixtures__/accounts';
import { atAddress, FakeChain } from '../__fixtures__/FakeChain';
import fixture from '../__fixtures__/jito-claims.json';
import { ClaimMevJob } from './ClaimMevJob';

// Real mainnet accounts (read 7 Oct 2026): epoch 1050 TDAs at 0 bps (3N7s9z…), 700 bps (CcaHc2…) and 10,000 bps
// (DdCNGD…) with their roots uploaded, the two commission-node ClaimStatus accounts, and 3N7s9z…'s epoch 1051 TDA
// before its root. The program epoch is 1051, so the job checks the MEV of epoch 1050.
const { accounts } = fixture;
const V0 = accounts.tdaWithRoot.vote;
const V700 = accounts.tda700.vote;
const V10000 = accounts.tda10000.vote;
const MINUTE = 60_000;

const put = (chain: FakeChain, entry: { address: string; data: string }) =>
  chain.accountData.set(entry.address, Buffer.from(entry.data, 'base64'));

function setup(votes: string[], options: { claims?: boolean } = {}) {
  const chain = new FakeChain();
  chain.epoch = 1051n;
  chain.positionAccounts = votes.map((vote, i) =>
    atAddress(position({ vote: new PublicKey(vote), status: 'active', lastSweptEpoch: 1050n }), 120 + i),
  );
  for (const tda of [accounts.tdaWithRoot, accounts.tda700, accounts.tda10000, accounts.tdaWithoutRoot]) {
    put(chain, tda);
  }
  if (options.claims !== false) {
    put(chain, accounts.claimStatus700);
    put(chain, accounts.claimStatus10000);
  }
  let now = 0;
  const clock = { advance: (ms: number) => (now += ms) };
  const job = new ClaimMevJob(chain, { waitMinutes: 360, now: () => now });
  return { chain, job, clock };
}

describe('ClaimMevJob', () => {
  it('is done once every commission node is claimed: one read for the TDAs, one for their ClaimStatus', async () => {
    const { chain, job } = setup([V0, V700, V10000]);
    await expect(job.run(1051n)).resolves.toBe('done');
    // 3 TDAs; the 0-bps validator's node is never claimed, so only 2 ClaimStatus PDAs are read.
    expect(chain.accountReads).toEqual([3, 2]);
    expect(chain.calls).toEqual([]); // a check, never a transaction
  });

  it('holds the sweep while a commission is not claimed, at most MEV_CLAIM_WAIT_MINUTES, then lets it run', async () => {
    const { chain, job, clock } = setup([V700, V10000], { claims: false });
    await expect(job.run(1051n)).resolves.toBe('retry');
    clock.advance(359 * MINUTE);
    await expect(job.run(1051n)).resolves.toBe('retry');
    // Jito claims the 700-bps node; the 10,000-bps one is still missing.
    put(chain, accounts.claimStatus700);
    await expect(job.run(1051n)).resolves.toBe('retry');
    clock.advance(MINUTE);
    await expect(job.run(1051n)).resolves.toBe('done'); // waited 6 hours: the rest is swept next epoch
    // A new epoch starts a new wait.
    await expect(job.run(1052n)).resolves.toBe('done'); // no epoch 1051 TDAs with commission: nothing to wait for
  });

  it('waits for the merkle root when the commission is above 0 (a 1051 TDA given 700 bps for the test)', async () => {
    const { chain, job } = setup([V0]);
    // epoch_created_at, commission and expires_at follow the tag at 72 when the root is absent: commission at 81.
    const noRoot = Buffer.from(accounts.tdaWithoutRoot.data, 'base64');
    expect(noRoot[72]).toBe(0);
    noRoot.writeUInt16LE(700, 81);
    chain.accountData.set(accounts.tdaWithoutRoot.address, noRoot);
    await expect(job.run(1052n)).resolves.toBe('retry');
    expect(chain.accountReads).toEqual([1]); // no ClaimStatus read before the root
  });

  it('is done at once without TDAs (devnet, or validators not running Jito), at 0 %, and after the sweep', async () => {
    const devnet = setup([V700]);
    devnet.chain.accountData.clear();
    await expect(devnet.job.run(1051n)).resolves.toBe('done');

    const zero = setup([V0], { claims: false });
    await expect(zero.job.run(1051n)).resolves.toBe('done');
    await expect(zero.job.run(1052n)).resolves.toBe('done'); // 1051 TDA: no root, but 0 bps

    const swept = setup([V700], { claims: false });
    swept.chain.positionAccounts[0].account.lastSweptEpoch = 1051n;
    await expect(swept.job.run(1051n)).resolves.toBe('done');
    expect(swept.chain.accountReads).toEqual([]);

    const released = setup([V700], { claims: false });
    released.chain.positionAccounts[0].account.status = 'released';
    await expect(released.job.run(1051n)).resolves.toBe('done');
  });
});
