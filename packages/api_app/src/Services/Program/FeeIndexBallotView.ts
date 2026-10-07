import {
  agreesWithin,
  ballotVotes,
  deviationBps,
  type EventName,
  type FeeIndexAccount,
  type IndexBallotAccount,
  indexBallotStatus,
  weightedMedian,
} from '@epoch/epoch-sdk';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type FeeIndexBallotView, type FeeIndexBallotVote } from '../../types/Activity.types';

/** Events a closed ballot is rebuilt from (IndexVetoed tells a vetoed round from a proposed one). */
export const BALLOT_EVENT_NAMES: readonly EventName[] = [
  'IndexBallotOpened',
  'IndexVoteCast',
  'IndexConsensusReached',
  'IndexBallotSubmitted',
  'IndexBallotClosed',
  'IndexVetoed',
];

/** Agreeing weight as bps of the total, rounded up: the share the program compares with the threshold. */
export function agreeingBpsOf(agreeing: number, total: number): number {
  return total > 0 ? Math.ceil((agreeing * 10_000) / total) : 0;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The live IndexBallot account; `index` (the FeeIndex) decides its status as the program does. */
export function ballotFromAccount(
  address: string,
  ballot: IndexBallotAccount,
  index: FeeIndexAccount | null,
): FeeIndexBallotView {
  const consensus = ballot.consensusSlot > 0n;
  const votes: FeeIndexBallotVote[] = ballotVotes(ballot).map((v) => ({
    operator: v.operator.toBase58(),
    weight: v.weight,
    voted: v.voted,
    value: v.voted ? Number(v.value) : null,
    inputsHash: v.voted ? hex(v.inputsHash) : null,
    deviationBps: v.voted ? v.deviationBps : null,
    agrees: v.voted ? v.agrees : null,
    late: v.late,
    slot: v.voted ? Number(v.slot) : null,
  }));
  const status = index
    ? indexBallotStatus(ballot, index)
    : !consensus
      ? 'voting'
      : ballot.proposedSlot > 0n
        ? 'proposed'
        : 'queued';
  const totalWeight = Number(ballot.totalWeight);
  const agreeingWeight = Number(ballot.agreeingWeight);
  return {
    address,
    programEpoch: Number(ballot.epoch),
    round: ballot.round,
    status,
    thresholdBps: ballot.thresholdBps,
    toleranceBps: ballot.toleranceBps,
    totalWeight,
    agreeingWeight,
    agreeingBps: agreeingBpsOf(agreeingWeight, totalWeight),
    votesCast: ballot.votesCast,
    operatorCount: ballot.operatorCount,
    medianValue: ballot.votesCast > 0 ? Number(ballot.medianValue) : null,
    consensus,
    consensusValue: consensus ? Number(ballot.consensusValue) : null,
    consensusSlot: consensus ? Number(ballot.consensusSlot) : null,
    votes,
    source: 'account',
  };
}

const big = (value: unknown): bigint => BigInt(String(value));

/**
 * A ballot whose account is closed, rebuilt from its newest round's events: the operator snapshot of
 * IndexBallotOpened, each operator's last IndexVoteCast, and IndexConsensusReached. Deviations and agreement are
 * recomputed against the agreed value (or the median of the counted votes before consensus), as the program does.
 * Null when no IndexBallotOpened was indexed for the epoch.
 */
export function ballotFromEvents(
  address: string,
  programEpoch: number,
  events: StoredProgramEvent[],
  index: FeeIndexAccount | null,
): FeeIndexBallotView | null {
  const ofEpoch = events
    .filter((e) => Number(e.data.epoch) === programEpoch)
    .sort((a, b) => a.slot - b.slot || a.ix - b.ix); // oldest first
  const opened = [...ofEpoch].reverse().find((e) => e.name === 'IndexBallotOpened');
  if (!opened) return null;
  const round = Number(opened.data.round);
  const after = (e: StoredProgramEvent) => e.slot > opened.slot || (e.slot === opened.slot && e.ix >= opened.ix);
  const inRound = ofEpoch.filter((e) => after(e) && (e.data.round === undefined || Number(e.data.round) === round));

  const operators = Array.isArray(opened.data.operators)
    ? opened.data.operators.map((o) => ({ key: String(o.key), weight: Number(o.weight) }))
    : [];
  const cast = new Map<string, StoredProgramEvent>();
  for (const e of inRound) if (e.name === 'IndexVoteCast') cast.set(String(e.data.operator), e);
  const reached = inRound.find((e) => e.name === 'IndexConsensusReached');
  const toleranceBps = Number(opened.data.toleranceBps);

  const counted = [...cast.values()].filter((e) => e.data.late !== true);
  const center = reached
    ? big(reached.data.value)
    : weightedMedian(counted.map((e) => ({ value: big(e.data.value), weight: big(e.data.weight) })));
  let agreeingWeight = 0;
  const votes: FeeIndexBallotVote[] = operators.map(({ key, weight }) => {
    const e = cast.get(key);
    if (!e) {
      return {
        operator: key,
        weight,
        voted: false,
        value: null,
        inputsHash: null,
        deviationBps: null,
        agrees: null,
        late: false,
        slot: null,
      };
    }
    const value = big(e.data.value);
    const agrees = center !== null && agreesWithin(value, center, toleranceBps);
    if (agrees) agreeingWeight += weight;
    return {
      operator: key,
      weight,
      voted: true,
      value: Number(value),
      inputsHash: String(e.data.inputsHash),
      deviationBps: center === null ? null : deviationBps(value, center),
      agrees,
      late: e.data.late === true,
      slot: Number(e.data.slot ?? e.slot),
    };
  });

  const closed = ofEpoch.some((e) => e.name === 'IndexBallotClosed' && after(e));
  const vetoed = reached !== undefined && ofEpoch.some((e) => e.name === 'IndexVetoed' && e.slot > reached.slot);
  const proposed =
    reached !== undefined && (reached.data.proposed === true || inRound.some((e) => e.name === 'IndexBallotSubmitted'));
  const status: FeeIndexBallotView['status'] =
    closed || (index !== null && index.epoch >= BigInt(programEpoch))
      ? 'settled'
      : !reached
        ? 'voting'
        : vetoed
          ? 'vetoed'
          : proposed
            ? 'proposed'
            : 'queued';
  const totalWeight = Number(opened.data.totalWeight);
  return {
    address,
    programEpoch,
    round,
    status,
    thresholdBps: Number(opened.data.thresholdBps),
    toleranceBps,
    totalWeight,
    agreeingWeight,
    agreeingBps: agreeingBpsOf(agreeingWeight, totalWeight),
    votesCast: cast.size,
    operatorCount: operators.length,
    medianValue: center === null ? null : Number(center),
    consensus: reached !== undefined,
    consensusValue: reached ? Number(big(reached.data.value)) : null,
    consensusSlot: reached ? Number(reached.data.slot ?? reached.slot) : null,
    votes,
    source: 'events',
  };
}
