import { computeScore, findQuotePda } from '@epoch/epoch-sdk';
import { type VoteState } from '@epoch/solana';
import { type PublicKey, type VoteAccountInfo } from '@solana/web3.js';

import { key, params, pool, position, PROGRAM_ID, SOL, swap } from '../__fixtures__/accounts';
import { atAddress, FakeChain, transientFailure } from '../__fixtures__/FakeChain';
import { type ValidatorDataSource, type VoterSnapshot } from '../Chain/MainnetData';
import { stillFreshNextEpoch, UpdateScoreJob } from './UpdateScoreJob';

const MAKER = key(50);
const VOTE = key(20);

const voter = (votePubkey: string, activatedStake: number, earned: number, commission = 5): VoteAccountInfo => ({
  votePubkey,
  nodePubkey: 'node',
  activatedStake,
  epochVoteAccount: true,
  epochCredits: [[1_046, 1_000 + earned, 1_000]],
  commission,
  lastVote: 0,
});

class FakeData implements ValidatorDataSource {
  snapshot: VoterSnapshot = {
    epoch: 1_047,
    current: [voter(VOTE.toBase58(), 100, 400_000), voter('big', 10_000, 400_000)],
    delinquent: [],
  };
  mev = new Map<string, number | null>([[VOTE.toBase58(), 800]]);
  states = new Map<string, VoteState | null>();
  failing = false;
  async voters(): Promise<VoterSnapshot> {
    if (this.failing) throw new Error('RPC down');
    return this.snapshot;
  }
  async voteStates(votes: PublicKey[]): Promise<Map<string, VoteState | null>> {
    return new Map(votes.map((v) => [v.toBase58(), this.states.get(v.toBase58()) ?? null]));
  }
  async mevCommissions(): Promise<Map<string, number | null>> {
    return this.mev;
  }
}

/** Reads the ScoreUpdate back out of update_score's data: discriminator, 3 × u16, 3 × bool. */
function decodeUpdate(data: Buffer) {
  return {
    creditsRatioBps: data.readUInt16LE(8),
    commissionBps: data.readUInt16LE(10),
    epochsActive: data.readUInt16LE(12),
    delinquent: data[14] === 1,
    superminority: data[15] === 1,
    hedged: data[16] === 1,
  };
}

/** A validator averaging 10 SOL per epoch over 4 epochs. */
const earning = { revenue: [10n * SOL, 10n * SOL, 10n * SOL, 10n * SOL, 0n, 0n, 0n, 0n, 0n, 0n], revenueCount: 4 };

describe('UpdateScoreJob', () => {
  let chain: FakeChain;
  let data: FakeData;
  beforeEach(() => {
    chain = new FakeChain();
    chain.epoch = 100n;
    chain.poolAccount = pool({ scorer: key(91), params: params({ scoreTtlEpochs: 3 }) });
    chain.positionAccounts = [atAddress(position({ vote: VOTE, ...earning }), 120)];
    data = new FakeData();
  });

  it('posts the inputs from the data cluster, signed by the scorer', async () => {
    await expect(new UpdateScoreJob(chain, data, [MAKER]).run(100n)).resolves.toBe('done');
    expect(chain.executed()).toEqual(['update_score']);
    const call = chain.calls[0];
    expect(call.role).toBe('scorer');
    expect(decodeUpdate(call.instructions[0].data)).toEqual({
      creditsRatioBps: 10_000, // same credits as the cluster average
      commissionBps: 800, // MEV 8% beats inflation 5%
      epochsActive: 1, // no vote state: getVoteAccounts' history
      delinquent: false,
      superminority: false,
      hedged: false,
    });
    // Accounts: scorer (signer), pool, position.
    expect(call.instructions[0].keys[0]).toMatchObject({ pubkey: key(91), isSigner: true });
  });

  it('sets hedged when the operator holds the five-epoch hedge against the maker', async () => {
    chain.swapAccounts = [101n, 102n, 103n, 104n, 105n].map((epoch, i) =>
      atAddress(
        swap({ epoch, taker: key(22), notional: 5n * SOL, quote: findQuotePda(PROGRAM_ID, MAKER, epoch)[0] }),
        200 + i,
      ),
    );
    await new UpdateScoreJob(chain, data, [MAKER]).run(100n);
    expect(decodeUpdate(chain.calls[0].instructions[0].data).hedged).toBe(true);
  });

  it('skips a position whose score and hedged flag are unchanged while it stays fresh', async () => {
    const inputs = {
      creditsRatioBps: 10_000,
      commissionBps: 800,
      epochsActive: 1,
      delinquent: false,
      superminority: false,
    };
    const score = computeScore(inputs);
    chain.positionAccounts = [atAddress(position({ vote: VOTE, ...earning, score, lastScoredEpoch: 98n }), 120)];
    await new UpdateScoreJob(chain, data, [MAKER]).run(100n); // fresh through 101: 100 + 1 <= 98 + 3
    expect(chain.calls).toEqual([]);

    chain.positionAccounts = [atAddress(position({ vote: VOTE, ...earning, score, lastScoredEpoch: 97n }), 120)];
    await new UpdateScoreJob(chain, data, [MAKER]).run(100n); // would be stale at 101: refresh now
    expect(chain.executed()).toEqual(['update_score']);

    chain.calls.length = 0;
    chain.positionAccounts = [
      atAddress(position({ vote: VOTE, ...earning, score, lastScoredEpoch: 98n, hedged: true }), 120),
    ];
    await new UpdateScoreJob(chain, data, [MAKER]).run(100n); // hedged changes: post
    expect(chain.executed()).toEqual(['update_score']);
  });

  it('does nothing without a scorer key, or when the key is not the pool scorer', async () => {
    chain.scorer = undefined;
    await expect(new UpdateScoreJob(chain, data, [MAKER]).run(100n)).resolves.toBe('done');
    chain.scorer = key(99);
    await expect(new UpdateScoreJob(chain, data, [MAKER]).run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('skips released positions and vote accounts the data cluster does not know', async () => {
    chain.positionAccounts = [
      atAddress(position({ vote: key(30), status: 'released' }), 121),
      atAddress(position({ vote: key(31) }), 122),
    ];
    await expect(new UpdateScoreJob(chain, data, [MAKER]).run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
  });

  it('retries instead of guessing when the data source or the send fails', async () => {
    data.failing = true;
    await expect(new UpdateScoreJob(chain, data, [MAKER]).run(100n)).rejects.toThrow('RPC down');
    data.failing = false;
    chain.onExecute = () => transientFailure();
    await expect(new UpdateScoreJob(chain, data, [MAKER]).run(100n)).resolves.toBe('retry');
  });
});

describe('stillFreshNextEpoch', () => {
  it('mirrors request_advance: fresh while epoch <= last_scored_epoch + ttl', () => {
    expect(stillFreshNextEpoch(98n, 3, 100n)).toBe(true);
    expect(stillFreshNextEpoch(97n, 3, 100n)).toBe(false);
    expect(stillFreshNextEpoch(0n, 100, 5n)).toBe(false); // never scored
    expect(stillFreshNextEpoch(100n, 0, 100n)).toBe(false); // ttl 0: post every epoch
  });
});
