import { ProgramSim } from '../../__fixtures__/ProgramSim';
import { buildFeeIndexView, loadFeeIndexView } from './FeeIndexView';

/** Finalizes 1,000 + epoch for every epoch in [from, to]. */
function finalized(sim: ProgramSim, from: number, to: number): void {
  for (let epoch = from; epoch <= to; epoch++) {
    sim.postIndex(epoch, BigInt(1_000 + epoch));
    sim.finalizeIndex();
  }
}

describe('FeeIndexView', () => {
  it('answers final values from the account, older ones from IndexFinalized events, then the proposal', async () => {
    const sim = new ProgramSim(1100);
    sim.initializeIndex();
    finalized(sim, 1070, 1099); // 30 finals: the account keeps the last + 16 in history
    sim.postIndex(1100, 2_150n);
    const view = await loadFeeIndexView(sim, await sim.store());

    expect(view.final).toEqual({ epoch: 1099, value: 2_099 });
    expect(view.proposed).toEqual({
      epoch: 1100,
      value: 2_150,
      disputeEndsSlot: Number(sim.feeIndexAccount!.proposedSlot + sim.feeIndexAccount!.disputeWindowSlots),
    });
    expect(view.avg8).toBe(2_095.5); // 2,092 … 2,099
    expect(view.valueFor(1099)).toEqual({ value: 2_099, status: 'final' });
    expect(view.valueFor(1083)).toEqual({ value: 2_083, status: 'final' }); // in the account's history
    expect(view.valueFor(1070)).toEqual({ value: 2_070, status: 'final' }); // only in events now
    expect(view.valueFor(1100)).toEqual({ value: 2_150, status: 'proposed' });
    expect(view.valueFor(1101)).toBeNull();
  });

  it('keeps a vetoed proposal visible until a newer one is posted for that epoch', async () => {
    const sim = new ProgramSim(1100);
    sim.initializeIndex();
    finalized(sim, 1098, 1098);
    sim.postIndex(1099, 2_600n);
    sim.vetoIndex();
    let view = await loadFeeIndexView(sim, await sim.store());
    expect(view.proposed).toBeNull();
    expect(view.valueFor(1099)).toEqual({ value: 2_600, status: 'vetoed' });

    sim.postIndex(1099, 2_100n);
    view = await loadFeeIndexView(sim, await sim.store());
    expect(view.valueFor(1099)).toEqual({ value: 2_100, status: 'proposed' });
    sim.finalizeIndex();
    view = await loadFeeIndexView(sim, await sim.store());
    expect(view.valueFor(1099)).toEqual({ value: 2_100, status: 'final' });
  });

  it('is empty before initialize_index or the first final value', () => {
    expect(buildFeeIndexView(null, [], [])).toMatchObject({ final: null, proposed: null, avg8: null });
    const sim = new ProgramSim(1100);
    sim.initializeIndex();
    const view = buildFeeIndexView(sim.feeIndexAccount, [], []);
    expect(view.final).toBeNull();
    expect(view.valueFor(0)).toBeNull(); // epoch 0 with finalized_slot 0 is not a value
  });
});
