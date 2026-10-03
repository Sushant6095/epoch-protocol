import { type CallPoints, type CallSide, type PredictMarket, type PredictSnapshot } from '../../types/Account.types';

// Pure Predict rules in points mode (decisions 2, 3 and 23): market naming, parimutuel settlement, estimates and the
// words on the cards. PredictService and the jobs do the I/O around them.

export const CALL_SIZES_POINTS: CallPoints[] = [10, 25, 50, 100];
export const PAYOUT_FORMULA =
  'payout = a * (P + a) / (s * P + a)  // a = points called, P = pool in points, s = chosen side share; no fee in points mode';
export const ANSWER_SOURCE = 'Epoch Fee Index, final value after its dispute window';

/**
 * The contract's payout preview for a NEW call (contracts/epoch-data.ts): a = points called, P = pool in points,
 * s = chosen side's share (0–1). 100 points on YES at 62% of a 31,800-point pool → ≈ 161.
 */
export const parimutuelPayout = (a: number, P: number, s: number): number => (a * (P + a)) / (s * P + a);

export interface PoolTotals {
  yes: number;
  no: number;
}

/** What a call already in the pool returns if right, at the current pool: round(a + a × L / W), W includes it. */
export function estimatePayout(points: number, side: CallSide, pool: PoolTotals): number {
  const winning = side === 'yes' ? pool.yes : pool.no;
  const losing = side === 'yes' ? pool.no : pool.yes;
  if (winning <= 0) return points;
  return Math.round(points + (points * losing) / winning);
}

/** YES when the final value is strictly above the threshold. */
export const answerFor = (value: number, threshold: number): CallSide => (value > threshold ? 'yes' : 'no');

/** New markets ask about the latest final value rounded to the nearest 50 µL/CU. */
export const thresholdFor = (latestFinal: number): number => Math.round(latestFinal / 50) * 50;

export interface CallToSettle {
  id: number;
  side: string;
  points: number;
}

export interface Settlement {
  /** The side the final value picked. */
  answer: CallSide;
  /** `answer`, or "refunded" when nobody called the winning side (decision 23). */
  outcome: CallSide | 'refunded';
  /** W: points on the winning side. */
  winningPoints: number;
  /** L: points on the losing side. */
  losingPoints: number;
  /** call id → points returned. */
  payouts: Map<number, number>;
}

/**
 * Parimutuel settlement, no fee: each winning call gets its points back plus floor(points × L / W) of the losing side;
 * losing calls get 0. W = 0 (nobody on the winning side): every call gets its points back. Exact integer math.
 */
export function settleParimutuel(calls: readonly CallToSettle[], answer: CallSide): Settlement {
  let winning = 0;
  let losing = 0;
  for (const call of calls) {
    if (call.side === answer) winning += call.points;
    else losing += call.points;
  }
  const payouts = new Map<number, number>();
  if (winning === 0) {
    for (const call of calls) payouts.set(call.id, call.points);
    return { answer, outcome: 'refunded', winningPoints: 0, losingPoints: losing, payouts };
  }
  for (const call of calls) {
    const share =
      call.side === answer ? call.points + Number((BigInt(call.points) * BigInt(losing)) / BigInt(winning)) : 0;
    payouts.set(call.id, share);
  }
  return { answer, outcome: answer, winningPoints: winning, losingPoints: losing, payouts };
}

const thousands = (value: number): string => value.toLocaleString('en-US');

export const marketId = (epoch: number, threshold: number): string => `fee-index-${epoch}-above-${threshold}`;
export const marketQuestion = (epoch: number, threshold: number): string =>
  `Will epoch ${epoch}’s Fee Index close above ${thousands(threshold)} µL/CU?`;
export const marketLabel = (epoch: number, threshold: number): string =>
  `Fee Index above ${thousands(threshold)} · epoch ${epoch}`;

/** A predict_markets row as the card logic needs it. */
export interface MarketState {
  epoch: number;
  /** open | settled in the database; "closed" is derived from the current epoch. */
  status: string;
  outcome: string | null;
  resolvedValue: number | null;
}

export function marketStatus(market: MarketState, currentEpoch: number): PredictMarket['status'] {
  if (market.status === 'settled') return 'settled';
  return currentEpoch < market.epoch ? 'open' : 'closed';
}

/** The card's "now" line (fixture predict.sample.json); null while the market is open. */
export function marketNowNote(
  market: MarketState,
  currentEpoch: number,
  index: { final: number | null; proposed: number | null },
): string | null {
  if (market.status === 'settled') {
    const value = thousands(market.resolvedValue ?? 0);
    return market.outcome === 'refunded'
      ? `Final ${value} µL/CU: nobody called the winning side, calls refunded`
      : `Final ${value} µL/CU: ${String(market.outcome).toUpperCase()}`;
  }
  if (currentEpoch < market.epoch) return null;
  if (currentEpoch === market.epoch) return `Epoch ${market.epoch} is running; its index is posted when it ends`;
  // Final but not settled yet: the resolver settles it within minutes.
  if (index.final !== null) return `Final ${thousands(index.final)} µL/CU: settling`;
  if (index.proposed !== null) return `Proposed ${thousands(index.proposed)} µL/CU, in its dispute window`;
  return `Waiting for epoch ${market.epoch}’s Fee Index`;
}

type MyCall = PredictSnapshot['myCalls'][number];

/** One row of "Your calls": status, estimate while unsettled, net points once settled (0 when refunded). */
export function myCallView(
  call: { side: string; points: number; payoutPoints: number | null },
  market: MarketState & { label: string },
  currentEpoch: number,
  pool: PoolTotals,
): MyCall {
  const side = call.side as CallSide;
  const points = call.points as CallPoints;
  const base = { label: market.label, side, points };
  if (market.status !== 'settled') {
    return {
      ...base,
      status: currentEpoch < market.epoch ? 'open' : 'settling',
      estPayoutPoints: estimatePayout(call.points, side, pool),
      netPoints: null,
    };
  }
  if (market.outcome === 'refunded') return { ...base, status: 'refunded', estPayoutPoints: null, netPoints: 0 };
  return {
    ...base,
    status: side === market.outcome ? 'won' : 'lost',
    estPayoutPoints: null,
    netPoints: (call.payoutPoints ?? 0) - call.points,
  };
}
