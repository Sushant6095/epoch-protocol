import {
  findTipDistributionPda,
  type HistoryEntry,
  HISTORY_SOURCES,
  instructionNameOf,
  type ValidatorHistoryAccount,
} from '@epoch/epoch-sdk';
import { type PublicKey } from '@solana/web3.js';

import { key, position } from '../__fixtures__/accounts';
import { atAddress, FakeChain, transientFailure } from '../__fixtures__/FakeChain';
import { HistoryJob, MAX_JITO_ATTEMPTS } from './HistoryJob';

const EPOCH = 100n;

function entry(epoch: bigint, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    epoch,
    epochCredits: null,
    maxCredits: null,
    voteLamports: null,
    revenueLamports: null,
    mevEarnedLamports: null,
    priorityFeesLamports: null,
    activatedStakeLamports: null,
    lastVotedSlot: null,
    updatedSlot: null,
    rank: null,
    inflationCommissionBps: null,
    blockCommissionBps: null,
    mevCommissionBps: null,
    priorityFeeCommissionBps: null,
    superminority: null,
    sources: 0,
    ...overrides,
  };
}

function history(vote: PublicKey, entries: HistoryEntry[] = []): ValidatorHistoryAccount {
  return {
    vote,
    createdEpoch: 90n,
    lastVoteCopySlot: 0n,
    refreshedEpoch: 0n,
    refreshedSlot: 0n,
    hedgeRequiredNotional: 0n,
    epochsVoted: 0,
    score: 0,
    creditsRatioBps: 0,
    creditsRatioRawBps: 0,
    commissionBps: 0,
    epochsActive: 0,
    bump: 255,
    version: 1,
    scoreFlags: 0,
    entries,
  };
}

const names = (chain: FakeChain) =>
  chain.calls.map((c) => c.instructions.map((ix) => instructionNameOf(ix.data)).filter((n) => n !== null));

describe('HistoryJob', () => {
  const vote = key(20);
  const operator = key(30);
  const maker = key(40);
  let chain: FakeChain;

  beforeEach(() => {
    chain = new FakeChain();
    chain.positionAccounts = [atAddress(position({ vote, operator, status: 'active' }), 120)];
    chain.scoreConfigAccount = {
      pool: key(10),
      marketMaker: maker,
      creditsWindowEpochs: 10,
      countBlockCommission: false,
      creditsReferenceBps: 9_950,
      maxCopyAgeSlots: 9_000,
      bump: 254,
    };
    chain.stakes = [
      { vote: vote.toBase58(), activatedStake: 500n },
      { vote: key(21).toBase58(), activatedStake: 2_000n },
    ];
  });

  it('waits while the cluster is still paying epoch rewards', async () => {
    chain.rewardsActive = true;
    await expect(new HistoryJob(chain).run(EPOCH)).resolves.toBe('retry');
    expect(chain.calls).toEqual([]);
  });

  it('creates a missing history, copies the vote account, posts stake info, then copies and refreshes in one tx', async () => {
    chain.onExecute = (call) => {
      if (call.name === 'init_validator_history') chain.histories.set(vote.toBase58(), history(vote));
      return { status: 'sent', signature: 'sig' };
    };
    await expect(new HistoryJob(chain).run(EPOCH)).resolves.toBe('done');
    expect(names(chain)).toEqual([
      ['init_validator_history'],
      ['copy_vote_account'],
      ['update_stake_info'],
      ['copy_vote_account', 'refresh_score'],
    ]);
    const stake = chain.calls[2];
    expect(stake.role).toBe('scorer');
    // epoch, stake 500, rank 2 (key 21 holds more), superminority: 2,000 of 2,500 is the third alone.
    const data = Buffer.from(stake.instructions[0].data);
    expect(data.readBigUInt64LE(8)).toBe(EPOCH);
    expect(data.readBigUInt64LE(16)).toBe(500n);
    expect(data.readUInt32LE(24)).toBe(2);
    expect(data[28]).toBe(0);
    // refresh_score carries the five program-derived hedge swap PDAs after its five accounts.
    expect(chain.calls[3].instructions[1].keys).toHaveLength(5 + 5);
  });

  it('skips work already done this epoch and refreshes only', async () => {
    chain.histories.set(
      vote.toBase58(),
      history(vote, [entry(EPOCH, { sources: HISTORY_SOURCES.vote | HISTORY_SOURCES.stake, superminority: false })]),
    );
    await expect(new HistoryJob(chain).run(EPOCH)).resolves.toBe('done');
    expect(names(chain)).toEqual([['copy_vote_account', 'refresh_score']]);
  });

  it('copies Jito accounts only when they exist and the history lacks them, a bounded number of times', async () => {
    chain.histories.set(
      vote.toBase58(),
      history(vote, [entry(EPOCH, { sources: HISTORY_SOURCES.vote, superminority: true })]),
    );
    chain.balances.set(findTipDistributionPda(vote, EPOCH - 1n)[0].toBase58(), 2_000_000n);
    const job = new HistoryJob(chain);
    for (let i = 0; i < MAX_JITO_ATTEMPTS + 2; i++) await job.run(EPOCH);
    const tipCopies = names(chain).filter((n) => n[0] === 'copy_tip_distribution_account');
    expect(tipCopies).toHaveLength(MAX_JITO_ATTEMPTS);
    // The current epoch's tip account and the priority-fee account do not exist: never sent.
    expect(names(chain).some((n) => n[0] === 'copy_priority_fee_distribution')).toBe(false);
  });

  it('leaves positions alone until configure_scoring has run, but keeps the watch-list', async () => {
    chain.scoreConfigAccount = null;
    const watched = key(50);
    chain.histories.set(watched.toBase58(), history(watched));
    await expect(new HistoryJob(chain, { watchlist: [watched] }).run(EPOCH)).resolves.toBe('done');
    expect(names(chain)).toEqual([['copy_vote_account']]);
    expect(chain.calls[0].instructions[0].keys[2].pubkey.equals(watched)).toBe(true);
  });

  it('does not post stake info or refresh without the scorer key', async () => {
    chain.scorer = undefined;
    chain.histories.set(vote.toBase58(), history(vote, [entry(EPOCH, { sources: HISTORY_SOURCES.vote })]));
    await expect(new HistoryJob(chain).run(EPOCH)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('retries on a transient failure', async () => {
    chain.histories.set(vote.toBase58(), history(vote));
    chain.onExecute = () => transientFailure();
    await expect(new HistoryJob(chain).run(EPOCH)).resolves.toBe('retry');
  });
});
