import {
  answerFor,
  estimatePayout,
  marketId,
  marketLabel,
  marketNowNote,
  marketQuestion,
  marketStatus,
  myCallView,
  parimutuelPayout,
  settleParimutuel,
  thresholdFor,
} from './PredictMath';

describe('payout math', () => {
  it('matches the contract example: 100 points on YES at 62% of a 31,800-point pool → ≈ 161', () => {
    const payout = parimutuelPayout(100, 31_800, 0.62);
    expect(Math.round(payout)).toBe(161);
    expect(Math.round(payout) - 100).toBe(61);
    // The same call once it is in the pool: W = 0.62 × 31,800 + 100, L = 0.38 × 31,800.
    expect(estimatePayout(100, 'yes', { yes: 19_716 + 100, no: 12_084 })).toBe(161);
  });

  it('estimates a call already in the pool as round(a + a × L / W)', () => {
    expect(estimatePayout(50, 'yes', { yes: 19_716, no: 12_084 })).toBe(81); // 50 + 30.6
    expect(estimatePayout(100, 'no', { yes: 6_248, no: 7_952 })).toBe(179); // 100 + 78.57
    expect(estimatePayout(25, 'no', { yes: 0, no: 25 })).toBe(25); // nobody on the other side
  });

  it('answers YES only strictly above the threshold, and rounds new thresholds to the nearest 50', () => {
    expect(answerFor(1_301, 1_300)).toBe('yes');
    expect(answerFor(1_300, 1_300)).toBe('no');
    expect(thresholdFor(1_284)).toBe(1_300);
    expect(thresholdFor(1_274)).toBe(1_250);
    expect(thresholdFor(1_275)).toBe(1_300);
    expect(thresholdFor(12)).toBe(0);
  });
});

describe('settleParimutuel', () => {
  it('shares the losing side among the winners in proportion, rounding each share down', () => {
    const calls = [
      { id: 1, side: 'yes', points: 100 },
      { id: 2, side: 'yes', points: 50 },
      { id: 3, side: 'yes', points: 25 },
      { id: 4, side: 'no', points: 100 },
      { id: 5, side: 'no', points: 10 },
    ];
    const s = settleParimutuel(calls, 'yes');
    expect(s).toMatchObject({ answer: 'yes', outcome: 'yes', winningPoints: 175, losingPoints: 110 });
    // 100 × 110 / 175 = 62.86 → 62; 50 × 110 / 175 = 31.43 → 31; 25 × 110 / 175 = 15.71 → 15
    expect(Object.fromEntries(s.payouts)).toEqual({ 1: 162, 2: 81, 3: 40, 4: 0, 5: 0 });
    // never pays out more than the pool
    const paid = [...s.payouts.values()].reduce((a, b) => a + b, 0);
    expect(paid).toBeLessThanOrEqual(285);
    expect(285 - paid).toBe(2);
  });

  it('refunds every call when nobody called the winning side (decision 23)', () => {
    const s = settleParimutuel(
      [
        { id: 7, side: 'yes', points: 50 },
        { id: 8, side: 'yes', points: 10 },
      ],
      'no',
    );
    expect(s).toMatchObject({ answer: 'no', outcome: 'refunded', winningPoints: 0, losingPoints: 60 });
    expect(Object.fromEntries(s.payouts)).toEqual({ 7: 50, 8: 10 });
    expect(settleParimutuel([], 'yes').outcome).toBe('refunded');
  });

  it('gives winners their points back when the other side is empty', () => {
    const s = settleParimutuel([{ id: 9, side: 'no', points: 25 }], 'no');
    expect(s.outcome).toBe('no');
    expect(s.payouts.get(9)).toBe(25);
  });

  it('stays exact on large pools', () => {
    const s = settleParimutuel(
      [
        { id: 1, side: 'yes', points: 100 },
        { id: 2, side: 'yes', points: 2_999_999_900 },
        { id: 3, side: 'no', points: 7_000_000_003 },
      ],
      'yes',
    );
    // 100 × 7,000,000,003 / 3,000,000,000 = 233.333… → 233
    expect(s.payouts.get(1)).toBe(333);
  });
});

describe('market words', () => {
  it('names markets like the fixture', () => {
    expect(marketId(1045, 1500)).toBe('fee-index-1045-above-1500');
    expect(marketQuestion(1045, 1500)).toBe('Will epoch 1045’s Fee Index close above 1,500 µL/CU?');
    expect(marketLabel(1045, 1500)).toBe('Fee Index above 1,500 · epoch 1045');
  });

  it('derives status and the now-line from the current epoch and the index', () => {
    const open = { epoch: 1045, status: 'open', outcome: null, resolvedValue: null };
    const none = { final: null, proposed: null };
    expect(marketStatus(open, 1044)).toBe('open');
    expect(marketNowNote(open, 1044, none)).toBeNull();
    expect(marketStatus(open, 1045)).toBe('closed');
    expect(marketNowNote(open, 1045, none)).toBe('Epoch 1045 is running; its index is posted when it ends');
    expect(marketNowNote(open, 1046, { final: null, proposed: 1_330 })).toBe(
      'Proposed 1,330 µL/CU, in its dispute window',
    );
    expect(marketNowNote(open, 1046, none)).toBe('Waiting for epoch 1045’s Fee Index');
    expect(marketNowNote(open, 1046, { final: 1_284, proposed: null })).toBe('Final 1,284 µL/CU: settling');

    const settled = { epoch: 1042, status: 'settled', outcome: 'yes', resolvedValue: 1_284 };
    expect(marketStatus(settled, 1044)).toBe('settled');
    expect(marketNowNote(settled, 1044, none)).toBe('Final 1,284 µL/CU: YES');
    expect(marketNowNote({ ...settled, outcome: 'refunded' }, 1044, none)).toBe(
      'Final 1,284 µL/CU: nobody called the winning side, calls refunded',
    );
  });

  it('shows a call as open, settling, won, lost or refunded', () => {
    const market = { epoch: 1045, status: 'open', outcome: null, resolvedValue: null, label: 'L' };
    const pool = { yes: 19_716, no: 12_084 };
    const call = { side: 'yes', points: 50, payoutPoints: null };
    expect(myCallView(call, market, 1044, pool)).toEqual({
      label: 'L',
      side: 'yes',
      points: 50,
      status: 'open',
      estPayoutPoints: 81,
      netPoints: null,
    });
    expect(myCallView(call, market, 1046, pool).status).toBe('settling');
    const settled = { ...market, status: 'settled', outcome: 'yes', resolvedValue: 1_600 };
    expect(myCallView({ ...call, payoutPoints: 80 }, settled, 1047, pool)).toMatchObject({
      status: 'won',
      estPayoutPoints: null,
      netPoints: 30,
    });
    expect(myCallView({ ...call, side: 'no', payoutPoints: 0 }, settled, 1047, pool)).toMatchObject({
      status: 'lost',
      netPoints: -50,
    });
    expect(myCallView({ ...call, payoutPoints: 50 }, { ...settled, outcome: 'refunded' }, 1047, pool)).toMatchObject({
      status: 'refunded',
      netPoints: 0,
    });
  });
});
