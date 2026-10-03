import { type PoolAccount, sharePriceE9, sharePriceE9ToSol, sharesToAssets } from '@epoch/epoch-sdk';

import { fakeDeps, validatorRow } from '../../__fixtures__/ProgramFakes';
import { key, ProgramSim, sol } from '../../__fixtures__/ProgramSim';
import { PLANNED_POOL_PARAMS } from './PoolParamsView';
import {
  type Accrual,
  couponRecord,
  cycleSteps,
  PAR_PRICE_E9,
  roomBeforeJuniorMustGrow,
  seriesFromPoints,
  VaultService,
  withdrawalsDone,
} from './VaultService';

const W = (label: string): string => key(label).toBase58();
const V = {
  northwind: W('vote:northwind'),
  saltmarsh: W('vote:saltmarsh'),
  quarry: W('vote:quarry'),
  marigold: W('vote:marigold'),
  basalt: W('vote:basalt'),
};
const REVENUE: Record<keyof typeof V, number> = { northwind: 20, saltmarsh: 12, quarry: 4, marigold: 3, basalt: 8 };
const YOU = W('you');

/**
 * Twelve epochs of a small vault, 1033–1044, every step through ProgramSim (the program's ledger rules): advances
 * repaid, one late, one defaulted and recovered from its bond and later sweeps, an accrual skipped (1039), withdrawals
 * paid, one bounced at the junior floor, one cancelled, one queued for the session wallet.
 */
function world(): ProgramSim {
  const sim = new ProgramSim(1033);
  sim.initialize();
  sim.deposit(W('dao'), 'junior', sol(150));
  sim.deposit(W('fund'), 'junior', sol(200));
  sim.deposit(W('j3'), 'junior', sol(40));
  for (const j of ['j4', 'j5', 'j6', 'j7']) sim.deposit(W(j), 'junior', sol(5));
  const seniors: [string, number][] = [
    ['s0', 400],
    ['s1', 85],
    ['s2', 60],
    ['s3', 50],
    ['s4', 40],
    ['s5', 30],
    ['s6', 20],
    ['s7', 10],
    ['you', 5],
  ];
  for (const [label, amount] of seniors) sim.deposit(W(label), 'senior', sol(amount));
  sim.onboard(V.northwind, W('op:northwind'), { score: 8_400, bond: sol(30) });
  sim.onboard(V.saltmarsh, W('op:saltmarsh'), { score: 9_100, hedged: true, bond: sol(20) });
  sim.onboard(V.quarry, W('op:quarry'), { score: 7_200, bond: sol(7) });
  sim.onboard(V.marigold, W('op:marigold'), { score: 6_100, bond: sol(5) });
  sim.onboard(V.basalt, W('op:basalt'), { score: 9_000, bond: sol(15) });
  sim.accrue();

  const sweepAll = (zero: (keyof typeof V)[] = []) => {
    for (const [name, vote] of Object.entries(V) as [keyof typeof V, string][]) {
      sim.sweep(vote, zero.includes(name) ? 0n : sol(REVENUE[name]));
    }
  };
  for (let epoch = 1034; epoch <= 1044; epoch++) {
    sim.nextEpoch();
    if (epoch === 1036) sweepAll();
    else if (epoch >= 1038 && epoch <= 1040) sweepAll(['marigold']);
    else if (epoch === 1044) sweepAll(['quarry']);
    else sweepAll();

    if (epoch === 1036) {
      sim.requestAdvance(V.basalt, sol(6));
      sim.requestAdvance(V.marigold, sol(10));
    }
    if (epoch === 1040) {
      sim.markDefault(V.marigold);
      sim.deposit(W('j8'), 'junior', sol(5));
    }
    if (epoch === 1041) {
      sim.requestAdvance(V.northwind, sol(120));
      sim.requestAdvance(V.quarry, sol(5));
    }
    if (epoch === 1042) {
      sim.requestAdvance(V.saltmarsh, sol(20));
      sim.requestWithdraw(W('s2'), 'senior', sim.lender(W('s2'), 'senior')!.shares);
    }
    if (epoch !== 1039) sim.accrue();
    if (epoch === 1043) {
      expect(sim.processWithdrawal()).toBe('paid');
      sim.requestWithdraw(W('dao'), 'junior', sim.lender(W('dao'), 'junior')!.shares);
    }
    if (epoch === 1044) {
      sim.requestWithdraw(W('fund'), 'junior', sim.lender(W('fund'), 'junior')!.shares);
      expect(sim.processWithdrawal()).toBe('paid');
      expect(sim.processWithdrawal()).toBe('bounced');
      sim.requestWithdraw(YOU, 'senior', sim.lender(YOU, 'senior')!.shares / 2n);
      const seq = sim.requestWithdraw(W('s7'), 'senior', sim.lender(W('s7'), 'senior')!.shares);
      sim.cancelWithdraw(seq);
    }
  }
  return sim;
}

const ROWS = [
  validatorRow({ name: 'Northwind Staking', vote: V.northwind }),
  validatorRow({ name: 'Saltmarsh Nodes', vote: V.saltmarsh }),
];

describe('VaultService.snapshot', () => {
  it('answers the pool, tranches and parameters from the Pool account', async () => {
    const sim = world();
    const pool = sim.poolState!;
    const vault = await new VaultService(fakeDeps(sim, await sim.store(), { rows: ROWS })).snapshot(YOU);

    expect(vault).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      asOf: '2026-10-03T10:00:00+05:30',
      source: expect.stringContaining('Epoch program on devnet: Pool'),
    });
    const total = pool.seniorAssets + pool.juniorAssets + pool.incomeUnallocated;
    expect(vault.pool).toEqual({
      tvlSol: Number(total) / 1e9,
      lenders: 15,
      liveSinceEpoch: 1033,
      outstandingPrincipalSol: Number(pool.outstandingPrincipal) / 1e9,
      utilizationPct: Math.round((Number(pool.outstandingPrincipal) / Number(total)) * 10_000) / 100,
      utilizationCapPct: 60,
      // Marigold: 10 SOL borrowed, 1.5 remitted, then 3 epochs without revenue; the 5 SOL bond covered part.
      lostByLendersSol: Number(pool.totalDefaulted) / 1e9,
      defaults: 1,
    });
    expect(pool.totalDefaulted).toBeGreaterThan(0n);

    const senior = vault.tranches.senior;
    expect(senior.assetsSol).toBe(Number(pool.seniorAssets) / 1e9);
    expect(senior.sharePrice).toBe(sharePriceE9ToSol(sharePriceE9(pool.seniorAssets, pool.seniorShares)));
    expect(senior.targetBpsPerEpoch).toBe(3);
    expect(senior.apyPct).toBe(8.1); // decision 5: 3 bps ≈ 8.1% a year at 271.5 epochs
    expect(senior.roomBeforeJuniorMustGrowSol).toBe(
      Number((pool.juniorAssets * 8_000n) / 2_000n - pool.seniorAssets) / 1e9,
    );

    const junior = vault.tranches.junior;
    expect(junior.sharePrice).toBe(sharePriceE9ToSol(sharePriceE9(pool.juniorAssets, pool.juniorShares)));
    expect(junior.apySinceLaunchPct).toBe(Math.round(((junior.sharePrice - 1) * 271.5 * 100 * 10) / 12) / 10);
    expect(junior).toMatchObject({ minSharePct: 20, lockEpochs: 10 });
    // Open advances: Northwind (30), Saltmarsh (20), Quarry (7). Marigold recovered, Basalt repaid.
    expect(junior.bondsUnderOpenAdvancesSol).toBe(57);

    expect(vault.params).toHaveLength(17);
    expect(vault.params[0]).toEqual({
      name: 'Senior target',
      display: '0.03% / epoch',
      field: 'senior_rate_bps_per_epoch',
      value: 3,
    });
    expect(vault.params.find((p) => p.field === 'max_pool_assets')).toMatchObject({
      display: '5,000 SOL',
      value: 5_000_000_000_000,
    });
    expect(vault.params.find((p) => p.field === 'advance_bps_unhedged / _hedged')).toMatchObject({
      display: '25% · 40% hedged',
      value: null,
    });
  });

  it('counts coupon-met epochs exactly as distribute_income paid them', async () => {
    const sim = world();
    const vault = await new VaultService(fakeDeps(sim, await sim.store())).snapshot();
    const truth = sim.accruals;
    const metEpochs = truth.filter((a) => a.couponMet).reduce((n, a) => n + a.epochs, 0);
    const allEpochs = truth.reduce((n, a) => n + a.epochs, 0);
    // The world has both: early epochs without fee income miss the target; later ones meet it.
    expect(metEpochs).toBeGreaterThan(0);
    expect(metEpochs).toBeLessThan(allEpochs);
    expect(allEpochs).toBe(12); // 1033–1044; the 1040 accrual covers 1039 too
    expect(vault.tranches.senior).toMatchObject({ couponMetEpochs: metEpochs, couponEpochsSinceLaunch: allEpochs });
  });

  it('replays the share-price and lent-out series from events when pool_snapshots is empty', async () => {
    const sim = world();
    const vault = await new VaultService(fakeDeps(sim, await sim.store())).snapshot();
    const accrued = sim.stored.filter((e) => e.name === 'Accrued');
    expect(vault.series.epochs).toEqual(sim.accruals.map((a) => a.epoch));
    expect(vault.series.epochs).not.toContain(1039);
    expect(vault.series.seniorSharePrice).toEqual(
      accrued.map((e) => sharePriceE9ToSol(BigInt(e.data.seniorPriceE9 as string))),
    );
    // Lent out right after each accrual, walked back from today's Pool: matches the ledger at the time.
    vault.series.lentOutPct.forEach((pct, i) => {
      expect(Math.abs(pct - sim.accruals[i].utilizationBps / 100)).toBeLessThanOrEqual(0.011);
    });
    expect(Math.max(...vault.series.lentOutPct)).toBeGreaterThan(5);
    const lengths = Object.values(vault.series).map((list) => list.length);
    expect(new Set(lengths)).toEqual(new Set([sim.accruals.length]));
  });

  it('uses pool_snapshots when the recorder has rows', async () => {
    const sim = world();
    const history = {
      recent: async () => [
        { epoch: 1043, seniorPriceE9: 1_000_300n, juniorPriceE9: 1_000_080n, utilizationBps: 1_160 },
        { epoch: 1044, seniorPriceE9: 1_000_600n, juniorPriceE9: 1_000_510n, utilizationBps: 1_234 },
      ],
    };
    const vault = await new VaultService(fakeDeps(sim, await sim.store(), { history })).snapshot();
    expect(vault.series).toEqual({
      epochs: [1043, 1044],
      seniorSharePrice: [1.0003, 1.0006],
      juniorSharePrice: [1.00008, 1.00051],
      // First point from par over the 11 epochs since launch; then 0.043% in one epoch × 271.5.
      juniorYieldPctPerYear: [0.2, 11.7],
      lentOutPct: [11.6, 12.34],
    });
  });

  it('lists the loan book: open advances first by size, then the newest closed', async () => {
    const sim = world();
    const vault = await new VaultService(fakeDeps(sim, await sim.store(), { rows: ROWS })).snapshot();
    expect(vault.advances.map((a) => [a.validator, a.status])).toEqual([
      ['Northwind Staking', 'active'],
      ['Saltmarsh Nodes', 'active'],
      [`${V.quarry.slice(0, 4)}…${V.quarry.slice(-4)}`, 'late'],
      [`${V.marigold.slice(0, 4)}…${V.marigold.slice(-4)}`, 'recovered'],
      [`${V.basalt.slice(0, 4)}…${V.basalt.slice(-4)}`, 'repaid'],
    ]);
    const [northwind, saltmarsh, quarry, marigold, basalt] = vault.advances;
    expect(northwind).toMatchObject({
      vote: V.northwind,
      hedged: false,
      limitRatePct: 25,
      score: 84,
      borrowedSol: 120,
      owesSol: 122.4,
      repaidSol: 30, // 50% of 20 SOL in 1042, 1043 and 1044
      bondSol: 30,
      epochsOpen: 3,
      lateEpochs: null,
      note: null,
    });
    expect(saltmarsh).toMatchObject({ hedged: true, limitRatePct: 40, score: 91 });
    expect(quarry).toMatchObject({ lateEpochs: 1, note: 'Late 1 epoch: revenue stopped' });
    expect(marigold).toMatchObject({ epochsOpen: 6, note: 'Recovered: bond applied, the rest from sweeps' });
    expect(marigold.repaidSol).toBe(marigold.owesSol);
    expect(basalt).toMatchObject({ borrowedSol: 6, owesSol: 6.12, repaidSol: 6.12, epochsOpen: 2, note: null });

    const stress = vault.openAdvancesForStressTest;
    expect(stress.map((s) => s.validator)).toEqual(['Northwind Staking', 'Saltmarsh Nodes', quarry.validator]);
    const nw = sim.advanceMap.get(key(`advance:${V.northwind}:0`).toBase58())!;
    expect(stress[0]).toEqual({
      validator: 'Northwind Staking',
      outstandingPrincipalSol: Number(nw.principal - nw.principalRepaid) / 1e9,
      bondSol: 30,
    });
  });

  it('shows the queue newest first: queued, paid in the last 20 epochs; never cancelled or bounced', async () => {
    const sim = world();
    const pool = sim.poolState!;
    const vault = await new VaultService(fakeDeps(sim, await sim.store())).snapshot(YOU);
    const requested = (seq: number) =>
      sim.stored.find((e) => e.name === 'WithdrawRequested' && e.data.seq === String(seq))!;
    const mine = sim.requestMap.get(3n)!;
    expect(vault.withdrawQueue).toEqual([
      {
        id: 3,
        tranche: 'senior',
        sol: Number(sharesToAssets(mine.shares, pool.seniorAssets, pool.seniorShares)) / 1e9,
        askedEpoch: 1044,
        status: 'queued',
        paidEpoch: null,
        signature: requested(3).signature,
        isMine: true,
      },
      {
        id: 1,
        tranche: 'junior',
        sol:
          Number(
            BigInt(sim.stored.find((e) => e.name === 'WithdrawProcessed' && e.data.seq === '1')!.data.assets as string),
          ) / 1e9,
        askedEpoch: 1043,
        status: 'paid',
        paidEpoch: 1044,
        signature: requested(1).signature,
        isMine: false,
      },
      expect.objectContaining({ id: 0, tranche: 'senior', askedEpoch: 1042, paidEpoch: 1043, status: 'paid' }),
    ]);
  });

  it('lists the five biggest wallets per tranche, the session wallet as You, then the rest grouped', async () => {
    const sim = world();
    const vault = await new VaultService(fakeDeps(sim, await sim.store())).snapshot(YOU);
    const rows = vault.lenders.map((l) => [l.tranche, l.label, l.walletShort]);
    const short = (label: string) => `${W(label).slice(0, 4)}…${W(label).slice(-4)}`;
    // j8 put 5 SOL in after the 1040 default had cut the junior price below par: more shares than j4–j7.
    expect(rows).toEqual([
      ['junior', null, short('fund')],
      ['junior', null, short('j3')],
      ['junior', null, short('j8')],
      ['junior', null, short('j4')],
      ['junior', null, short('j5')],
      ['junior', '2 other wallets', null],
      ['senior', null, short('s0')],
      ['senior', null, short('s1')],
      ['senior', null, short('s3')],
      ['senior', null, short('s4')],
      ['senior', null, short('s5')],
      ['senior', 'You', short('you')],
      ['senior', '2 other wallets', null],
    ]);
    expect(vault.lenders[0]).toMatchObject({ sinceEpoch: 1033, untilEpoch: null }); // fund: its lock ended in 1043
    expect(vault.lenders[2]).toMatchObject({ sinceEpoch: 1040, untilEpoch: 1050 }); // j8: locked 10 epochs
    expect(vault.lenders[5]).toMatchObject({ sinceEpoch: 1033, untilEpoch: null }); // j6, j7
    const juniorPct = vault.lenders.filter((l) => l.tranche === 'junior').reduce((t, l) => t + l.shareOfTranchePct, 0);
    expect(juniorPct).toBeCloseTo(100, 1);
  });

  it("shows this epoch's crank cycle", async () => {
    const sim = world();
    const vault = await new VaultService(fakeDeps(sim, await sim.store())).snapshot();
    // Swept and accrued in 1044; the session wallet's request at the head is payable; no Fee Index yet.
    expect(vault.cycle?.steps.map((s) => [s.key, s.status])).toEqual([
      ['collecting', 'done'],
      ['rewards', 'done'],
      ['sweeps', 'done'],
      ['accrue', 'done'],
      ['withdrawals', 'running'],
      ['index', 'next'],
    ]);
    expect(vault.cycle?.steps[5].label).toBe('Fee Index posted');
  });

  it('answers 503 until the program and its Pool exist', async () => {
    const sim = new ProgramSim(1040);
    await expect(new VaultService(fakeDeps(sim, await sim.store())).snapshot()).rejects.toMatchObject({
      code: 'POOL_NOT_INITIALIZED',
      statusCode: 503,
    });
    sim.configured = false;
    await expect(new VaultService(fakeDeps(sim, await sim.store())).snapshot()).rejects.toMatchObject({
      code: 'PROGRAM_NOT_CONFIGURED',
    });
  });

  it('keeps answering with short keys and 271.5 epochs a year when the mainnet table is down', async () => {
    const sim = world();
    const vault = await new VaultService(fakeDeps(sim, await sim.store(), { directoryDown: true })).snapshot();
    expect(vault.advances[0].validator).toBe(`${V.northwind.slice(0, 4)}…${V.northwind.slice(-4)}`);
    expect(vault.tranches.senior.apyPct).toBe(8.1);
  });
});

// ── The pure rules, with the kit's fixture numbers ─────────────────────────────────────────────

const poolWith = (over: Partial<PoolAccount>): PoolAccount => {
  const sim = new ProgramSim(1044);
  sim.initialize({ ...PLANNED_POOL_PARAMS });
  return { ...sim.poolState!, ...over };
};

describe('roomBeforeJuniorMustGrow', () => {
  it('is junior × (10,000 − min) ÷ min − senior: 509 junior, 1,124 senior, 20% → 912 SOL (VA7)', () => {
    expect(roomBeforeJuniorMustGrow(poolWith({ juniorAssets: sol(509), seniorAssets: sol(1124) }))).toBe(912);
    expect(roomBeforeJuniorMustGrow(poolWith({ juniorAssets: sol(100), seniorAssets: sol(1124) }))).toBe(0);
  });

  it('is null when the junior floor is off', () => {
    const pool = poolWith({ juniorAssets: sol(509), seniorAssets: sol(1124) });
    expect(roomBeforeJuniorMustGrow({ ...pool, params: { ...pool.params, minJuniorBps: 0 } })).toBeNull();
  });
});

describe('couponRecord', () => {
  const accrual = (epoch: number, seniorPriceE9: bigint, juniorGain = 0n): Accrual => ({
    slot: epoch * 432_000 + 100,
    epoch,
    seniorGain: 0n,
    juniorGain,
    seniorPriceE9,
    juniorPriceE9: PAR_PRICE_E9,
  });

  it('meets the target when junior gained, or when the senior price grew by rate × epochs', () => {
    const accruals = [
      accrual(10, 1_000_300n), // +3 bps from par
      accrual(11, 1_000_300n, 5n), // flat price but junior gained: senior was paid in full
      accrual(13, 1_000_900n), // two epochs, +6 bps
      accrual(14, 1_001_000n), // +1 bp: missed
    ];
    expect(couponRecord(accruals, 3, true, 0)).toEqual({ met: 4, epochs: 5 });
  });

  it('allows two units of price rounding', () => {
    expect(couponRecord([accrual(10, 1_000_298n)], 3, true, 0)).toEqual({ met: 1, epochs: 1 });
    expect(couponRecord([accrual(10, 1_000_297n)], 3, true, 0)).toEqual({ met: 0, epochs: 1 });
  });

  it('skips accruals before the first senior deposit, and uses the oldest stored one as a baseline only', () => {
    const accruals = [accrual(10, PAR_PRICE_E9), accrual(11, 1_000_300n)];
    expect(couponRecord(accruals, 3, true, 11 * 432_000)).toEqual({ met: 1, epochs: 1 });
    expect(couponRecord(accruals, 3, true, null)).toEqual({ met: 0, epochs: 0 });
    expect(couponRecord([accrual(10, 1_000_300n), accrual(11, 1_000_600n)], 3, false, null)).toEqual({
      met: 1,
      epochs: 1,
    });
  });
});

describe('seriesFromPoints', () => {
  it("annualises junior growth per epoch (the fixture's first points: 1.00008 → 2.2%, 1.00051 → 11.7%)", () => {
    const series = seriesFromPoints(
      [
        { epoch: 1033, seniorPriceE9: 1_000_300n, juniorPriceE9: 1_000_080n, lentOutPct: 2.1 },
        { epoch: 1034, seniorPriceE9: 1_000_600n, juniorPriceE9: 1_000_510n, lentOutPct: 3.4 },
      ],
      271.5,
      1033,
    );
    expect(series.juniorYieldPctPerYear).toEqual([2.2, 11.7]);
    expect(series.lentOutPct).toEqual([2.1, 3.4]);
  });
});

describe('cycleSteps and withdrawalsDone', () => {
  const base = {
    epoch: 1044,
    slotIndex: 10_000,
    rewardsActive: false as boolean | null,
    positions: [],
    pool: poolWith({ lastAccruedEpoch: 1044n }),
    requests: [],
    feeIndex: null,
  };
  const statuses = (input: Parameters<typeof cycleSteps>[0]) => cycleSteps(input).map((s) => s.status);

  it('runs the first boundary step not done yet', () => {
    expect(statuses({ ...base, rewardsActive: true })).toEqual(['done', 'running', 'next', 'next', 'next', 'next']);
    // No sysvar: rewards count as paid after 4,000 slots.
    expect(statuses({ ...base, rewardsActive: null, slotIndex: 3_000 })[1]).toBe('running');
    expect(statuses({ ...base, rewardsActive: null, slotIndex: 5_000 })[1]).toBe('done');
    expect(statuses({ ...base, pool: poolWith({ lastAccruedEpoch: 1043n }) })).toEqual([
      'done',
      'done',
      'done',
      'running',
      'next',
      'next',
    ]);
  });

  it('is collecting again once every boundary step is done (a proposal for E − 1 counts as posted)', () => {
    const sim = new ProgramSim(1044);
    sim.initializeIndex();
    sim.postIndex(1043, 1_330n);
    expect(statuses({ ...base, feeIndex: sim.feeIndexAccount })).toEqual([
      'running',
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('treats a head request waiting for cash as done, and a payable, cancelled or bouncing one as not', () => {
    const request = {
      pool: key('pool'),
      owner: key('w'),
      tranche: 'senior' as const,
      shares: sol(10) * 1_000n,
      seq: 0n,
      requestedEpoch: 1044n,
      cancelled: false,
      bump: 1,
    };
    const pool = poolWith({
      seniorAssets: sol(100),
      seniorShares: sol(100) * 1_000n,
      juniorAssets: sol(30),
      juniorShares: sol(30) * 1_000n,
      withdrawHead: 0n,
      withdrawTail: 1n,
      cash: sol(5),
    });
    expect(withdrawalsDone(pool, [request])).toBe(true); // 10 SOL owed, 5 SOL of cash
    expect(withdrawalsDone({ ...pool, cash: sol(50) }, [request])).toBe(false);
    expect(withdrawalsDone(pool, [{ ...request, cancelled: true }])).toBe(false);
    const junior = { ...request, tranche: 'junior' as const, shares: sol(20) * 1_000n };
    expect(withdrawalsDone(pool, [junior])).toBe(false); // would take junior to 10 / 110 < 20%: bounces
    expect(withdrawalsDone({ ...pool, withdrawHead: 1n }, [])).toBe(true);
  });
});
