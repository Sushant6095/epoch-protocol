import {
  buildCurveWithCustomSqrtPrices,
  createSqrtPrices,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  MigrationFeeOption,
  TokenAuthorityOption,
  validateConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';

import { curvePointsForBand, isqrt, priceToSqrtPriceX64, revenueCurveConfig, sqrtPriceX64ToPrice } from './curve';
import { launchBand } from './math';
import { fromBaseUnits, toBigInt } from './units';

// rKEST from the Launch spec: 5% of 20.8 SOL an epoch for 100 epochs over 100,000 tokens.
const RKEST = launchBand({ avgRevenueSol: 20.8, shareBps: 500, termEpochs: 100, supply: 100_000 });
const LEFTOVER_RECEIVER = new PublicKey(new Uint8Array(32).fill(7));

const diff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
/** Within 1e-18 of `b`: the SDK rounds to 20 significant digits on the way, so exact math can differ in the last ones. */
const close = (a: bigint, b: bigint): boolean => diff(a, b) * 10n ** 18n <= b;

describe('sqrt prices', () => {
  it('takes exact integer square roots', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    const big = (1n << 128n) + 12_345n;
    const root = isqrt(big);
    expect(root * root <= big && (root + 1n) * (root + 1n) > big).toBe(true);
    expect(() => isqrt(-1n)).toThrow(RangeError);
  });

  it.each([
    [0.000624, 6],
    [0.000988, 6],
    [0.00104, 9],
    [1.5, 6],
    [0.0000001234, 8],
    [42, 9],
  ])('matches the SDK getSqrtPriceFromPrice for %s SOL at %i decimals', (price, decimals) => {
    const ours = priceToSqrtPriceX64(price, decimals);
    const sdk = toBigInt(getSqrtPriceFromPrice(String(price), decimals, 9));
    expect(close(ours, sdk)).toBe(true);
    expect(sqrtPriceX64ToPrice(ours, decimals) / price).toBeCloseTo(1, 12);
    expect(sqrtPriceX64ToPrice(ours, decimals)).toBeCloseTo(getPriceFromSqrtPrice(sdk, decimals, 9).toNumber(), 15);
  });
});

describe('curvePointsForBand', () => {
  it('gives the band ends as the SDK helper (createSqrtPrices) does', () => {
    const points = curvePointsForBand({
      bandLowSol: RKEST.bandLowSol,
      bandHighSol: RKEST.bandHighSol,
      baseDecimals: 6,
    });
    const sdk = createSqrtPrices([RKEST.bandLowSol, RKEST.bandHighSol], 6, 9);
    expect(points).toHaveLength(2);
    points.forEach((point, i) => expect(close(toBigInt(point), toBigInt(sdk[i]))).toBe(true));
  });

  it('spaces extra points geometrically, ascending', () => {
    const points = curvePointsForBand({ bandLowSol: 0.0004, bandHighSol: 0.0009, baseDecimals: 6, points: 3 });
    const prices = points.map((p) => sqrtPriceX64ToPrice(p, 6));
    expect(prices[0]).toBeCloseTo(0.0004, 12);
    expect(prices[1]).toBeCloseTo(0.0006, 12);
    expect(prices[2]).toBeCloseTo(0.0009, 12);
  });

  it('refuses an empty or inverted band and a bad point count', () => {
    expect(() => curvePointsForBand({ bandLowSol: 0, bandHighSol: 1, baseDecimals: 6 })).toThrow(RangeError);
    expect(() => curvePointsForBand({ bandLowSol: 2, bandHighSol: 1, baseDecimals: 6 })).toThrow(RangeError);
    expect(() => curvePointsForBand({ bandLowSol: 1, bandHighSol: 2, baseDecimals: 6, points: 1 })).toThrow(RangeError);
    expect(() => curvePointsForBand({ bandLowSol: 1, bandHighSol: 2, baseDecimals: 6, points: 18 })).toThrow(
      RangeError,
    );
  });

  it('is accepted by buildCurveWithCustomSqrtPrices, which starts the curve at the band low', () => {
    const sqrtPrices = curvePointsForBand({
      bandLowSol: RKEST.bandLowSol,
      bandHighSol: RKEST.bandHighSol,
      baseDecimals: 6,
    });
    const { config } = revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6 });
    expect(config.sqrtStartPrice.toString()).toBe(sqrtPrices[0].toString());
    expect(config.curve[config.curve.length - 1].sqrtPrice.toString()).toBe(sqrtPrices[1].toString());
    // Same output as calling the SDK builder directly with the same points.
    const direct = buildCurveWithCustomSqrtPrices({
      token: {
        tokenType: 0,
        tokenBaseDecimal: 6,
        tokenQuoteDecimal: 9,
        tokenAuthorityOption: TokenAuthorityOption.Immutable,
        totalTokenSupply: 100_000,
        leftover: 0,
      },
      fee: {
        baseFeeParams: {
          baseFeeMode: 0,
          feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
        },
        dynamicFeeEnabled: false,
        collectFeeMode: 0,
        creatorTradingFeePercentage: 0,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },
      migration: {
        migrationOption: 1,
        migrationFeeOption: MigrationFeeOption.FixedBps100,
        migrationFee: { feePercentage: 70, creatorFeePercentage: 100 },
      },
      liquidityDistribution: {
        partnerLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 100,
        creatorLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 0,
      },
      lockedVesting: {
        totalLockedVestingAmount: 0,
        numberOfVestingPeriod: 0,
        cliffUnlockAmount: 0,
        totalVestingDuration: 0,
        cliffDurationFromMigrationTime: 0,
      },
      activationType: 1,
      sqrtPrices,
    });
    expect(direct.migrationQuoteThreshold.toString()).toBe(config.migrationQuoteThreshold.toString());
    expect(direct.curve[0].liquidity.toString()).toBe(config.curve[0].liquidity.toString());
  });
});

describe('revenueCurveConfig (Epoch partner preset)', () => {
  const full = revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6 });
  const demo = revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6, raiseTargetSol: 5 });

  it('raises about 61% of the share value when the whole supply is on the band', () => {
    expect(full.leftoverTokens).toBe(0);
    expect(full.fullSupplyRaiseSol).toBeCloseTo(63.4, 1);
    expect(full.migrationThresholdSol / RKEST.shareValueSol).toBeCloseTo(0.61, 2);
  });

  it('meets a 5 SOL raise target by leaving the unused supply as DBC leftover', () => {
    expect(demo.migrationThresholdSol).toBeGreaterThanOrEqual(5);
    expect(demo.migrationThresholdSol).toBeLessThan(5.001);
    expect(demo.leftoverTokens).toBeGreaterThan(92_000);
    expect(demo.leftoverTokens).toBeLessThan(92_200);
    expect(demo.upfrontToValidatorSol).toBeCloseTo(3.5, 3);
    expect(demo.dammSeedSol).toBeCloseTo(1.5, 3);
    // One constant-product segment: tokens sold = raise ÷ √(low × high).
    expect(demo.tokensOnCurve).toBeCloseTo(
      demo.migrationThresholdSol / Math.sqrt(RKEST.bandLowSol * RKEST.bandHighSol),
      0,
    );
  });

  it('graduates at the band high and keeps the fixed supply', () => {
    const { config } = demo;
    const migrationPrice = getMigrationThresholdPrice(
      config.migrationQuoteThreshold,
      config.sqrtStartPrice,
      config.curve,
    );
    expect(sqrtPriceX64ToPrice(migrationPrice, 6) / RKEST.bandHighSol).toBeCloseTo(1, 6);
    expect(sqrtPriceX64ToPrice(config.sqrtStartPrice, 6) / RKEST.bandLowSol).toBeCloseTo(1, 12);
    expect(fromBaseUnits(config.tokenSupply!.preMigrationTokenSupply, 6)).toBe(100_000);
    expect(fromBaseUnits(config.tokenSupply!.postMigrationTokenSupply, 6)).toBe(100_000);
  });

  it('sets the partner preset: immutable token, 70% to the creator, all DAMM v2 liquidity locked', () => {
    const { config } = demo;
    expect(config.tokenUpdateAuthority).toBe(TokenAuthorityOption.Immutable);
    expect(config.migrationFee).toEqual({ feePercentage: 70, creatorFeePercentage: 100 });
    expect(config.partnerPermanentLockedLiquidityPercentage + config.creatorPermanentLockedLiquidityPercentage).toBe(
      100,
    );
    expect(config.creatorTradingFeePercentage).toBe(0);
    expect(config.migrationOption).toBe(1);
    expect(config.migrationFeeOption).toBe(MigrationFeeOption.FixedBps100);
    expect(config.poolFees.baseFee.cliffFeeNumerator.toString()).toBe('10000000');
  });

  it('passes the SDK validation createConfig runs', () => {
    expect(() => validateConfigParameters({ ...demo.config, leftoverReceiver: LEFTOVER_RECEIVER })).not.toThrow();
    expect(() => validateConfigParameters({ ...full.config, leftoverReceiver: LEFTOVER_RECEIVER })).not.toThrow();
  });

  it('keeps a small leftover pad when the SDK supply check needs one (low prices, whole supply)', () => {
    // A 1% share of 168 SOL an epoch for 20 epochs over 1,000,000 tokens: 0.0000336 SOL per token.
    const band = launchBand({ avgRevenueSol: 168, shareBps: 100, termEpochs: 20, supply: 1_000_000 });
    const curve = revenueCurveConfig({ ...band, supply: 1_000_000, decimals: 6 });
    expect(curve.leftoverTokens).toBeGreaterThan(0);
    expect(curve.leftoverTokens).toBeLessThanOrEqual(100);
    expect(curve.migrationThresholdSol / band.shareValueSol).toBeCloseTo(0.61, 2);
    expect(() => validateConfigParameters({ ...curve.config, leftoverReceiver: LEFTOVER_RECEIVER })).not.toThrow();
    const targeted = revenueCurveConfig({ ...band, supply: 1_000_000, decimals: 6, raiseTargetSol: 3 });
    expect(targeted.migrationThresholdSol).toBeGreaterThanOrEqual(3);
    expect(targeted.migrationThresholdSol).toBeLessThan(3.001);
  });

  it('maps the DAMM v2 fee tier and refuses impossible targets', () => {
    expect(
      revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6, dammFeeBps: 25 }).config.migrationFeeOption,
    ).toBe(MigrationFeeOption.FixedBps25);
    expect(() => revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6, raiseTargetSol: 100 })).toThrow(
      /whole supply/,
    );
    expect(() => revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 5 })).toThrow(/decimals/);
    expect(() => revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6, raiseTargetSol: 0 })).toThrow(RangeError);
  });
});
