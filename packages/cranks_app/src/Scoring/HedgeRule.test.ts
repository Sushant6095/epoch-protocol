import { findQuotePda } from '@epoch/epoch-sdk';

import { key, position, PROGRAM_ID, SOL, swap } from '../__fixtures__/accounts';
import { averageRevenuePerEpoch, HEDGE_RULE, hedgeStatus } from './HedgeRule';

const MAKER = key(50);
const OTHER_MAKER = key(51);
const quoteOf = (maker = MAKER, epoch: bigint) => findQuotePda(PROGRAM_ID, maker, epoch)[0];

/** 4 epochs of history averaging 10 SOL: the hedge needs 5 SOL Receive-fixed on each of epochs 101–105. */
const validator = position({
  revenue: [8n * SOL, 12n * SOL, 9n * SOL, 11n * SOL, 0n, 0n, 0n, 0n, 0n, 0n],
  revenueHead: 4,
  revenueCount: 4,
});
const hedgeOn = (epochs: bigint[], notional = 5n * SOL, overrides = {}) =>
  epochs.map((epoch) =>
    swap({ epoch, notional, quote: quoteOf(MAKER, epoch), taker: validator.operator, ...overrides }),
  );
const status = (swaps: ReturnType<typeof swap>[], makers = [MAKER]) =>
  hedgeStatus({ programId: PROGRAM_ID, position: validator, currentEpoch: 100n, swaps, makers });

describe('hedged rule', () => {
  it('is five epochs at half the average revenue', () => {
    expect(HEDGE_RULE).toEqual({ epochsAhead: 5, minNotionalShareBps: 5_000 });
    expect(averageRevenuePerEpoch(validator)).toBe(10n * SOL);
    expect(averageRevenuePerEpoch(position())).toBe(0n);
  });

  it('is hedged with Receive-fixed swaps on each of the next five epochs, each at least half', () => {
    const result = status(hedgeOn([101n, 102n, 103n, 104n, 105n]));
    expect(result.hedged).toBe(true);
    expect(result.requiredNotional).toBe(5n * SOL);
    expect(result.coverage.map((c) => c.epoch)).toEqual([101n, 102n, 103n, 104n, 105n]);
  });

  it('is not hedged when one epoch is missing or short', () => {
    expect(status(hedgeOn([101n, 102n, 103n, 104n])).hedged).toBe(false);
    const short = [...hedgeOn([101n, 102n, 103n, 104n]), ...hedgeOn([105n], 5n * SOL - 1n)];
    const result = status(short);
    expect(result.hedged).toBe(false);
    expect(result.reason).toContain('epoch 105');
  });

  it('ignores Pay-fixed swaps, the current epoch, other takers and other makers', () => {
    expect(status(hedgeOn([101n, 102n, 103n, 104n, 105n], 5n * SOL, { side: 'payFixed' })).hedged).toBe(false);
    expect(status(hedgeOn([100n, 101n, 102n, 103n, 104n])).hedged).toBe(false);
    expect(status(hedgeOn([101n, 102n, 103n, 104n, 105n], 5n * SOL, { taker: key(99) })).hedged).toBe(false);
    const elsewhere = [101n, 102n, 103n, 104n, 105n].map((epoch) =>
      swap({ epoch, notional: 5n * SOL, quote: quoteOf(OTHER_MAKER, epoch), taker: validator.operator }),
    );
    expect(status(elsewhere).hedged).toBe(false);
    expect(status(elsewhere, [MAKER, OTHER_MAKER]).hedged).toBe(true);
  });

  it('adds up swaps on the same epoch against several makers', () => {
    const halves = [MAKER, OTHER_MAKER].flatMap((maker) =>
      [101n, 102n, 103n, 104n, 105n].map((epoch) =>
        swap({ epoch, notional: (5n * SOL) / 2n, quote: quoteOf(maker, epoch), taker: validator.operator }),
      ),
    );
    expect(status(halves, [MAKER, OTHER_MAKER]).hedged).toBe(true);
  });

  it('never counts anyone as hedged without a configured maker, or with no revenue history', () => {
    const result = status(hedgeOn([101n, 102n, 103n, 104n, 105n]), []);
    expect(result.hedged).toBe(false);
    expect(result.reason).toContain('EPOCH_MARKET_MAKER');
    const fresh = position({ operator: validator.operator });
    const dust = hedgeStatus({
      programId: PROGRAM_ID,
      position: fresh,
      currentEpoch: 100n,
      swaps: hedgeOn([101n, 102n, 103n, 104n, 105n], 0n),
      makers: [MAKER],
    });
    expect(dust.requiredNotional).toBe(1n);
    expect(dust.hedged).toBe(false);
  });
});
