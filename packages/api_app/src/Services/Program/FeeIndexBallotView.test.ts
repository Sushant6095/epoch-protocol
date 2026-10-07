import { type FeeIndexAccount } from '@epoch/epoch-sdk';
import { PublicKey } from '@solana/web3.js';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { agreeingBpsOf, ballotFromEvents } from './FeeIndexBallotView';

const op = (n: number) => new PublicKey(new Uint8Array(32).fill(60 + n)).toBase58();
let ix = 0;
const event = (
  name: StoredProgramEvent['name'],
  slot: number,
  data: StoredProgramEvent['data'],
): StoredProgramEvent => ({
  signature: `sig${++ix}`,
  ix,
  slot,
  epoch: null,
  blockTime: null,
  name,
  data,
});
const opened = (slot: number, round = 0) =>
  event('IndexBallotOpened', slot, {
    epoch: '1043',
    round,
    operators: [1, 2, 3].map((n) => ({ key: op(n), weight: 1 })),
    totalWeight: '3',
    thresholdBps: 6_667,
    toleranceBps: 100,
    reset: false,
    slot: String(slot),
  });
const vote = (slot: number, n: number, value: number, round = 0, late = false) =>
  event('IndexVoteCast', slot, {
    epoch: '1043',
    round,
    operator: op(n),
    weight: 1,
    value: String(value),
    inputsHash: String(n).repeat(64),
    late,
    slot: String(slot),
  });
const reached = (slot: number, value: number, proposed: boolean) =>
  event('IndexConsensusReached', slot, { epoch: '1043', round: 0, value: String(value), proposed, slot: String(slot) });

describe('FeeIndexBallotView', () => {
  it('rounds the agreeing share up as the program does', () => {
    expect(agreeingBpsOf(2, 3)).toBe(6667);
    expect(agreeingBpsOf(3, 3)).toBe(10_000);
    expect(agreeingBpsOf(0, 0)).toBe(0);
  });

  it('rebuilds a closed ballot from its events, measuring every vote against the agreed value', () => {
    const events = [opened(10), vote(11, 1, 1_000), vote(12, 3, 1_500), vote(13, 2, 1_004), reached(13, 1_004, true)];
    const view = ballotFromEvents('ballot', 1043, events, null);
    expect(view).toMatchObject({
      programEpoch: 1043,
      round: 0,
      status: 'proposed',
      totalWeight: 3,
      agreeingWeight: 2,
      agreeingBps: 6667,
      votesCast: 3,
      medianValue: 1_004,
      consensus: true,
      consensusValue: 1_004,
      source: 'events',
    });
    expect(view?.votes.map((v) => [v.value, v.deviationBps, v.agrees])).toEqual([
      [1_000, 40, true],
      [1_004, 0, true],
      [1_500, 4_941, false], // the dissenter's deviation stays on the record
    ]);

    const closed = [...events, event('IndexBallotClosed', 40, { epoch: '1043', round: 0 })];
    expect(ballotFromEvents('ballot', 1043, closed, null)?.status).toBe('settled');
    const vetoed = [...events, event('IndexVetoed', 20, { epoch: '1043', value: '1004' })];
    expect(ballotFromEvents('ballot', 1043, vetoed, null)?.status).toBe('vetoed');
    const final = { epoch: 1043n } as FeeIndexAccount;
    expect(ballotFromEvents('ballot', 1043, events, final)?.status).toBe('settled');
  });

  it('takes the newest round only, and is null when no round was indexed', () => {
    const events = [opened(10), vote(11, 1, 1_000), opened(30, 1), vote(31, 2, 1_100, 1)];
    const view = ballotFromEvents('ballot', 1043, events, null);
    expect(view).toMatchObject({ round: 1, status: 'voting', votesCast: 1, medianValue: 1_100, consensus: false });
    expect(view?.votes.map((v) => v.voted)).toEqual([false, true, false]);
    expect(ballotFromEvents('ballot', 1044, events, null)).toBeNull();
  });
});
