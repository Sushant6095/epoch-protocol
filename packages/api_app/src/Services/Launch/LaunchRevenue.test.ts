import { type ValidatorRow } from '../../types/Api.types';
import { type ValidatorTableData } from '../ValidatorTable';
import { estimateRevenuePerEpochSol, validatorTableRevenue } from './LaunchRevenue';

const row = (vote: string, overrides: Partial<ValidatorRow> = {}): ValidatorRow =>
  ({
    vote,
    stakeSol: 1_000_000,
    commissionPct: 5,
    tipsApyPct: 0.8,
    mevCommissionPct: 10,
    ...overrides,
  }) as ValidatorRow;

const table = (rows: ValidatorRow[]): ValidatorTableData =>
  ({ rows, grossYieldPerEpoch: 0.00015, epochsPerYear: 182 }) as unknown as ValidatorTableData;

describe('estimateRevenuePerEpochSol', () => {
  it('adds inflation commission and MEV commission, as the validator table does', () => {
    // 1,000,000 SOL × 0.00015 × 5% = 7.5 SOL; tips to stakers 1,000,000 × 0.8% ÷ 182 = 43.956, MEV commission 10%.
    const tips = (1_000_000 * 0.008) / 182;
    expect(estimateRevenuePerEpochSol(row('a'), table([]))).toBeCloseTo(7.5 + (tips * 1_000) / 9_000, 9);
  });

  it('counts no MEV commission without a known MEV commission or tips', () => {
    expect(estimateRevenuePerEpochSol(row('a', { mevCommissionPct: null }), table([]))).toBeCloseTo(7.5, 9);
    expect(estimateRevenuePerEpochSol(row('a', { tipsApyPct: null }), table([]))).toBeCloseTo(7.5, 9);
  });
});

describe('validatorTableRevenue', () => {
  it('looks the vote account up in the mainnet table', async () => {
    const load = jest.fn().mockResolvedValue(table([row('vote-a'), row('vote-b', { commissionPct: 10 })]));
    const revenue = validatorTableRevenue(load);
    expect((await revenue('vote-b')).avgRevenueSol).toBeGreaterThan((await revenue('vote-a')).avgRevenueSol as number);
    expect(await revenue('vote-c')).toEqual({
      avgRevenueSol: null,
      note: 'its vote account is not a mainnet validator with stake',
    });
    expect(await revenue(null)).toEqual({ avgRevenueSol: null, note: 'no mainnet vote account in the registry' });
  });

  it('reports a table it cannot load', async () => {
    const revenue = validatorTableRevenue(() => Promise.reject(new Error('rpc down')));
    expect(await revenue('vote-a')).toEqual({
      avgRevenueSol: null,
      note: 'the mainnet validator table is unavailable',
    });
  });
});
