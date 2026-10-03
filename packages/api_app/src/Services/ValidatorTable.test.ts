import { healthOf } from './ValidatorTable';

describe('healthOf', () => {
  const healthy = { delinquent: false, healthPerEpochSol: 1, biggestDelegatorSharePct: 10, uptimePct: 100 };

  it('puts a validator on Watch when its commission rose in the last 10 epochs', () => {
    const commissionHistory = [
      { epoch: 1038, commissionPct: 5 },
      { epoch: 1042, commissionPct: 8 },
      { epoch: 1047, commissionPct: 8 },
    ];
    expect(healthOf({ ...healthy, commissionHistory })).toEqual({
      health: 'watch',
      healthReasons: ['commission raised 5% → 8%'],
    });
  });

  it('stays healthy without history or after a cut', () => {
    expect(healthOf(healthy)).toEqual({ health: 'healthy', healthReasons: [] });
    const cut = [
      { epoch: 1046, commissionPct: 10 },
      { epoch: 1047, commissionPct: 5 },
    ];
    expect(healthOf({ ...healthy, commissionHistory: cut }).health).toBe('healthy');
    expect(healthOf({ ...healthy, delinquent: true, commissionHistory: cut })).toEqual({
      health: 'offline',
      healthReasons: ['not voting'],
    });
  });
});
