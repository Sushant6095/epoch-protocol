/**
 * The revenue-anchored curve: the band's prices as DBC sqrt prices (Q64.64, exact bigint math) and Epoch's partner
 * preset around the SDK's `buildCurveWithCustomSqrtPrices` (ADR 0006, plan F13).
 */
import {
  ActivationType,
  BaseFeeMode,
  buildCurveWithCustomSqrtPrices,
  CollectFeeMode,
  type ConfigParameters,
  getBaseTokenForSwap,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  type TokenDecimal,
  TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type BN from 'bn.js';

import {
  CREATOR_MIGRATION_FEE_SHARE_PCT,
  DEFAULT_TRADING_FEE_BPS,
  LOCKED_LIQUIDITY_PCT,
  MAX_CURVE_POINTS,
  MIGRATION_FEE_PCT,
  SOL_DECIMALS,
} from './constants';
import { dammSeedSol, upfrontToValidatorSol } from './math';
import { fromBaseUnits, parseDecimal, toBigInt, toBN } from './units';

const Q128 = 1n << 128n;
const TWO_POW_64 = 2 ** 64;

/** Floor of the square root of a non-negative bigint (Newton's method from a power of two above the root). */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError('square root of a negative number');
  if (value < 2n) return value;
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const y = (x + value / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * Price in SOL per token → DBC/DAMM sqrt price: floor(√(price × 10^(quoteDecimals − baseDecimals)) × 2^64), exact.
 * The SDK's `getSqrtPriceFromPrice` computes the same with 20-digit decimals.
 */
export function priceToSqrtPriceX64(
  price: number | string,
  baseDecimals: number,
  quoteDecimals = SOL_DECIMALS,
): bigint {
  const { digits, scale } = parseDecimal(price);
  const exponent = quoteDecimals - baseDecimals - scale;
  const scaled = exponent >= 0 ? digits * Q128 * 10n ** BigInt(exponent) : (digits * Q128) / 10n ** BigInt(-exponent);
  return isqrt(scaled);
}

/** Sqrt price (Q64.64) → price in SOL per token. Floating point: for display and math, not for transactions. */
export function sqrtPriceX64ToPrice(
  sqrtPrice: bigint | BN | string,
  baseDecimals: number,
  quoteDecimals = SOL_DECIMALS,
): number {
  const root = Number(toBigInt(sqrtPrice)) / TWO_POW_64;
  return root * root * 10 ** (baseDecimals - quoteDecimals);
}

export interface CurvePointsInput {
  /** Where the curve starts (60% of the value per token), SOL per token. */
  bandLowSol: number;
  /** Where it graduates (95% of the value per token), SOL per token. */
  bandHighSol: number;
  /** The token's decimals (DBC allows 6–9). */
  baseDecimals: number;
  quoteDecimals?: number;
  /** Sqrt-price points, 2–17. Points between the two ends are spaced geometrically. Default 2 (one segment). */
  points?: number;
}

/**
 * The sqrt-price points for `buildCurveWithCustomSqrtPrices`: the band's low price first (the curve's start, pMin),
 * the high price last (the migration price, pMax), ascending.
 */
export function curvePointsForBand(input: CurvePointsInput): BN[] {
  const { bandLowSol: low, bandHighSol: high, baseDecimals, quoteDecimals = SOL_DECIMALS, points = 2 } = input;
  if (!(low > 0) || !(high > low)) throw new RangeError(`band must satisfy 0 < low < high, got ${low}–${high}`);
  if (!Number.isInteger(points) || points < 2 || points > MAX_CURVE_POINTS) {
    throw new RangeError(`points must be an integer from 2 to ${MAX_CURVE_POINTS}, got ${points}`);
  }
  const ratio = high / low;
  const prices = Array.from({ length: points }, (_, i) =>
    i === 0 ? low : i === points - 1 ? high : low * ratio ** (i / (points - 1)),
  );
  const sqrtPrices = prices.map((price) => priceToSqrtPriceX64(price, baseDecimals, quoteDecimals));
  for (let i = 1; i < sqrtPrices.length; i++) {
    if (sqrtPrices[i] <= sqrtPrices[i - 1]) throw new RangeError('the band is too narrow for this many points');
  }
  return sqrtPrices.map(toBN);
}

/** DAMM v2 pool fee tiers after graduation (DBC `MigrationFeeOption` fixed options). */
export type DammFeeBps = 25 | 30 | 100 | 200 | 400 | 600;

const DAMM_FEE_OPTION: Record<DammFeeBps, MigrationFeeOption> = {
  25: MigrationFeeOption.FixedBps25,
  30: MigrationFeeOption.FixedBps30,
  100: MigrationFeeOption.FixedBps100,
  200: MigrationFeeOption.FixedBps200,
  400: MigrationFeeOption.FixedBps400,
  600: MigrationFeeOption.FixedBps600,
};

export interface RevenueCurveInput {
  bandLowSol: number;
  bandHighSol: number;
  /** Fixed token supply (UI units). */
  supply: number;
  /** Token decimals, 6–9. */
  decimals: number;
  /**
   * Graduate at this raise (the DBC `migrationQuoteThreshold`), SOL. The raise of a curve over the band is about 61% of
   * the share's value whatever the supply, so a smaller target leaves the unused supply as DBC `leftover`, which the
   * config's leftover receiver can withdraw after graduation. Unset: the whole supply is used.
   */
  raiseTargetSol?: number;
  /** Curve trading fee, bps (default 100, DBC minimum 25); all of it goes to the partner (Epoch's treasury). */
  tradingFeeBps?: number;
  /** DAMM v2 pool fee after graduation (default 100 bps). */
  dammFeeBps?: DammFeeBps;
  /** Sqrt-price points (default 2). */
  points?: number;
  /** One weight per segment (`points − 1`); equal by default. */
  liquidityWeights?: number[];
}

export interface RevenueCurve {
  /** DBC config parameters: spread into `createConfig` / `createConfigAndPool` with the accounts. */
  config: ConfigParameters;
  sqrtPrices: BN[];
  /**
   * Tokens the curve and the DAMM v2 seed do not use (DBC `leftover`): the unused supply under a raise target, or a
   * pad of a few tokens when the SDK's supply check needs one.
   */
  leftoverTokens: number;
  /** The raise that graduates the token (DBC `migrationQuoteThreshold`), SOL. */
  migrationThresholdSol: number;
  /** The raise with no leftover (the whole supply on the band), SOL. */
  fullSupplyRaiseSol: number;
  /** Tokens sold on the curve from the band's low price to its high price. */
  tokensOnCurve: number;
  /** 70% of the raise, paid to the pool creator at graduation. */
  upfrontToValidatorSol: number;
  /** The rest of the raise, which seeds the DAMM v2 pool with its liquidity locked forever. */
  dammSeedSol: number;
}

const assertDecimals = (decimals: number): TokenDecimal => {
  if (![6, 7, 8, 9].includes(decimals)) throw new RangeError(`DBC token decimals must be 6–9, got ${decimals}`);
  return decimals as TokenDecimal;
};

/**
 * Epoch's DBC config for one launch (the partner preset): SPL token with a fixed supply, no mint authority and
 * immutable metadata; a flat curve fee, all to the partner; graduation to DAMM v2 with a 70% migration fee to the
 * creator (the validator's upfront SOL) and 100% of the DAMM v2 liquidity permanently locked with the partner.
 */
export function revenueCurveConfig(input: RevenueCurveInput): RevenueCurve {
  const decimals = assertDecimals(input.decimals);
  if (!(input.supply > 0)) throw new RangeError(`supply must be positive, got ${input.supply}`);
  const tradingFeeBps = input.tradingFeeBps ?? DEFAULT_TRADING_FEE_BPS;
  const migrationFeeOption = DAMM_FEE_OPTION[input.dammFeeBps ?? 100];
  if (migrationFeeOption === undefined) throw new RangeError(`unsupported DAMM v2 fee: ${input.dammFeeBps} bps`);
  const sqrtPrices = curvePointsForBand({
    bandLowSol: input.bandLowSol,
    bandHighSol: input.bandHighSol,
    baseDecimals: decimals,
    points: input.points,
  });

  const build = (leftover: number): ConfigParameters =>
    buildCurveWithCustomSqrtPrices({
      token: {
        tokenType: TokenType.SPLToken,
        tokenBaseDecimal: decimals,
        tokenQuoteDecimal: SOL_DECIMALS,
        tokenAuthorityOption: TokenAuthorityOption.Immutable,
        totalTokenSupply: input.supply,
        leftover,
      },
      fee: {
        baseFeeParams: {
          baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
          feeSchedulerParam: {
            startingFeeBps: tradingFeeBps,
            endingFeeBps: tradingFeeBps,
            numberOfPeriod: 0,
            totalDuration: 0,
          },
        },
        dynamicFeeEnabled: false,
        collectFeeMode: CollectFeeMode.QuoteToken,
        creatorTradingFeePercentage: 0,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },
      migration: {
        migrationOption: MigrationOption.MET_DAMM_V2,
        migrationFeeOption,
        migrationFee: { feePercentage: MIGRATION_FEE_PCT, creatorFeePercentage: CREATOR_MIGRATION_FEE_SHARE_PCT },
      },
      liquidityDistribution: {
        partnerLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: LOCKED_LIQUIDITY_PCT,
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
      activationType: ActivationType.Timestamp,
      sqrtPrices,
      liquidityWeights: input.liquidityWeights,
    });

  // The SDK checks that the curve, the DAMM v2 seed (exact DAMM v2 rounding) and the leftover fit in the supply; with
  // little or no leftover that check can miss by a few base units, so a small leftover pad absorbs it.
  const fit = (wanted: number): { config: ConfigParameters; leftover: number } => {
    let pad = Math.max(1, Math.ceil(input.supply * 1e-6));
    let leftover = wanted;
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        return { config: build(leftover), leftover };
      } catch (error) {
        if (!/leftOverDelta/.test(String(error))) throw error;
        leftover = Math.min(input.supply, wanted + pad);
        pad *= 2;
      }
    }
    throw new RangeError('the curve does not fit in the supply');
  };

  const full = fit(0);
  // What the raise would be with no leftover at all (the threshold is linear in the tokens the curve and seed use).
  const fullSupplyRaiseSol =
    (fromBaseUnits(full.config.migrationQuoteThreshold, SOL_DECIMALS) * input.supply) / (input.supply - full.leftover);
  let { config, leftover: leftoverTokens } = full;
  if (input.raiseTargetSol !== undefined) {
    const target = input.raiseTargetSol;
    if (!(target > 0)) throw new RangeError(`raiseTargetSol must be positive, got ${target}`);
    if (target > fullSupplyRaiseSol) {
      throw new RangeError(
        `a ${target} SOL raise needs more than the whole supply on this band (at most ${fullSupplyRaiseSol.toFixed(3)} SOL)`,
      );
    }
    // Scale the tokens the curve and the DAMM v2 seed use to the target. Whole tokens, rounded so the threshold lands
    // at or just above the target.
    const wanted = Math.floor(input.supply * (1 - target / fullSupplyRaiseSol));
    if (wanted > leftoverTokens) ({ config, leftover: leftoverTokens } = fit(wanted));
  }
  const migrationThresholdSol = fromBaseUnits(config.migrationQuoteThreshold, SOL_DECIMALS);
  const tokensOnCurve = fromBaseUnits(
    getBaseTokenForSwap(config.sqrtStartPrice, sqrtPrices[sqrtPrices.length - 1], config.curve),
    decimals,
  );
  return {
    config,
    sqrtPrices,
    leftoverTokens,
    migrationThresholdSol,
    fullSupplyRaiseSol,
    tokensOnCurve,
    upfrontToValidatorSol: upfrontToValidatorSol(migrationThresholdSol),
    dammSeedSol: dammSeedSol(migrationThresholdSol),
  };
}
