import { median, slotMedianCuPrice, stakeWeightedMedian } from './FeeProcessor';

describe('FeeProcessor', () => {
  it('computes medians for odd and even counts', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2);
    expect(median([])).toBe(0);
  });

  it('excludes transactions paid by the slot leader', () => {
    const txs = [
      { feePayer: 'leader', cuPrice: 1_000_000 },
      { feePayer: 'a', cuPrice: 100 },
      { feePayer: 'b', cuPrice: 300 },
    ];
    expect(slotMedianCuPrice(txs, 'leader')).toBe(200);
  });

  it('weights leaders by stake so a small leader cannot move the index', () => {
    const honest = [
      { leader: 'big1', medianCuPrice: 7_000, stake: 100n },
      { leader: 'big2', medianCuPrice: 8_000, stake: 150n },
    ];
    const withOutlier = [...honest, { leader: 'small', medianCuPrice: 1_000_000, stake: 1n }];
    expect(stakeWeightedMedian(honest)).toBe(8_000);
    expect(stakeWeightedMedian(withOutlier)).toBe(8_000);
  });

  it('ignores zero-stake leaders and handles an empty set', () => {
    expect(stakeWeightedMedian([{ leader: 'x', medianCuPrice: 5, stake: 0n }])).toBe(0);
    expect(stakeWeightedMedian([])).toBe(0);
  });
});
