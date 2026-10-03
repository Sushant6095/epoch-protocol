import { fakeDeps, validatorRow } from '../../__fixtures__/ProgramFakes';
import { key, ProgramSim, sol } from '../../__fixtures__/ProgramSim';
import { OperatorPositionService, sweepableEstimate } from './OperatorPositionService';

const W = (label: string): string => key(label).toBase58();
const NTT = 'FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk';

/**
 * NTT DOCOMO GLOBAL's row from validator-ntt-docomo.real.json, with the gross yield and tips APY that give its
 * revenue for epoch 1043: inflation commission 1.74 SOL + tips commission 0.15 SOL = 1.89 SOL sweepable an epoch.
 */
const ntt = validatorRow({
  name: 'NTT DOCOMO GLOBAL',
  vote: NTT,
  stakeSol: 193_097,
  commissionPct: 5,
  mevCommissionPct: 10,
  tipsApyPct: ((0.15 * 9 * 271.5) / 193_097) * 100,
  epochScore: 100,
});
const GROSS_YIELD = 1.74 / (193_097 * 0.05);

describe('OperatorPositionService: not onboarded', () => {
  it('estimates the limit from the mainnet row and the devnet Pool parameters', async () => {
    const sim = new ProgramSim(1173);
    sim.initialize();
    const service = new OperatorPositionService(
      fakeDeps(sim, await sim.store(), { rows: [ntt], grossYieldPerEpoch: GROSS_YIELD }),
    );
    const position = await service.position(NTT);
    expect(position).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      asOf: '2026-10-03T10:00:00+05:30',
      vote: NTT,
      name: 'NTT DOCOMO GLOBAL',
      state: 'not_onboarded',
      score: 100,
      sweptEpochs: 0,
      bondSol: 0,
      creditStartsAfterEpochs: 3,
      advance: null,
    });
    expect(position.note).toBeUndefined();
    // The kit's figures: 1.89 SOL an epoch → 4.7 SOL (25%) and 7.6 SOL hedged (40%) over 10 epochs; bonds 1.18 / 1.9.
    expect(position.limit.sweepablePerEpochSol).toBeCloseTo(1.89, 6);
    expect(position.limit.unhedgedSol).toBeCloseTo(4.725, 6);
    expect(position.limit.hedgedSol).toBeCloseTo(7.56, 6);
    expect(position.limit.bondForFullUnhedgedSol).toBeCloseTo(1.18125, 6);
    expect(position.limit.bondForFullHedgedSol).toBeCloseTo(1.89, 6);
    expect(position.onboardingSteps.map((s) => s.key)).toEqual(['withdraw_authority', 'collectors', 'bond']);
    expect(position.onboardingSteps[2].detail).toBe(
      'Your limit is at most 4 × bond; it covers the first loss if you stop paying.',
    );
    expect(position.covenants).toEqual([
      'Commission is locked while money is owed',
      'Identity is locked while money is owed',
      'The bond is locked while money is owed',
      'A defaulted validator remits 100% of new revenue until the advance is recovered',
    ]);
  });

  it('answers from the planned parameters, marked sample, before the Pool exists or when the program is unset', async () => {
    const sim = new ProgramSim(1173);
    const deps = fakeDeps(sim, await sim.store(), { rows: [ntt], grossYieldPerEpoch: GROSS_YIELD });
    const noPool = await new OperatorPositionService(deps).position(NTT);
    expect(noPool).toMatchObject({ kind: 'sample', state: 'not_onboarded' });
    expect(noPool.note).toContain("the Epoch Pool isn't initialized on devnet yet");
    expect(noPool.limit.unhedgedSol).toBeCloseTo(4.725, 6);

    sim.configured = false;
    const unset = await new OperatorPositionService(deps).position(NTT);
    expect(unset).toMatchObject({ kind: 'sample', state: 'not_onboarded' });
    expect(unset.note).toContain('EPOCH_PROGRAM_ID');
  });

  it('caps the estimate at the largest advance and skips the bond when the multiplier is 0', async () => {
    const sim = new ProgramSim(1173);
    sim.initialize();
    sim.poolState!.params.maxAdvanceLamports = sol(5);
    sim.poolState!.params.bondMultiplier = 0;
    sim.poolState!.params.minCommissionBps = 500;
    const service = new OperatorPositionService(
      fakeDeps(sim, await sim.store(), { rows: [ntt], grossYieldPerEpoch: GROSS_YIELD }),
    );
    const position = await service.position(NTT);
    expect(position.limit).toMatchObject({ hedgedSol: 5, bondForFullUnhedgedSol: 0, bondForFullHedgedSol: 0 });
    expect(position.onboardingSteps[2].detail).toBe('It covers the first loss if you stop paying.');
    expect(position.covenants.at(-1)).toBe("Commission can't go below 5% while onboarded");
  });

  it('answers 404 for a vote that is neither a mainnet validator nor onboarded, 503 when mainnet data is down', async () => {
    const sim = new ProgramSim(1173);
    sim.initialize();
    await expect(
      new OperatorPositionService(fakeDeps(sim, await sim.store(), { rows: [ntt] })).position(W('nobody')),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      new OperatorPositionService(fakeDeps(sim, await sim.store(), { directoryDown: true })).position(NTT),
    ).rejects.toMatchObject({ statusCode: 503, code: 'VALIDATORS_UNAVAILABLE' });
  });

  it('adds MEV commission from the tips stakers earn', () => {
    const row = { stakeSol: 100_000, commissionPct: 0, tipsApyPct: 0.27, mevCommissionPct: 10 };
    // 100,000 SOL × 0.27% ÷ 270 epochs = 1 SOL to stakers an epoch → 1 × 10 / 90 to the validator.
    expect(Number(sweepableEstimate(row, 0, 270))).toBeCloseTo(1e9 / 9, -1);
    expect(sweepableEstimate({ ...row, mevCommissionPct: null }, 0, 270)).toBe(0n);
  });
});

/** Northwind from operator-position.sample.json: 48 SOL swept an epoch, a 30 SOL bond, 120 SOL drawn in 1042. */
function northwind(): { sim: ProgramSim; vote: string } {
  const vote = W('vote:northwind');
  const sim = new ProgramSim(1028);
  sim.initialize();
  sim.deposit(W('lender'), 'junior', sol(400));
  sim.deposit(W('lender'), 'senior', sol(1_000));
  sim.onboard(vote, W('op:northwind'), { score: 8_400, bond: sol(30) });
  for (let epoch = 1029; epoch <= 1041; epoch++) {
    sim.nextEpoch();
    sim.sweep(vote, sol(48));
  }
  sim.nextEpoch(); // 1042
  sim.requestAdvance(vote, sol(120));
  sim.sweep(vote, sol(48));
  sim.nextEpoch(); // 1043
  sim.sweep(vote, sol(48));
  sim.nextEpoch(); // 1044, not swept yet
  return { sim, vote };
}

describe('OperatorPositionService: onboarded', () => {
  it("shows Northwind's open advance with its schedule and activity (operator-position.sample.json)", async () => {
    const { sim, vote } = northwind();
    const position = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(vote);
    expect(position).toMatchObject({
      kind: 'real',
      vote,
      name: `${vote.slice(0, 4)}…${vote.slice(-4)}`, // a devnet vote key has no mainnet row
      state: 'advance_open',
      score: 84,
      sweptEpochs: 15,
      bondSol: 30,
      onboardingSteps: [],
      creditStartsAfterEpochs: 0,
    });
    // 480 SOL over 10 epochs: 25% = 120 and 40% = 192, both capped at 4 × 30 = 120 by the bond.
    expect(position.limit).toEqual({
      unhedgedSol: 120,
      hedgedSol: 120,
      bondForFullUnhedgedSol: 30,
      bondForFullHedgedSol: 48,
      sweepablePerEpochSol: 48,
    });
    expect(position.advance).toEqual({
      openedEpoch: 1042,
      hedged: false,
      limitRatePct: 25,
      borrowedSol: 120,
      feeSol: 2.4,
      owesSol: 122.4,
      repaidSol: 48,
      remainingSol: 74.4,
      remitPct: 50,
      status: 'active',
      epochsLeft: 4,
      schedule: [
        { epoch: 1042, remitSol: 24, endingSol: 98.4, status: 'paid' },
        { epoch: 1043, remitSol: 24, endingSol: 74.4, status: 'paid' },
        { epoch: 1044, remitSol: 24, endingSol: 50.4, status: 'due' },
        { epoch: 1045, remitSol: 24, endingSol: 26.4, status: 'upcoming' },
        { epoch: 1046, remitSol: 24, endingSol: 2.4, status: 'upcoming' },
        { epoch: 1047, remitSol: 2.4, endingSol: 0, status: 'upcoming' },
      ],
      activity: [
        expect.objectContaining({ epoch: 1042, kind: 'advance', text: 'Drew 120 SOL (2.4 SOL fee)', amountSol: 120 }),
        expect.objectContaining({ epoch: 1042, kind: 'sweep', text: 'Remitted at the source (50% of 48 SOL)' }),
        expect.objectContaining({ epoch: 1043, kind: 'sweep', text: 'Remitted at the source (50% of 48 SOL)' }),
      ],
    });
    expect(position.advance?.activity.every((a) => a.signature?.startsWith('sig-'))).toBe(true);
  });

  it('moves the due row to the next epoch once this epoch is swept, and closes with "Repaid in full"', async () => {
    const { sim, vote } = northwind();
    sim.sweep(vote, sol(48)); // 1044
    let position = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(vote);
    expect(position.advance?.schedule.find((r) => r.status === 'due')).toEqual({
      epoch: 1045,
      remitSol: 24,
      endingSol: 26.4,
      status: 'due',
    });
    expect(position.advance?.epochsLeft).toBe(3);

    for (const epoch of [1045, 1046, 1047]) {
      sim.nextEpoch();
      sim.sweep(vote, sol(48));
      expect(sim.epoch).toBe(epoch);
    }
    position = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(vote);
    expect(position.state).toBe('onboarded');
    expect(position.advance).toMatchObject({ status: 'repaid', remainingSol: 0, epochsLeft: 0 });
    expect(position.advance?.schedule.every((r) => r.status === 'paid')).toBe(true);
    expect(position.advance?.activity.slice(-2).map((a) => a.text)).toEqual([
      'Last remittance at the source (2.4 SOL of 48 SOL)',
      'Repaid in full',
    ]);

    // Ten epochs after it closed, the card goes.
    sim.nextEpoch(11);
    position = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(vote);
    expect(position.advance).toBeNull();
  });

  it('shows late epochs, the default and the 100% remit while recovering', async () => {
    const vote = W('vote:quarry');
    const sim = new ProgramSim(1030);
    sim.initialize();
    sim.deposit(W('lender'), 'junior', sol(400));
    sim.onboard(vote, W('op:quarry'), { score: 7_200, bond: sol(2) });
    for (let epoch = 1031; epoch <= 1040; epoch++) {
      sim.nextEpoch();
      sim.sweep(vote, sol(10));
    }
    sim.requestAdvance(vote, sol(20)); // 1040
    sim.nextEpoch();
    sim.sweep(vote, sol(10)); // 1041: remits 5
    for (let i = 0; i < 3; i++) {
      sim.nextEpoch();
      sim.sweep(vote, 0n); // 1042–1044: late 1, 2, 3
    }
    sim.markDefault(vote);
    const position = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(vote);
    expect(position.state).toBe('defaulted');
    const advance = position.advance!;
    expect(advance).toMatchObject({ status: 'defaulted', remitPct: 100, repaidSol: 7, remainingSol: 13.4 });
    // Seven of the last ten sweeps found 10 SOL: 7 SOL an epoch, all of it remitted.
    expect(advance.epochsLeft).toBe(2);
    expect(advance.schedule).toEqual([
      { epoch: 1041, remitSol: 5, endingSol: 15.4, status: 'paid' },
      { epoch: 1042, remitSol: 0, endingSol: 15.4, status: 'late' },
      { epoch: 1043, remitSol: 0, endingSol: 15.4, status: 'late' },
      { epoch: 1044, remitSol: 0, endingSol: 15.4, status: 'late' },
      { epoch: 1045, remitSol: 7, endingSol: 6.4, status: 'due' },
      { epoch: 1046, remitSol: 6.4, endingSol: 0, status: 'upcoming' },
    ]);
    expect(advance.activity.map((a) => [a.kind, a.text])).toEqual([
      ['advance', 'Drew 20 SOL (0.4 SOL fee)'],
      ['sweep', 'Remitted at the source (50% of 10 SOL)'],
      ['late', 'No revenue to sweep: late 1 of 3'],
      ['late', 'No revenue to sweep: late 2 of 3'],
      ['late', 'No revenue to sweep: late 3 of 3'],
      // 20 − (5 − ⌊5 × 0.4 ÷ 20.4⌋ of fee) − 2 SOL of bond, to the lamport: attribute_repayment floors the fee part.
      ['late', 'Defaulted: bond applied (2 SOL), 13.098039215 SOL written off'],
    ]);
  });

  it('counts down to the first credit epoch and projects nothing without revenue', async () => {
    const vote = W('vote:fresh');
    const sim = new ProgramSim(1100);
    sim.initialize();
    sim.onboard(vote, W('op:fresh'), { bond: sol(1) });
    sim.nextEpoch();
    sim.sweep(vote, sol(2));
    const position = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(vote);
    expect(position).toMatchObject({ state: 'onboarded', sweptEpochs: 1, creditStartsAfterEpochs: 2, advance: null });
    expect(position.limit).toMatchObject({ unhedgedSol: 0, hedgedSol: 0, sweepablePerEpochSol: 2 });

    // An advance with no revenue in the window: the due row remits 0 and epochsLeft counts to the age limit.
    const late = W('vote:dry');
    sim.onboard(late, W('op:dry'), { bond: sol(5) });
    for (let i = 0; i < 3; i++) {
      sim.nextEpoch();
      sim.sweep(late, 0n);
    }
    sim.requestAdvance(late, sol(1));
    const dry = await new OperatorPositionService(fakeDeps(sim, await sim.store())).position(late);
    expect(dry.advance).toMatchObject({ epochsLeft: 20, status: 'active' });
    expect(dry.advance?.schedule).toEqual([{ epoch: 1105, remitSol: 0, endingSol: 1.02, status: 'due' }]);
  });
});
