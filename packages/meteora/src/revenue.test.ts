import { estimateBlockRevenue, retryRateLimited, spreadSample, summarizeRevenue } from './revenue';

describe('summarizeRevenue', () => {
  const rows = [
    { epoch: 1038, inflationCommissionSol: 1.7, blockRevenueSol: null, mevCommissionSol: 0.1 },
    { epoch: 1039, inflationCommissionSol: 1.8, blockRevenueSol: 4, mevCommissionSol: 0.2 },
    { epoch: 1040, inflationCommissionSol: 1.9, blockRevenueSol: 6, mevCommissionSol: null },
  ];

  it('averages each part over the epochs it was read for and sums the included parts', () => {
    const summary = summarizeRevenue(rows);
    expect(summary.epochs).toEqual([1038, 1039, 1040]);
    expect(summary.inflationCommissionSol).toBeCloseTo(1.8, 12);
    expect(summary.blockRevenueSol).toBeCloseTo(5, 12); // 1038's schedule was not available: left out
    expect(summary.mevCommissionSol).toBeCloseTo(0.15, 12);
    expect(summary.avgRevenueSol).toBeCloseTo(6.95, 12);
    expect(summary.included).toEqual({ inflation: true, blocks: true, mev: true });
  });

  it('leaves out the parts asked for, and parts never read', () => {
    expect(summarizeRevenue(rows, { blocks: false }).avgRevenueSol).toBeCloseTo(1.95, 12);
    const inflationOnly = rows.map((row) => ({ ...row, blockRevenueSol: null, mevCommissionSol: null }));
    expect(summarizeRevenue(inflationOnly)).toMatchObject({
      avgRevenueSol: 1.8,
      included: { inflation: true, blocks: false, mev: false },
    });
  });
});

describe('estimateBlockRevenue', () => {
  it('leader slots × the produced share of the sample × the mean fee of produced blocks', () => {
    const estimate = estimateBlockRevenue({ leaderSlots: 200, samples: [20_000_000, null, 30_000_000, 25_000_000] });
    expect(estimate.sampled).toBe(4);
    expect(estimate.skipped).toBe(1);
    expect(estimate.meanFeeSol).toBeCloseTo(0.025, 12);
    expect(estimate.blockRevenueSol).toBeCloseTo(200 * 0.75 * 0.025, 12);
    expect(estimateBlockRevenue({ leaderSlots: 0, samples: [] }).blockRevenueSol).toBe(0);
  });

  it('spreads the sample evenly over the leader slots', () => {
    expect(spreadSample([0, 4, 8, 12, 16, 20, 24, 28], 4)).toEqual([4, 12, 20, 28]);
    expect(spreadSample([1, 2], 6)).toEqual([1, 2]);
    expect(spreadSample([], 3)).toEqual([]);
  });
});

describe('retryRateLimited', () => {
  it('retries HTTP 429 with a growing wait, and nothing else', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('429 Too Many Requests');
      return 'ok';
    };
    await expect(retryRateLimited(flaky, 5, 1)).resolves.toBe('ok');
    expect(calls).toBe(3);
    await expect(retryRateLimited(async () => Promise.reject(new Error('boom')), 5, 1)).rejects.toThrow('boom');
    await expect(retryRateLimited(async () => Promise.reject(new Error('429')), 2, 1)).rejects.toThrow('429');
  });
});
