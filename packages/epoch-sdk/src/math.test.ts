import { sdkEnum, vectors } from './__fixtures__/vectors';
import { U64_MAX } from './borsh';
import { type Side } from './constants';
import {
  absorbLoss,
  agreesWithin,
  assetsToShares,
  attributeRepayment,
  bpsOf,
  bpsOfCeil,
  type BuyFill,
  circulatingSupply,
  computeScore,
  creditLimit,
  type CurvePoint,
  dammCompoundingBuy,
  dammCompoundingMaxQuoteIn,
  dammConcentratedBuy,
  dammConcentratedMaxQuoteIn,
  dbcBuy,
  dbcLeftover,
  dbcMaxQuoteIn,
  dbcMigratedFeeBps,
  dbcMinBaseFeeNumerator,
  dbcPartnerMigrationFee,
  dbcPartnerPart,
  dbcPartnerSurplus,
  deltaBase,
  deltaQuote,
  deviationBps,
  distributeIncome,
  EpochMathError,
  impactTargetSqrtPrice,
  juniorRatioBps,
  maxImpactBound,
  meetsThreshold,
  minOutFloor,
  mulDiv,
  nextSqrtFromQuoteIn,
  planBuybackSlice,
  redeemPayout,
  sharePriceE9,
  sharesToAssets,
  sliceBudget,
  sliceDueSlot,
  sliceTiming,
  splitSweep,
  splitSweepWithShare,
  swapCollateral,
  takerPnl,
  tallyVotes,
  venueFeeFloorBps,
  weightedMedian,
} from './math';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

type Args = unknown[];
const big = (v: unknown): bigint => BigInt(v as string);
const num = (v: unknown): number => v as number;
const str = (v: bigint): string => v.toString();
const curveOf = (raw: unknown): CurvePoint[] =>
  (raw as { sqrt_price: string; liquidity: string }[]).map((p) => ({
    sqrtPrice: big(p.sqrt_price),
    liquidity: big(p.liquidity),
  }));
const fill = (f: BuyFill) => ({
  output: str(f.output),
  consumed: str(f.consumed),
  next_sqrt_price: str(f.nextSqrtPrice),
});
const rustVariant = (v: string | null): string | null =>
  v === null ? null : `${v.charAt(0).toUpperCase()}${v.slice(1)}`;

/** Run every Rust case; `null` results must throw EpochMathError (the program's `None`). */
function runCases(name: string, run: (args: Args) => unknown): { actual: unknown[]; expected: unknown[] } {
  const cases = vectors.math[name];
  expect(cases.length).toBeGreaterThan(10);
  const actual = cases.map((c) => {
    try {
      return run(c.args);
    } catch (error) {
      if (error instanceof EpochMathError) return null;
      throw error;
    }
  });
  return { actual, expected: cases.map((c) => c.result) };
}

const MIRRORS: Record<string, (args: Args) => unknown> = {
  bps_of: ([a, b]) => str(bpsOf(big(a), num(b))),
  bps_of_ceil: ([a, b]) => str(bpsOfCeil(big(a), num(b))),
  mul_div: ([a, b, c]) => str(mulDiv(big(a), big(b), big(c))),
  assets_to_shares: ([a, ta, ts]) => str(assetsToShares(big(a), big(ta), big(ts))),
  shares_to_assets: ([s, ta, ts]) => str(sharesToAssets(big(s), big(ta), big(ts))),
  share_price_e9: ([ta, ts]) => str(sharePriceE9(big(ta), big(ts))),
  credit_limit: ([trailing, history, bps, bond, multiplier, cap]) =>
    str(
      creditLimit({
        trailingRevenue: big(trailing),
        historyEpochs: num(history),
        advanceBps: num(bps),
        bondLamports: big(bond),
        bondMultiplier: num(multiplier),
        capLamports: big(cap),
      }),
    ),
  split_sweep: ([gross, outstanding, bps, full]) => {
    const r = splitSweep(big(gross), big(outstanding), num(bps), full as boolean);
    return { remit: str(r.remit), to_operator: str(r.toOperator) };
  },
  attribute_repayment: ([remit, p, f]) => {
    const r = attributeRepayment(big(remit), big(p), big(f));
    return [str(r.principal), str(r.fee)];
  },
  distribute_income: ([income, senior, rate, epochs, fee]) => {
    const r = distributeIncome(big(income), big(senior), num(rate), big(epochs), num(fee));
    return { protocol_fee: str(r.protocolFee), senior_gain: str(r.seniorGain), junior_gain: str(r.juniorGain) };
  },
  absorb_loss: ([loss, senior, junior]) => {
    const r = absorbLoss(big(loss), big(senior), big(junior));
    return [str(r.seniorAssets), str(r.juniorAssets), str(r.unabsorbed)];
  },
  junior_ratio_bps: ([senior, junior]) => str(juniorRatioBps(big(senior), big(junior))),
  taker_pnl: ([side, notional, fixed, index, maxLoss]) =>
    str(takerPnl(sdkEnum<Side>(side), big(notional), big(fixed), big(index), big(maxLoss))),
  compute_score: ([credits, commission, epochs, delinquent, superminority]) =>
    computeScore({
      creditsRatioBps: num(credits),
      commissionBps: num(commission),
      epochsActive: num(epochs),
      delinquent: delinquent as boolean,
      superminority: superminority as boolean,
    }),
  // Revenue tokens
  split_sweep_with_share: ([gross, share, outstanding, remit, full, senior]) => {
    const r = splitSweepWithShare(
      big(gross),
      num(share),
      big(outstanding),
      num(remit),
      full as boolean,
      senior as boolean,
    );
    return { share: str(r.share), remit: str(r.remit), to_operator: str(r.toOperator) };
  },
  slice_due_slot: ([slice, slices, window]) => {
    const r = sliceDueSlot(num(slice), num(slices), num(window));
    return r === null ? null : str(r);
  },
  slice_timing: ([slot, slice, slices, window]) =>
    rustVariant(sliceTiming(big(slot), num(slice), num(slices), num(window))),
  slice_budget: ([budget, spent, slices, done, escrow]) =>
    str(sliceBudget(big(budget), big(spent), num(slices), num(done), big(escrow))),
  redeem_payout: ([escrow, amount, circulating]) => str(redeemPayout(big(escrow), big(amount), big(circulating))),
  circulating_supply: ([supply, held]) => str(circulatingSupply(big(supply), big(held))),
  dbc_min_base_fee_numerator: ([mode, cliff, periods, reduction]) =>
    str(dbcMinBaseFeeNumerator(num(mode), big(cliff), num(periods), big(reduction))),
  dbc_migrated_fee_bps: ([option, bps, mode]) => dbcMigratedFeeBps(num(option), num(bps), num(mode)),
  venue_fee_floor_bps: ([curve, pool]) => venueFeeFloorBps(big(curve), num(pool)),
  max_impact_bound: ([floor]) => maxImpactBound(num(floor)),
  // Meteora quotes
  delta_base: ([lower, upper, l, up]) => str(deltaBase(big(lower), big(upper), big(l), up as boolean)),
  delta_quote: ([lower, upper, l, up]) => str(deltaQuote(big(lower), big(upper), big(l), up as boolean)),
  next_sqrt_from_quote_in: ([sqrt, l, amount]) => str(nextSqrtFromQuoteIn(big(sqrt), big(l), big(amount))),
  dbc_buy: ([curve, sqrt, stop, amount]) => fill(dbcBuy(curveOf(curve), big(sqrt), big(stop), big(amount))),
  dbc_max_quote_in: ([curve, sqrt, stop, target]) =>
    str(dbcMaxQuoteIn(curveOf(curve), big(sqrt), big(stop), big(target))),
  damm_concentrated_buy: ([sqrt, l, max, amount]) =>
    fill(dammConcentratedBuy(big(sqrt), big(l), big(max), big(amount))),
  damm_concentrated_max_quote_in: ([sqrt, l, max, target]) =>
    str(dammConcentratedMaxQuoteIn(big(sqrt), big(l), big(max), big(target))),
  damm_compounding_buy: ([a, b, amount]) => fill(dammCompoundingBuy(big(a), big(b), big(amount))),
  damm_compounding_max_quote_in: ([b, bps]) => str(dammCompoundingMaxQuoteIn(big(b), num(bps))),
  impact_target_sqrt_price: ([sqrt, bps]) => str(impactTargetSqrtPrice(big(sqrt), num(bps))),
  min_out_floor: ([out, bps]) => str(minOutFloor(big(out), num(bps))),
  // Treasury claims
  dbc_partner_part: ([fee, pct]) => str(dbcPartnerPart(big(fee), num(pct))),
  dbc_partner_surplus: ([reserve, threshold, pct]) => str(dbcPartnerSurplus(big(reserve), big(threshold), num(pct))),
  dbc_partner_migration_fee: ([threshold, feePct, creatorPct]) =>
    str(dbcPartnerMigrationFee(big(threshold), num(feePct), num(creatorPct))),
  dbc_leftover: ([vault, partner, protocol, creator, migration]) =>
    str(dbcLeftover(big(vault), big(partner), big(protocol), big(creator), big(migration))),
};

describe('math mirrors programs/epoch/src/math and swap.rs exactly', () => {
  it('covers every function the harness exercised', () => {
    expect(Object.keys(MIRRORS).sort()).toEqual(Object.keys(vectors.math).sort());
  });

  it.each(Object.keys(MIRRORS))('%s', (name) => {
    const { actual, expected } = runCases(name, MIRRORS[name]);
    expect(actual).toEqual(expected);
  });

  it('exercises the None paths (they must throw EpochMathError, not return)', () => {
    for (const name of [
      'bps_of',
      'mul_div',
      'assets_to_shares',
      'credit_limit',
      'distribute_income',
      'taker_pnl',
      'split_sweep_with_share',
      'slice_budget',
      'redeem_payout',
      'delta_base',
      'next_sqrt_from_quote_in',
      'damm_concentrated_buy',
      'impact_target_sqrt_price',
      'min_out_floor',
      'dbc_partner_part',
      'dbc_partner_surplus',
      'dbc_partner_migration_fee',
      'dbc_leftover',
      'dbc_min_base_fee_numerator',
      'dbc_migrated_fee_bps',
    ]) {
      expect(vectors.math[name].some((c) => c.result === null)).toBe(true);
    }
  });
});

describe('program unit-test examples', () => {
  it('waterfall', () => {
    expect(distributeIncome(10_000n, 1_000_000n, 4, 1n, 1_000)).toEqual({
      protocolFee: 1_000n,
      seniorGain: 400n,
      juniorGain: 8_600n,
    });
    expect(splitSweep(1_000n, 100n, 2_500, false)).toEqual({ remit: 100n, toOperator: 900n });
    expect(attributeRepayment(510n, 1_000n, 20n)).toEqual({ principal: 500n, fee: 10n });
    expect(absorbLoss(2_000n, 1_000n, 500n)).toEqual({ seniorAssets: 0n, juniorAssets: 0n, unabsorbed: 500n });
    expect(juniorRatioBps(0n, 0n)).toBe(10_000n);
  });

  it('taker P&L truncates toward zero and clamps', () => {
    expect(takerPnl('payFixed', 1_000_000_000n, 10_000n, 11_000n, 500_000_000n)).toBe(100_000_000n);
    expect(takerPnl('receiveFixed', 1_000_000_000n, 10_000n, 11_000n, 500_000_000n)).toBe(-100_000_000n);
    expect(takerPnl('payFixed', 7n, 3n, 1n, 100n)).toBe(-4n); // −14/3 = −4.67 → −4, not −5
    expect(takerPnl('receiveFixed', 7n, 3n, 1n, 100n)).toBe(4n);
    expect(takerPnl('payFixed', 1_000_000_000n, 10_000n, 1n, 200_000_000n)).toBe(-200_000_000n);
    expect(() => takerPnl('payFixed', 5n, 0n, 10_000n, 1n)).toThrow(EpochMathError);
  });

  it('score', () => {
    const good = {
      creditsRatioBps: 9_900,
      commissionBps: 500,
      epochsActive: 60,
      delinquent: false,
      superminority: false,
    };
    expect(computeScore(good)).toBe(10_000);
    expect(computeScore({ ...good, creditsRatioBps: 9_000 })).toBe(7_000);
    expect(computeScore({ ...good, commissionBps: 750 })).toBe(9_250);
    expect(computeScore({ ...good, superminority: true })).toBe(5_000);
    expect(computeScore({ ...good, delinquent: true })).toBe(0);
  });

  it('swap collateral is bps_of(notional, max_move_bps)', () => {
    expect(swapCollateral(1_000_000_000n, 2_000)).toBe(200_000_000n);
    expect(swapCollateral(3n, 3_333)).toBe(0n);
  });
});

describe('revenue tokens', () => {
  const Q64 = 1n << 64n;
  const L = 1_000_000_000n << 65n;
  const curve: CurvePoint[] = [
    { sqrtPrice: 2n * Q64, liquidity: L },
    { sqrtPrice: 4n * Q64, liquidity: 2n * L },
  ];
  const rt = {
    buybackEpoch: 700n,
    epochBudget: 12_000_000_000n,
    epochSpent: 0n,
    slicesPerEpoch: 12,
    slicesDone: 0,
    maxSlippageBps: 300,
    maxImpactBps: 100,
  };
  const dbc = {
    kind: 'dbc' as const,
    sqrtPrice: Q64,
    quoteReserve: 0n,
    isMigrated: false,
    migrationSqrtPrice: 4n * Q64,
    migrationQuoteThreshold: 10_000_000_000n,
    curve,
  };

  it('the share comes off the top unless the advance predates the token', () => {
    expect(splitSweepWithShare(10_000n, 1_000, 1_000_000n, 5_000, false, false)).toEqual({
      share: 1_000n,
      remit: 4_500n,
      toOperator: 4_500n,
    });
    expect(splitSweepWithShare(10_000n, 1_000, 1_000_000n, 5_000, false, true)).toEqual({
      share: 1_000n,
      remit: 5_000n,
      toOperator: 4_000n,
    });
    expect(splitSweepWithShare(10_000n, 0, 1_000_000n, 5_000, false, false)).toEqual({
      share: 0n,
      ...splitSweep(10_000n, 1_000_000n, 5_000, false),
    });
  });

  it('spreads twelve slices over the window', () => {
    expect([0, 1, 11].map((i) => sliceDueSlot(i, 12, 9_000))).toEqual([0n, 750n, 8_250n]);
    expect(sliceDueSlot(12, 12, 9_000)).toBeNull();
    expect(sliceTiming(749n, 1, 12, 9_000)).toBe('notDue');
    expect(sliceTiming(8_999n, 1, 12, 9_000)).toBe('due');
    expect(sliceTiming(9_000n, 11, 12, 9_000)).toBe('windowClosed');
    expect(sliceBudget(12_000n, 4_000n, 12, 0b11111, 8_000n)).toBe(1_142n);
    expect(redeemPayout(1_000n, 1n, 3n)).toBe(333n);
  });

  it('plans a DBC slice the way execute_buyback computes it', () => {
    const plan = planBuybackSlice({
      epoch: 700n,
      revenueToken: rt,
      escrowAvailable: 12_000_000_000n,
      slice: 0,
      venue: dbc,
    });
    // 1 SOL budget, but the 100 bps impact cap allows 9,999,999 lamports (√P + 0.5%).
    expect(plan).toEqual({
      status: 'ready',
      amount: 9_999_999n,
      feeFreeOut: dbcBuy(curve, Q64, 4n * Q64, 9_999_999n).output,
      floor: minOutFloor(dbcBuy(curve, Q64, 4n * Q64, 9_999_999n).output, 300),
      nextSqrtPrice: dbcBuy(curve, Q64, 4n * Q64, 9_999_999n).nextSqrtPrice,
    });
    if (plan.status !== 'ready') throw new Error('expected a plan');
    expect(plan.nextSqrtPrice).toBeLessThanOrEqual(impactTargetSqrtPrice(Q64, 100));
    // A looser cap: the slice budget binds (12 SOL / 12).
    const loose = planBuybackSlice({
      epoch: 700n,
      revenueToken: { ...rt, maxImpactBps: 1_000 },
      escrowAvailable: 12_000_000_000n,
      slice: 0,
      venue: dbc,
    });
    expect(loose.status === 'ready' && loose.amount).toBe(100_000_000n - 1n);
  });

  it('resets the budget in a new epoch and skips what the program rejects', () => {
    const stale = { ...rt, buybackEpoch: 699n, epochBudget: 1n, epochSpent: 1n, slicesDone: 1 };
    const fresh = planBuybackSlice({ epoch: 700n, revenueToken: stale, escrowAvailable: 1_200n, slice: 0, venue: dbc });
    expect(fresh.status === 'ready' && fresh.amount).toBe(100n);
    const base = { epoch: 700n, revenueToken: { ...rt, slicesDone: 1 }, escrowAvailable: 1_200n, slice: 0, venue: dbc };
    expect(planBuybackSlice(base)).toEqual({ status: 'skip', reason: 'SliceAlreadyExecuted' });
    expect(planBuybackSlice({ ...base, slice: 1, venue: { ...dbc, isMigrated: true } })).toEqual({
      status: 'skip',
      reason: 'PoolNotSynced',
    });
    expect(planBuybackSlice({ ...base, slice: 1, venue: { ...dbc, quoteReserve: 10_000_000_000n } })).toEqual({
      status: 'skip',
      reason: 'VenueNotTrading',
    });
    expect(planBuybackSlice({ ...base, slice: 1, escrowAvailable: 0n })).toEqual({
      status: 'skip',
      reason: 'NothingToBuy',
    });
    expect(() => planBuybackSlice({ ...base, slice: 12 })).toThrow(/InvalidSlice/);
  });

  it('plans DAMM v2 slices (concentrated and compounding)', () => {
    const damm = {
      kind: 'dammV2' as const,
      sqrtPrice: Q64,
      liquidity: L,
      sqrtMaxPrice: 1n << 127n,
      collectFeeMode: 1,
      tokenAAmount: 0n,
      tokenBAmount: 0n,
      poolStatus: 0,
    };
    const input = { epoch: 700n, revenueToken: rt, escrowAvailable: 12_000_000_000n, slice: 3, venue: damm };
    const concentrated = planBuybackSlice(input);
    expect(concentrated.status === 'ready' && concentrated.amount).toBe(
      dammConcentratedMaxQuoteIn(Q64, L, 1n << 127n, impactTargetSqrtPrice(Q64, 100)),
    );
    const compounding = planBuybackSlice({
      ...input,
      venue: { ...damm, collectFeeMode: 2, tokenAAmount: 1_000_000_000_000n, tokenBAmount: 50_000_000_000n },
    });
    // b × 100 / 20,000 = 0.25 SOL caps the 1 SOL slice.
    expect(compounding.status === 'ready' && compounding.amount).toBe(250_000_000n);
    expect(planBuybackSlice({ ...input, venue: { ...damm, poolStatus: 1 } })).toEqual({
      status: 'skip',
      reason: 'VenueNotTrading',
    });
  });
});

describe('input validation (values the Rust signature cannot hold)', () => {
  it('throws RangeError/TypeError, not EpochMathError', () => {
    expect(() => bpsOf(-1n, 1)).toThrow(RangeError);
    expect(() => bpsOf(1n << 64n, 1)).toThrow(/outside u64/);
    expect(() => bpsOf(1n, 65_536)).toThrow(/u16/);
    expect(() => bpsOf(1n, 1.5)).toThrow(/u16/);
    expect(() => bpsOf(1 as unknown as bigint, 1)).toThrow(TypeError);
    expect(() =>
      creditLimit({
        trailingRevenue: 1n,
        historyEpochs: 256,
        advanceBps: 1,
        bondLamports: 0n,
        bondMultiplier: 0,
        capLamports: 0n,
      }),
    ).toThrow(/u8/);
    expect(() => takerPnl('both' as Side, 1n, 1n, 1n, 1n)).toThrow(TypeError);
    expect(() =>
      computeScore({ creditsRatioBps: -1, commissionBps: 0, epochsActive: 0, delinquent: false, superminority: false }),
    ).toThrow(RangeError);
    expect(() => distributeIncome(1n, 1n, 1, -1n, 1)).toThrow(RangeError);
    try {
      bpsOf(-1n, 1);
    } catch (error) {
      expect(error).not.toBeInstanceOf(EpochMathError);
    }
  });

  it('EpochMathError names the function', () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(/mulDiv: arithmetic overflow/);
    const error = (() => {
      try {
        mulDiv(1n, 1n, 0n);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RangeError);
    expect((error as EpochMathError).fn).toBe('mulDiv');
    expect((error as EpochMathError).name).toBe('EpochMathError');
  });
});

describe('Fee Index consensus (math/consensus.rs worked examples)', () => {
  const v = (value: bigint, weight: bigint) => ({ value, weight });

  it('two of three equal operators reach two thirds', () => {
    expect(tallyVotes([v(1_000n, 1n), v(1_004n, 1n)], 100)).toEqual({
      median: 1_000n,
      agreeingWeight: 2n,
      castWeight: 2n,
    });
    expect(meetsThreshold(2n, 3n, 6_667)).toBe(true);
    expect(meetsThreshold(1n, 3n, 6_667)).toBe(false);
    expect(deviationBps(1_004n, 1_000n)).toBe(40);
  });

  it('a dissenter is outvoted and its deviation recorded', () => {
    const t = tallyVotes([v(1_000n, 1n), v(1_004n, 1n), v(1_500n, 1n)], 100);
    expect(t).toEqual({ median: 1_004n, agreeingWeight: 2n, castWeight: 3n });
    expect(agreesWithin(1_500n, 1_004n, 100)).toBe(false);
    expect(deviationBps(1_500n, 1_004n)).toBe(4_941);
  });

  it('unequal weights: the heaviest operator alone cannot move the index', () => {
    const t = tallyVotes([v(2_000n, 5n), v(2_010n, 3n), v(1_000n, 2n)], 100);
    expect(t).toEqual({ median: 2_000n, agreeingWeight: 8n, castWeight: 10n });
    expect(meetsThreshold(8n, 10n, 6_667)).toBe(true);
    expect(meetsThreshold(5n, 10n, 6_667)).toBe(false);
  });

  it('edges', () => {
    expect(weightedMedian([])).toBeNull();
    expect(weightedMedian([v(5n, 0n)])).toBeNull();
    expect(tallyVotes([], 100)).toBeNull();
    expect(weightedMedian([v(20n, 1n), v(10n, 1n)])).toBe(10n);
    expect(weightedMedian([v(1n, 1n), v(2n, 1n), v(3n, 5n)])).toBe(3n);
    expect(agreesWithin(0n, 0n, 0)).toBe(true);
    expect(agreesWithin(1n, 0n, 1_000)).toBe(false);
    expect(deviationBps(1n, 0n)).toBe(0xffff_ffff);
    expect(deviationBps(1_001n, 3n)).toBe(3_326_667);
    expect(deviationBps(U64_MAX, 1n)).toBe(0xffff_ffff);
    expect(meetsThreshold(10_000n, 10_000n, 10_000)).toBe(true);
    expect(meetsThreshold(9_999n, 10_000n, 10_000)).toBe(false);
    expect(meetsThreshold(0n, 10n, 5_001)).toBe(false);
    expect(meetsThreshold(5n, 0n, 5_001)).toBe(false);
    expect(() => tallyVotes([v(1n, U64_MAX), v(1n, 1n)], 0)).toThrow(EpochMathError);
    expect(() => agreesWithin(-1n, 0n, 0)).toThrow(RangeError);
    expect(() => meetsThreshold(1n, 1n, 70_000)).toThrow(RangeError);
  });

  it('6,667 bps is "at least two thirds", lenient by under 1 bps up to the 10,000 weight cap', () => {
    for (let total = 1n; total <= 10_000n; total += 1n) {
      for (const agreeing of [(2n * total) / 3n - 1n, (2n * total) / 3n, (2n * total + 2n) / 3n]) {
        if (agreeing < 1n || agreeing > total) continue;
        const twoThirds = 3n * agreeing >= 2n * total;
        const meets = meetsThreshold(agreeing, total, 6_667);
        if (total <= 300n) expect(meets).toBe(twoThirds);
        if (twoThirds) expect(meets).toBe(true);
        // Accepted below two thirds only by less than 1 bps: (2/3 − A/W) × 10,000 < 1.
        if (meets) expect((2n * total - 3n * agreeing) * 10_000n < 3n * total).toBe(true);
      }
    }
  });
});
