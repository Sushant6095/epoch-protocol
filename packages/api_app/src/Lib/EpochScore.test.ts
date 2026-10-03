import { computeScore, displayScore, type ScoreInputs } from './EpochScore';

// Mirrors the Rust tests in programs/epoch/src/math/score.rs so the two formulas cannot drift.
const good = (): ScoreInputs => ({
  creditsRatioBps: 9_900,
  commissionBps: 500,
  epochsActive: 60,
  delinquent: false,
  superminority: false,
});

describe('computeScore', () => {
  it('gives a perfect validator 10,000', () => {
    expect(computeScore(good())).toBe(10_000);
  });

  it('gives a delinquent validator 0', () => {
    expect(computeScore({ ...good(), delinquent: true })).toBe(0);
  });

  it('ramps credits monotonically with the program’s break points', () => {
    let last = 0;
    for (let ratio = 0; ratio <= 11_000; ratio += 100) {
      const score = computeScore({ ...good(), creditsRatioBps: ratio });
      expect(score).toBeGreaterThanOrEqual(last);
      last = score;
    }
    expect(computeScore({ ...good(), creditsRatioBps: 9_000 })).toBe(3_000 + 2_500 + 1_500);
    expect(computeScore({ ...good(), creditsRatioBps: 4_500 })).toBe(1_500 + 2_500 + 1_500);
  });

  it('scores commission: full to 5%, linear to 10%, nothing above', () => {
    expect(computeScore({ ...good(), commissionBps: 750 })).toBe(6_000 + 1_750 + 1_500);
    expect(computeScore({ ...good(), commissionBps: 1_000 })).toBe(6_000 + 1_000 + 1_500);
    expect(computeScore({ ...good(), commissionBps: 1_001 })).toBe(6_000 + 0 + 1_500);
  });

  it('builds tenure over 30 epochs', () => {
    expect(computeScore({ ...good(), epochsActive: 15 })).toBe(6_000 + 2_500 + 750);
  });

  it('caps the superminority at 5,000', () => {
    expect(computeScore({ ...good(), superminority: true })).toBe(5_000);
  });

  it('shows 0–100 in the UI', () => {
    expect(displayScore(8_549)).toBe(85);
    expect(displayScore(10_000)).toBe(100);
  });
});
