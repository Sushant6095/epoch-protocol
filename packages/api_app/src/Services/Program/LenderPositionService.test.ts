import { rawSharesToUi, sharesToAssets } from '@epoch/epoch-sdk';

import { fakeDeps } from '../../__fixtures__/ProgramFakes';
import { key, ProgramSim, sol } from '../../__fixtures__/ProgramSim';
import { LenderPositionService } from './LenderPositionService';

const W = (label: string): string => key(label).toBase58();
const ME = W('me');

/** A wallet with a queued senior request, a junior request the crank bounced at the floor, and a fresh junior lock. */
function world(): ProgramSim {
  const sim = new ProgramSim(1100);
  sim.initialize();
  sim.deposit(W('fund'), 'junior', sol(60));
  sim.deposit(ME, 'junior', sol(20));
  sim.deposit(W('retail'), 'senior', sol(300));
  sim.deposit(ME, 'senior', sol(10));
  sim.nextEpoch(); // 1101
  sim.requestWithdraw(W('retail'), 'senior', sim.lender(W('retail'), 'senior')!.shares / 10n); // seq 0
  sim.nextEpoch(); // 1102
  expect(sim.processWithdrawal()).toBe('paid');
  sim.nextEpoch(8); // 1110: my junior lock (1100 + 10) is over
  sim.requestWithdraw(ME, 'junior', sim.lender(ME, 'junior')!.shares); // seq 1: 20 of 80 junior → under 20%
  expect(sim.processWithdrawal()).toBe('bounced');
  sim.requestWithdraw(ME, 'senior', sim.lender(ME, 'senior')!.shares / 2n); // seq 2, queued
  sim.nextEpoch(); // 1111
  sim.cancelWithdraw(sim.requestWithdraw(ME, 'senior', sol(1) * 1_000n)); // seq 3, cancelled by me
  sim.requestWithdraw(W('fund'), 'junior', sol(1) * 1_000n); // seq 4, someone else's
  sim.nextEpoch(); // 1112
  sim.deposit(ME, 'junior', sol(5)); // locks junior again until 1122
  sim.nextEpoch(); // 1113
  return sim;
}

describe('LenderPositionService', () => {
  it("lists the wallet's tranches, its queued request and the one bounced at the junior floor", async () => {
    const sim = world();
    const pool = sim.poolState!;
    const position = await new LenderPositionService(fakeDeps(sim, await sim.store())).lender(ME);
    const senior = sim.lender(ME, 'senior')!;
    const junior = sim.lender(ME, 'junior')!;
    const requested = (seq: number) =>
      sim.stored.find((e) => e.name === 'WithdrawRequested' && e.data.seq === String(seq))!;

    expect(position).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      asOf: '2026-10-03T10:00:00+05:30',
      owner: ME,
    });
    expect(position.tranches).toEqual([
      {
        tranche: 'senior',
        shares: rawSharesToUi(senior.shares),
        valueSol: Number(sharesToAssets(senior.shares, pool.seniorAssets, pool.seniorShares)) / 1e9,
        depositEpoch: 1100,
        lockedUntilEpoch: null,
      },
      {
        tranche: 'junior',
        shares: rawSharesToUi(junior.shares),
        valueSol: Number(sharesToAssets(junior.shares, pool.juniorAssets, pool.juniorShares)) / 1e9,
        depositEpoch: 1112,
        lockedUntilEpoch: 1122,
      },
    ]);
    // The bounced 20 SOL are back in the wallet's junior shares (with the 5 SOL deposited later).
    expect(position.tranches[1].valueSol).toBeCloseTo(25, 6);

    const queued = sim.requestMap.get(2n)!;
    const bouncedShares = BigInt(requested(1).data.shares as string);
    expect(position.withdrawRequests).toEqual([
      {
        id: 2,
        tranche: 'senior',
        shares: rawSharesToUi(queued.shares),
        sol: Number(sharesToAssets(queued.shares, pool.seniorAssets, pool.seniorShares)) / 1e9,
        askedEpoch: 1110,
        signature: requested(2).signature,
        status: 'queued',
      },
      {
        id: 1,
        tranche: 'junior',
        shares: rawSharesToUi(bouncedShares),
        sol: Number(sharesToAssets(bouncedShares, pool.juniorAssets, pool.juniorShares)) / 1e9,
        askedEpoch: 1110,
        signature: requested(1).signature,
        status: 'bounced',
      },
    ]);
  });

  it('drops a bounce after 30 program epochs and answers empty for a wallet that never lent', async () => {
    const sim = world();
    sim.nextEpoch(28); // 1141: the 1110 bounce is 31 epochs old
    const service = new LenderPositionService(fakeDeps(sim, await sim.store()));
    expect((await service.lender(ME)).withdrawRequests.map((r) => r.status)).toEqual(['queued']);
    expect(await service.lender(W('stranger'))).toMatchObject({ tranches: [], withdrawRequests: [] });
  });

  it('answers 503 until the Pool exists', async () => {
    const sim = new ProgramSim(1100);
    await expect(new LenderPositionService(fakeDeps(sim, await sim.store())).lender(ME)).rejects.toMatchObject({
      code: 'POOL_NOT_INITIALIZED',
      statusCode: 503,
    });
  });
});
