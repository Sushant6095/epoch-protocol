import { sdkEnum, vectors } from './__fixtures__/vectors';
import { type Side } from './constants';
import {
  absorbLoss,
  assetsToShares,
  attributeRepayment,
  bpsOf,
  bpsOfCeil,
  computeScore,
  creditLimit,
  distributeIncome,
  EpochMathError,
  juniorRatioBps,
  mulDiv,
  sharePriceE9,
  sharesToAssets,
  splitSweep,
  swapCollateral,
  takerPnl,
} from './math';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

type Args = unknown[];
const big = (v: unknown): bigint => BigInt(v as string);
const num = (v: unknown): number => v as number;
const str = (v: bigint): string => v.toString();

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
    for (const name of ['bps_of', 'mul_div', 'assets_to_shares', 'credit_limit', 'distribute_income', 'taker_pnl']) {
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
