import { fakeDeps, validatorRow } from '../../__fixtures__/ProgramFakes';
import { key, ProgramSim, SLOTS_PER_EPOCH, sol } from '../../__fixtures__/ProgramSim';
import { FeeMarketService, MAKER_LABEL, quoteStatus, swapPnlLamports } from './FeeMarketService';
import { toSol } from './ProgramFormat';

const W = (label: string): string => key(label).toBase58();
const MAKER = W('epoch-maker');
const STRANGER = W('stranger-maker');
const YOU = W('fernhill-operator');
const V = { fernhill: W('vote:fernhill'), saltmarsh: W('vote:saltmarsh'), kestrel: W('vote:kestrel') };
const OPS = { saltmarsh: W('op:saltmarsh'), kestrel: W('op:kestrel') };
const FIXED: Record<number, number> = {
  1040: 1250,
  1042: 1270,
  1043: 1280,
  1044: 1290,
  1045: 1295,
  1046: 1300,
  1047: 1305,
  1048: 1310,
  1049: 1315,
};
const FINAL: Record<number, number> = {
  1033: 1200,
  1034: 1210,
  1035: 1220,
  1036: 1230,
  1037: 1240,
  1038: 1250,
  1039: 1260,
  1040: 1240,
  1041: 1250,
  1042: 1284,
};

/** fee-market.sample.json, played through the program: epoch 1044, 1043 proposed at 1,330, 1042 final at 1,284. */
function world(): { sim: ProgramSim; quote: (epoch: number) => string } {
  const sim = new ProgramSim(1030);
  sim.marketMaker = key('epoch-maker');
  sim.initialize();
  sim.initializeIndex();
  sim.onboard(V.fernhill, YOU, { score: 7_900 });
  sim.onboard(V.saltmarsh, OPS.saltmarsh, { score: 9_100 });
  sim.onboard(V.kestrel, OPS.kestrel, { score: 8_800 });
  const quotes = new Map<number, string>();
  const quote = (epoch: number): string => quotes.get(epoch)!;
  const post = (epoch: number) => quotes.set(epoch, sim.postQuote(MAKER, epoch, BigInt(FIXED[epoch]), sol(50)));
  const swap = (who: string, epoch: number, notional: number, side: 'payFixed' | 'receiveFixed' = 'receiveFixed') =>
    sim.openSwap(who, quote(epoch), sol(notional), side);
  const settleAll = (epoch: number) => {
    for (const [address, s] of sim.swapMap) if (Number(s.epoch) === epoch) sim.settleSwap(address);
  };

  for (let epoch = 1031; epoch <= 1044; epoch++) {
    sim.nextEpoch();
    sim.sweep(V.fernhill, sol(18));
    sim.sweep(V.saltmarsh, sol(29.4));
    sim.sweep(V.kestrel, sol(20.8));
    if (FINAL[epoch - 1]) {
      sim.postIndex(epoch - 1, BigInt(FINAL[epoch - 1]));
      sim.finalizeIndex();
    }
    if (epoch === 1036) {
      post(1040);
      swap(W('taker-a'), 1040, 5, 'payFixed');
      swap(W('taker-b'), 1040, 3);
    }
    if (epoch === 1037) post(1042);
    if (epoch === 1038) post(1043);
    if (epoch === 1039) {
      post(1044);
      swap(YOU, 1042, 2, 'payFixed');
      swap(W('t1'), 1042, 10);
      swap(W('t2'), 1042, 12, 'payFixed');
      swap(W('t3'), 1042, 9.5);
      swap(YOU, 1043, 3);
      for (const [i, n] of [10, 10, 8, 6.5].entries()) swap(W(`u${i}`), 1043, n, i % 2 ? 'payFixed' : 'receiveFixed');
      for (const [i, n] of [10, 10, 10, 5, 4.5].entries()) swap(W(`v${i}`), 1044, n);
    }
    if (epoch === 1041) {
      settleAll(1040);
      sim.withdrawQuote(quote(1040)); // closed: rebuilt from its events from now on
    }
    if (epoch === 1043) settleAll(1042);
    if (epoch === 1044) {
      sim.postIndex(1043, 1_330n); // in its dispute window
      for (const e of [1045, 1046, 1047, 1048, 1049]) {
        post(e);
        swap(OPS.saltmarsh, e, 15);
        swap(OPS.kestrel, e, 10.5);
      }
      swap(YOU, 1045, 9);
      swap(YOU, 1046, 9);
      swap(W('7xKX'), 1045, 4, 'payFixed');
      // post_quote is open to any key: a stranger's quote and its swap must never show as Epoch's.
      const foreign = sim.postQuote(STRANGER, 1047, 900n, sol(500));
      sim.openSwap(W('taker-z'), foreign, sol(100), 'payFixed');
      sim.setScore(V.saltmarsh, 9_100, true);
      sim.setScore(V.kestrel, 8_800, true);
    }
  }
  return { sim, quote };
}

const ROWS = [
  validatorRow({ name: 'Saltmarsh Nodes', vote: V.saltmarsh }),
  validatorRow({ name: 'Fernhill Validator', vote: V.fernhill }),
];

describe('FeeMarketService.snapshot', () => {
  it("lists Epoch's quotes oldest first with their status, index and settlements", async () => {
    const { sim, quote } = world();
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store(), { rows: ROWS })).snapshot(YOU);
    expect(market).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      source: 'Epoch program on devnet: FeeQuote, SwapPosition, FeeIndex accounts and swap events',
      network: 'devnet',
      currentEpoch: 1044,
    });
    expect(market.note).toBeUndefined();
    expect(market.index).toEqual({
      finalEpoch: 1042,
      finalValue: 1284,
      proposed: { epoch: 1043, value: 1330, disputeEndsSlot: Number(sim.feeIndexAccount!.proposedSlot) + 1_000 },
      avg8: 1246.8, // 1035–1042
    });
    expect(market.quotes.map((q) => [q.epoch, q.status, q.index?.status ?? null, q.swaps, q.openSwaps])).toEqual([
      [1040, 'settled', 'final', 2, 0],
      [1042, 'settled', 'final', 4, 0],
      [1043, 'settling', 'proposed', 5, 5],
      [1044, 'live', null, 5, 5],
      [1045, 'open', null, 4, 4],
      [1046, 'open', null, 3, 3],
      [1047, 'open', null, 2, 2],
      [1048, 'open', null, 2, 2],
      [1049, 'open', null, 2, 2],
    ]);
    expect(market.quotes.every((q) => q.maker === MAKER && q.makerLabel === MAKER_LABEL)).toBe(true);

    // Closed by the maker after settling: rebuilt from QuotePosted, SwapOpened and SwapSettled.
    // Final 1,240 vs fixed 1,250: Pay fixed 5 SOL loses 0.04, Receive fixed 3 SOL gains 0.024.
    expect(market.quotes[0]).toEqual({
      address: quote(1040),
      maker: MAKER,
      makerLabel: MAKER_LABEL,
      epoch: 1040,
      fixedRate: 1250,
      maxNotionalSol: 50,
      filledNotionalSol: 8,
      maxMoveBps: 2000,
      expirySlot: 1040 * SLOTS_PER_EPOCH,
      epochStartSlot: 1040 * SLOTS_PER_EPOCH,
      makerCollateralSol: 10.016,
      lockedCollateralSol: 0,
      openSwaps: 0,
      swaps: 2,
      status: 'settled',
      index: { value: 1240, status: 'final' },
      netToTakersSol: -0.016,
    });
    expect(market.quotes[2]).toMatchObject({
      fixedRate: 1280,
      filledNotionalSol: 37.5,
      makerCollateralSol: 10,
      lockedCollateralSol: 7.5,
      index: { value: 1330, status: 'proposed' },
      netToTakersSol: null,
    });
    expect(market.quotes[4]).toMatchObject({ epoch: 1045, fixedRate: 1295, filledNotionalSol: 38.5 });
  });

  it("matches the fixture's stats: 226.5 SOL open over 23 swaps, 2 hedged validators, 1042 settled last", async () => {
    const { sim } = world();
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store(), { rows: ROWS })).snapshot();
    const settled1042 = sim.stored
      .filter((e) => e.name === 'SwapSettled' && e.data.epoch === '1042')
      .reduce((total, e) => total + BigInt(e.data.takerPnl as string), 0n);
    expect(market.stats).toEqual({
      openInterestSol: 226.5,
      openSwaps: 23,
      hedgedValidators: 2,
      lastSettled: { epoch: 1042, swaps: 4, notionalSol: 33.5, netToTakersSol: toSol(settled1042) },
    });
    expect(market.hedgeRule).toEqual({
      epochsAhead: 5,
      minNotionalShareOfRevenuePct: 50,
      text:
        'A validator counts as hedged while it holds Receive-fixed swaps on each of the next 5 epochs, each at least ' +
        "half its average revenue per epoch. Hedged validators borrow up to 40% of 10 epochs' swept revenue instead of 25%.",
    });
  });

  it('gives the signed-in operator its hedge and its swaps, open and settled (Fernhill in the fixture)', async () => {
    const { sim, quote } = world();
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store(), { rows: ROWS })).snapshot(YOU);
    expect(market.myHedge).toEqual({
      vote: V.fernhill,
      name: 'Fernhill Validator',
      averageRevenuePerEpochSol: 18,
      minNotionalSol: 9,
      hedgedEpochs: [1045, 1046],
      epochsToHedge: [1047, 1048, 1049],
    });
    expect(market.myPositions.map((p) => [p.epoch, p.side, p.notionalSol, p.status, p.pnlSol])).toEqual([
      [1046, 'receiveFixed', 9, 'open', null],
      [1045, 'receiveFixed', 9, 'open', null],
      // 3 SOL × (1,330 − 1,280) ÷ 1,280, flipped: an estimate from the proposed value.
      [1043, 'receiveFixed', 3, 'settling', -0.1171875],
      // 2 SOL × (1,284 − 1,270) ÷ 1,270, truncated to the lamport like taker_pnl.
      [1042, 'payFixed', 2, 'settled', 0.022047244],
    ]);
    const [, , settling, settled] = market.myPositions;
    expect(settling).toMatchObject({
      quote: quote(1043),
      fixedRate: 1280,
      maxMoveBps: 2000,
      collateralSol: 0.6,
      index: { value: 1330, status: 'proposed' },
      settledSignature: null,
    });
    expect(settling.openedSignature).toMatch(/^sig-/);
    expect(settled).toMatchObject({
      quote: quote(1042),
      collateralSol: 0.4,
      maxMoveBps: 2000,
      index: { value: 1284, status: 'final' },
    });
    expect(settled.openedSignature).toMatch(/^sig-/);
    expect(settled.settledSignature).toMatch(/^sig-/);
  });

  it('shows the last 30 swaps on Epoch quotes, newest first, with names for operators and "You"', async () => {
    const { sim } = world();
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store(), { rows: ROWS })).snapshot(YOU);
    expect(market.recentSwaps).toHaveLength(29); // the stranger's swap is not Epoch's
    expect(market.recentSwaps.slice(0, 4).map((s) => [s.epoch, s.side, s.notionalSol, s.who, s.vote])).toEqual([
      [1045, 'payFixed', 4, `${W('7xKX').slice(0, 4)}…${W('7xKX').slice(-4)}`, null],
      [1046, 'receiveFixed', 9, 'You', null],
      [1045, 'receiveFixed', 9, 'You', null],
      [1049, 'receiveFixed', 10.5, `${V.kestrel.slice(0, 4)}…${V.kestrel.slice(-4)}`, V.kestrel],
    ]);
    expect(market.recentSwaps[4]).toMatchObject({ who: 'Saltmarsh Nodes', vote: V.saltmarsh, status: 'open' });
    const settled = market.recentSwaps.find((s) => s.epoch === 1042 && s.who === 'You');
    expect(settled).toMatchObject({ status: 'settled', pnlSol: 0.022047244 });
    expect(market.recentSwaps.every((s) => s.signature?.startsWith('sig-'))).toBe(true);
  });

  it('answers without a session: no hedge, no positions', async () => {
    const { sim } = world();
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store())).snapshot();
    expect(market.myHedge).toBeNull();
    expect(market.myPositions).toEqual([]);
    expect(market.recentSwaps.some((s) => s.who === 'You')).toBe(false);
  });

  it("lists no quote and says why when EPOCH_MARKET_MAKER isn't set", async () => {
    const { sim } = world();
    sim.marketMaker = undefined;
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store())).snapshot(YOU);
    expect(market.quotes).toEqual([]);
    expect(market.recentSwaps).toEqual([]);
    expect(market.myPositions).toEqual([]);
    expect(market.stats).toMatchObject({ openInterestSol: 0, openSwaps: 0, hedgedValidators: 2, lastSettled: null });
    expect(market.note).toContain('EPOCH_MARKET_MAKER');
  });

  it('has null index figures before the first final value', async () => {
    const sim = new ProgramSim(1100);
    sim.marketMaker = key('epoch-maker');
    sim.initialize();
    const market = await new FeeMarketService(fakeDeps(sim, await sim.store())).snapshot();
    expect(market.index).toEqual({ finalEpoch: null, finalValue: null, proposed: null, avg8: null });
  });
});

describe('quoteStatus', () => {
  it('is open before its epoch, live during it (or once trading closed early), then settling or settled', () => {
    expect(quoteStatus(1045, 1045 * SLOTS_PER_EPOCH, 3, 1044, 1044 * SLOTS_PER_EPOCH + 10)).toBe('open');
    expect(quoteStatus(1045, 1044 * SLOTS_PER_EPOCH, 3, 1044, 1044 * SLOTS_PER_EPOCH + 10)).toBe('live');
    expect(quoteStatus(1044, 1044 * SLOTS_PER_EPOCH, 5, 1044, 0)).toBe('live');
    expect(quoteStatus(1043, null, 5, 1044, 0)).toBe('settling');
    expect(quoteStatus(1042, null, 0, 1044, 0)).toBe('settled');
  });
});

describe('swapPnlLamports (the worked example in pages/fee-market.md)', () => {
  // 5 SOL Receive fixed on epoch 1047 at 1,305 µL/CU, 20% max move. The program's index is an integer, so the half
  // values are checked at ten times the scale (the payoff only depends on index ÷ fixed).
  const pnl = (fixed: bigint, index: bigint) => toSol(swapPnlLamports('receiveFixed', sol(5), fixed, index, 2_000));

  it('locks 1.00 SOL and pays +0.50 / −0.50 / +1.00 (clipped) at −10% / +10% / −20%', () => {
    expect(toSol((sol(5) * 2_000n) / 10_000n)).toBe(1);
    expect(pnl(13_050n, 11_745n)).toBe(0.5); // 1,174.5
    expect(pnl(13_050n, 14_355n)).toBe(-0.5); // 1,435.5
    expect(pnl(1_305n, 1_044n)).toBe(1); // 1,044: exactly the clip
    expect(pnl(1_305n, 900n)).toBe(1); // lower: still clipped
    expect(pnl(1_305n, 1_305n)).toBe(0);
  });

  it("mirrors the contract's example: 10 SOL Receive fixed at 1,300 with a 20% clip", () => {
    const tenSol = (index: bigint) => toSol(swapPnlLamports('receiveFixed', sol(10), 1_300n, index, 2_000));
    expect([tenSol(1_170n), tenSol(1_430n), tenSol(1_000n)]).toEqual([1, -1, 2]);
  });
});
