import { planLaunch } from './launch';
import { formatSol, launchPlanLines, revenueTableLines } from './launchReport';
import { summarizeRevenue } from './revenue';

describe('the launch plan as text', () => {
  const plan = planLaunch({
    config: {
      validator: { name: 'Kestrel Nodes', vote: null },
      symbol: 'rKEST',
      name: 'Kestrel Nodes revenue token',
      uri: 'https://example.invalid/rkest.json',
      shareBps: 500,
      termEpochs: 100,
      supply: 100_000,
      decimals: 6,
      raiseTargetSol: 5,
    },
    avgRevenueSol: 20.8,
    startEpoch: 1_043,
  });

  it('shows each step of the pricing with its numbers (the spec fixture: rKEST)', () => {
    const text = launchPlanLines(plan).join('\n');
    expect(text).toContain('5% × 20.8 SOL = 1.04 SOL an epoch');
    expect(text).toContain('Term               100 epochs, 1043–1142');
    expect(text).toContain('1.04 × 100 = 104 SOL');
    expect(text).toContain('104 ÷ 100,000 tokens = 0.00104000 SOL');
    expect(text).toContain('60% → 0.000624000 SOL (start, pMin); 95% → 0.000988000 SOL (graduation, pMax)');
    expect(text).toMatch(/Raise\s+5\.0\d+ SOL = DBC migrationQuoteThreshold/);
    expect(text).toContain('70% × ');
    expect(text).toContain('never annualised');
  });

  it('prints the revenue window and its average', () => {
    const rows = [
      {
        epoch: 1,
        inflationCommissionSol: 1,
        blockRevenueSol: 2,
        mevCommissionSol: null,
        blocks: { leaderSlots: 100, sampled: 6, skipped: 1, meanFeeSol: 0.02 },
      },
      { epoch: 2, inflationCommissionSol: 3, blockRevenueSol: null, mevCommissionSol: null },
    ];
    const lines = revenueTableLines(rows, summarizeRevenue(rows), 'test RPC');
    expect(lines[0]).toBe('Revenue source     test RPC');
    expect(lines[2]).toContain('(100 slots, 6 read, 1 skipped)');
    expect(lines[3]).toContain('—');
    expect(lines[lines.length - 1]).toBe('  average inflation 2 + blocks 2 = 4 SOL an epoch');
    expect(formatSol(1_500_000_000)).toBe('1.5 SOL');
  });
});
