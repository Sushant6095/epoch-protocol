/**
 * Exact integer mirrors of `programs/epoch/src/math/*.rs` and `taker_pnl` in `instructions/market/swap.rs`.
 *
 * Same intermediate widths (u128 / i128), same rounding, same overflow points. Where the Rust function returns
 * `None` (the program then fails with `MathOverflow`) these throw an `EpochMathError`; inputs outside the Rust
 * parameter types (a negative bigint, a u16 above 65,535, …) throw a `RangeError`/`TypeError`.
 */
import { I64_MAX, I64_MIN, U64_MAX } from './borsh';
import { PROGRAM_CONSTANTS, type Side } from './constants';

const U128_MAX = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);
const BPS = BigInt(PROGRAM_CONSTANTS.BPS_DENOMINATOR);
const { VIRTUAL_SHARES, VIRTUAL_ASSETS } = PROGRAM_CONSTANTS;

/** The Rust function returned `None`: the program would fail with `MathOverflow`. */
export class EpochMathError extends RangeError {
  constructor(readonly fn: string) {
    super(`${fn}: arithmetic overflow (the program returns None / MathOverflow)`);
    this.name = 'EpochMathError';
  }
}

function u64(value: bigint, what: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${what} must be a bigint (u64), got ${typeof value}`);
  if (value < 0n || value > U64_MAX) throw new RangeError(`${what} is outside u64: ${value}`);
  return value;
}

function uint(value: number, bits: 8 | 16, what: string): bigint {
  const max = bits === 8 ? 0xff : 0xffff;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${what} must be an integer in [0, ${max}] (u${bits}), got ${String(value)}`);
  }
  return BigInt(value);
}

/** `u128::checked_mul`. */
function mul128(a: bigint, b: bigint, fn: string): bigint {
  const v = a * b;
  if (v > U128_MAX) throw new EpochMathError(fn);
  return v;
}

/** `u64::try_from(u128)`. */
function toU64(value: bigint, fn: string): bigint {
  if (value > U64_MAX) throw new EpochMathError(fn);
  return value;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** `amount × bps / 10_000`, rounded down. */
export function bpsOf(amount: bigint, bps: number): bigint {
  return toU64(mul128(u64(amount, 'amount'), uint(bps, 16, 'bps'), 'bpsOf') / BPS, 'bpsOf');
}

/** `amount × bps / 10_000`, rounded up. */
export function bpsOfCeil(amount: bigint, bps: number): bigint {
  const num = mul128(u64(amount, 'amount'), uint(bps, 16, 'bps'), 'bpsOfCeil');
  return toU64((num + BPS - 1n) / BPS, 'bpsOfCeil');
}

/** `a × b / c` in 128-bit, rounded down. Throws when `c` is 0 or the result exceeds u64. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  u64(a, 'a');
  u64(b, 'b');
  if (u64(c, 'c') === 0n) throw new EpochMathError('mulDiv');
  return toU64(mul128(a, b, 'mulDiv') / c, 'mulDiv');
}

/** Shares minted for `assets` deposited into a tranche (virtual offsets; rounds down). */
export function assetsToShares(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const num = mul128(u64(assets, 'assets'), u64(totalShares, 'totalShares') + VIRTUAL_SHARES, 'assetsToShares');
  const den = u64(totalAssets, 'totalAssets') + VIRTUAL_ASSETS;
  return toU64(num / den, 'assetsToShares');
}

/** Assets paid for `shares` redeemed from a tranche (virtual offsets; rounds down). */
export function sharesToAssets(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const num = mul128(u64(shares, 'shares'), u64(totalAssets, 'totalAssets') + VIRTUAL_ASSETS, 'sharesToAssets');
  const den = u64(totalShares, 'totalShares') + VIRTUAL_SHARES;
  return toU64(num / den, 'sharesToAssets');
}

/** Share price × 1e9 (lamports per raw share), rounded down. Par is 1,000,000. */
export function sharePriceE9(totalAssets: bigint, totalShares: bigint): bigint {
  const num = mul128(u64(totalAssets, 'totalAssets') + VIRTUAL_ASSETS, 1_000_000_000n, 'sharePriceE9');
  const den = u64(totalShares, 'totalShares') + VIRTUAL_SHARES;
  return toU64(num / den, 'sharePriceE9');
}

export interface CreditLimitInput {
  trailingRevenue: bigint;
  /** u8: epochs of revenue history (`revenue_count`). */
  historyEpochs: number;
  /** u16 */
  advanceBps: number;
  bondLamports: bigint;
  /** u8; 0 disables the bond cap. */
  bondMultiplier: number;
  capLamports: bigint;
}

/** `min(trailing × advance_bps, bond × multiplier, cap)`; 0 with fewer than `MIN_REVENUE_HISTORY` epochs. */
export function creditLimit(input: CreditLimitInput): bigint {
  u64(input.trailingRevenue, 'trailingRevenue');
  uint(input.advanceBps, 16, 'advanceBps');
  const history = uint(input.historyEpochs, 8, 'historyEpochs');
  const multiplier = uint(input.bondMultiplier, 8, 'bondMultiplier');
  const bond = u64(input.bondLamports, 'bondLamports');
  const cap = u64(input.capLamports, 'capLamports');
  if (history < BigInt(PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY)) return 0n;
  const byRevenue = bpsOf(input.trailingRevenue, input.advanceBps);
  let byBond = U64_MAX;
  if (multiplier !== 0n) {
    byBond = bond * multiplier;
    if (byBond > U64_MAX) throw new EpochMathError('creditLimit');
  }
  return min(min(byRevenue, byBond), cap);
}

/** Remit `remit_bps` of `gross` (all of it when `fullRemit`), capped at what is owed; the rest to the operator. */
export function splitSweep(
  gross: bigint,
  outstanding: bigint,
  remitBps: number,
  fullRemit: boolean,
): { remit: bigint; toOperator: bigint } {
  u64(gross, 'gross');
  u64(outstanding, 'outstanding');
  uint(remitBps, 16, 'remitBps');
  if (typeof fullRemit !== 'boolean') throw new TypeError('fullRemit must be a boolean');
  const wanted = fullRemit ? gross : bpsOf(gross, remitBps);
  const remit = min(min(wanted, outstanding), gross);
  return { remit, toOperator: gross - remit };
}

/** Split a remittance into principal and fee pro rata to what is outstanding (fee rounded down). */
export function attributeRepayment(
  remit: bigint,
  principalOutstanding: bigint,
  feeOutstanding: bigint,
): { principal: bigint; fee: bigint } {
  u64(remit, 'remit');
  const total = u64(principalOutstanding, 'principalOutstanding') + u64(feeOutstanding, 'feeOutstanding');
  if (total > U64_MAX) throw new EpochMathError('attributeRepayment');
  if (total === 0n || remit === 0n) return { principal: 0n, fee: 0n };
  const capped = min(remit, total);
  const fee = min(mulDiv(capped, feeOutstanding, total), feeOutstanding);
  return { principal: min(capped - fee, principalOutstanding), fee };
}

/** Protocol fee off the top, then the senior coupon for `epochs`, then the rest to junior. */
export function distributeIncome(
  income: bigint,
  seniorAssets: bigint,
  seniorRateBpsPerEpoch: number,
  epochs: bigint,
  protocolFeeBps: number,
): { protocolFee: bigint; seniorGain: bigint; juniorGain: bigint } {
  u64(epochs, 'epochs');
  const protocolFee = bpsOf(income, protocolFeeBps);
  if (protocolFee > income) throw new EpochMathError('distributeIncome');
  const net = income - protocolFee;
  const seniorDue = bpsOf(seniorAssets, seniorRateBpsPerEpoch) * epochs;
  if (seniorDue > U64_MAX) throw new EpochMathError('distributeIncome');
  const seniorGain = min(net, seniorDue);
  return { protocolFee, seniorGain, juniorGain: net - seniorGain };
}

/** Junior share of tranche assets in bps (10,000 when both are empty). */
export function juniorRatioBps(seniorAssets: bigint, juniorAssets: bigint): bigint {
  const total = u64(seniorAssets, 'seniorAssets') + u64(juniorAssets, 'juniorAssets');
  if (total > U64_MAX) throw new EpochMathError('juniorRatioBps');
  if (total === 0n) return BPS;
  return mulDiv(juniorAssets, BPS, total);
}

/** Write a loss off junior first, then senior; `unabsorbed` is what neither could cover. */
export function absorbLoss(
  loss: bigint,
  seniorAssets: bigint,
  juniorAssets: bigint,
): { seniorAssets: bigint; juniorAssets: bigint; unabsorbed: bigint } {
  u64(loss, 'loss');
  u64(seniorAssets, 'seniorAssets');
  u64(juniorAssets, 'juniorAssets');
  const fromJunior = min(loss, juniorAssets);
  const rest = loss - fromJunior;
  const fromSenior = min(rest, seniorAssets);
  return {
    seniorAssets: seniorAssets - fromSenior,
    juniorAssets: juniorAssets - fromJunior,
    unabsorbed: rest - fromSenior,
  };
}

/**
 * Taker profit (lamports, i64) for a settled index: `notional × (index − fixed) / fixed` in i128 with division
 * truncating toward zero, negated for `receiveFixed`, clamped to ±`maxLoss`. Throws where the program would fail
 * (`fixedRate` 0, i128 overflow, or a clamped value outside i64).
 */
export function takerPnl(side: Side, notional: bigint, fixedRate: bigint, indexValue: bigint, maxLoss: bigint): bigint {
  u64(notional, 'notional');
  u64(fixedRate, 'fixedRate');
  u64(indexValue, 'indexValue');
  u64(maxLoss, 'maxLoss');
  if (side !== 'payFixed' && side !== 'receiveFixed') throw new TypeError(`Invalid side '${String(side)}'`);
  if (fixedRate === 0n) throw new EpochMathError('takerPnl');
  const product = notional * (indexValue - fixedRate);
  if (product > I128_MAX || product < I128_MIN) throw new EpochMathError('takerPnl');
  const raw = product / fixedRate; // BigInt division truncates toward zero, like Rust's i128 `/`.
  const signed = side === 'payFixed' ? raw : -raw;
  const clamped = signed > maxLoss ? maxLoss : signed < -maxLoss ? -maxLoss : signed;
  if (clamped > I64_MAX || clamped < I64_MIN) throw new EpochMathError('takerPnl');
  return clamped;
}

/** Collateral each side posts for a swap: `bps_of(notional, max_move_bps)`. */
export function swapCollateral(notional: bigint, maxMoveBps: number): bigint {
  return bpsOf(notional, maxMoveBps);
}

export interface ScoreInput {
  /** u16: vote credits as a share of the cluster average, bps (10,000 = average). */
  creditsRatioBps: number;
  /** u16: the higher of inflation and MEV commission, bps. */
  commissionBps: number;
  /** u16 */
  epochsActive: number;
  delinquent: boolean;
  superminority: boolean;
}

/** The Epoch Score (0..=10,000): credits up to 6,000, commission up to 2,500, tenure up to 1,500. */
export function computeScore(input: ScoreInput): number {
  const credits = Number(uint(input.creditsRatioBps, 16, 'creditsRatioBps'));
  const commission = Number(uint(input.commissionBps, 16, 'commissionBps'));
  const epochs = Number(uint(input.epochsActive, 16, 'epochsActive'));
  if (input.delinquent) return 0;
  const creditsPts =
    credits >= 9_700
      ? 6_000
      : credits >= 9_000
        ? 3_000 + Math.floor(((credits - 9_000) * 3_000) / 700)
        : Math.floor((credits * 3_000) / 9_000);
  const commissionPts =
    commission <= 500 ? 2_500 : commission <= 1_000 ? 2_500 - Math.floor(((commission - 500) * 1_500) / 500) : 0;
  const tenurePts = Math.floor((Math.min(epochs, 30) * 1_500) / 30);
  let score = creditsPts + commissionPts + tenurePts;
  if (input.superminority) score = Math.min(score, 5_000);
  return Math.min(score, PROGRAM_CONSTANTS.MAX_SCORE);
}

// ─── Revenue tokens (`math/revenue_token.rs`) ─────────────────────────────

/** One sweep's gross revenue, three ways: to the buyback escrow, to the pool, to the validator. */
export interface ShareSplit {
  share: bigint;
  remit: bigint;
  toOperator: bigint;
}

/**
 * The sweep waterfall with a revenue share. Normally the share (`gross × shareBps`) comes off the top and the advance
 * waterfall runs on the rest; when the open advance predates the token (`seniorAdvance`) the remittance is computed on
 * `gross` first and the share comes out of the validator's part. `share + remit + toOperator === gross`.
 */
export function splitSweepWithShare(
  gross: bigint,
  shareBps: number,
  outstanding: bigint,
  remitBps: number,
  fullRemit: boolean,
  seniorAdvance: boolean,
): ShareSplit {
  if (typeof seniorAdvance !== 'boolean') throw new TypeError('seniorAdvance must be a boolean');
  const wanted = bpsOf(gross, shareBps);
  if (seniorAdvance) {
    const s = splitSweep(gross, outstanding, remitBps, fullRemit);
    const share = min(wanted, s.toOperator);
    return { share, remit: s.remit, toOperator: s.toOperator - share };
  }
  if (wanted > gross) throw new EpochMathError('splitSweepWithShare');
  const s = splitSweep(gross - wanted, outstanding, remitBps, fullRemit);
  return { share: wanted, remit: s.remit, toOperator: s.toOperator };
}

function u32(value: number, what: string): bigint {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${what} must be an integer in [0, 4294967295] (u32), got ${String(value)}`);
  }
  return BigInt(value);
}

/** Slot index (from the epoch's first slot) at which slice `slice` is due; null for an out-of-range slice. */
export function sliceDueSlot(slice: number, slices: number, windowSlots: number): bigint | null {
  const i = uint(slice, 8, 'slice');
  const n = uint(slices, 8, 'slices');
  const window = u32(windowSlots, 'windowSlots');
  if (n === 0n || i >= n) return null;
  return (i * window) / n;
}

export type SliceTiming = 'due' | 'notDue' | 'windowClosed';

/** Whether slice `slice` may run `slotIndex` slots into the epoch; null for an out-of-range slice (`InvalidSlice`). */
export function sliceTiming(slotIndex: bigint, slice: number, slices: number, windowSlots: number): SliceTiming | null {
  u64(slotIndex, 'slotIndex');
  const due = sliceDueSlot(slice, slices, windowSlots);
  if (due === null) return null;
  if (slotIndex >= BigInt(windowSlots)) return 'windowClosed';
  return slotIndex < due ? 'notDue' : 'due';
}

const popcount32 = (bits: number): bigint => {
  let n = 0n;
  for (let v = bits >>> 0; v !== 0; v >>>= 1) n += BigInt(v & 1);
  return n;
};

/**
 * What the next slice may spend: what is left of the epoch's budget over the slices still to run, capped by the
 * escrow. 0 when every slice ran. Throws when more slices are marked done than exist.
 */
export function sliceBudget(
  epochBudget: bigint,
  epochSpent: bigint,
  slices: number,
  slicesDone: number,
  escrowAvailable: bigint,
): bigint {
  u64(epochBudget, 'epochBudget');
  u64(epochSpent, 'epochSpent');
  u64(escrowAvailable, 'escrowAvailable');
  const n = uint(slices, 8, 'slices');
  const done = popcount32(Number(u32(slicesDone, 'slicesDone')));
  if (done > n) throw new EpochMathError('sliceBudget');
  const remaining = n - done;
  if (remaining === 0n) return 0n;
  const left = epochBudget > epochSpent ? epochBudget - epochSpent : 0n;
  return min(left / remaining, escrowAvailable);
}

/** Lamports paid for burning `amount` of `circulating` tokens: the same share of the escrow, rounded down. */
export function redeemPayout(escrowAvailable: bigint, amount: bigint, circulating: bigint): bigint {
  if (u64(amount, 'amount') > u64(circulating, 'circulating')) throw new EpochMathError('redeemPayout');
  if (circulating === 0n) throw new EpochMathError('redeemPayout');
  return mulDiv(escrowAvailable, amount, circulating);
}

// ─── Meteora buy quotes (`math/amm.rs`) ───────────────────────────────────

const U256_MAX = (1n << 256n) - 1n;

function u128(value: bigint, what: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${what} must be a bigint (u128), got ${typeof value}`);
  if (value < 0n || value > U128_MAX) throw new RangeError(`${what} is outside u128: ${value}`);
  return value;
}

/** One DBC curve segment: it runs up to `sqrtPrice` (Q64.64) with `liquidity`. */
export interface CurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

/** A SOL-in, token-out swap before fees. */
export interface BuyFill {
  output: bigint;
  /** SOL used (less than the input when a DBC partial fill stops at the migration price). */
  consumed: bigint;
  /** 0 for a compounding DAMM v2 pool (its price is the reserve ratio). */
  nextSqrtPrice: bigint;
}

/** `Δbase = L × (√P_upper − √P_lower) / (√P_lower × √P_upper)` (256-bit intermediate). */
export function deltaBase(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean): bigint {
  u128(lower, 'lower');
  u128(upper, 'upper');
  u128(liquidity, 'liquidity');
  if (upper < lower) throw new EpochMathError('deltaBase');
  const den = lower * upper;
  if (den === 0n) throw new EpochMathError('deltaBase');
  const num = liquidity * (upper - lower);
  const q = num / den;
  return roundUp && num % den !== 0n ? q + 1n : q;
}

/** `Δquote = L × (√P_upper − √P_lower) >> 128`. */
export function deltaQuote(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean): bigint {
  u128(lower, 'lower');
  u128(upper, 'upper');
  u128(liquidity, 'liquidity');
  if (upper < lower) throw new EpochMathError('deltaQuote');
  const prod = liquidity * (upper - lower);
  const q = prod >> 128n;
  return roundUp && (prod & U128_MAX) !== 0n ? q + 1n : q;
}

/** `√P' = √P + (amount << 128) / L`, rounded down. */
export function nextSqrtFromQuoteIn(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  u128(sqrtPrice, 'sqrtPrice');
  u128(liquidity, 'liquidity');
  u64(amount, 'amount');
  if (liquidity === 0n) throw new EpochMathError('nextSqrtFromQuoteIn');
  const next = sqrtPrice + (amount << 128n) / liquidity;
  if (next > U128_MAX) throw new EpochMathError('nextSqrtFromQuoteIn');
  return next;
}

const toU64Checked = (value: bigint, fn: string): bigint => {
  if (value > U64_MAX) throw new EpochMathError(fn);
  return value;
};

/** DBC: tokens out for `amountIn` SOL along the curve from `sqrtPrice`, stopping at `stopSqrtPrice` (the migration price). */
export function dbcBuy(
  curve: readonly CurvePoint[],
  sqrtPrice: bigint,
  stopSqrtPrice: bigint,
  amountIn: bigint,
): BuyFill {
  u128(stopSqrtPrice, 'stopSqrtPrice');
  u64(amountIn, 'amountIn');
  let output = 0n;
  let current = u128(sqrtPrice, 'sqrtPrice');
  let left = amountIn;
  for (const point of curve) {
    if (point.sqrtPrice === 0n || point.liquidity === 0n) break;
    const reference = min(stopSqrtPrice, point.sqrtPrice);
    if (reference <= current) continue;
    const maxIn = deltaQuote(current, reference, point.liquidity, true);
    if (left < maxIn) {
      const next = nextSqrtFromQuoteIn(current, point.liquidity, left);
      output = toU64Checked(
        output + toU64Checked(deltaBase(current, next, point.liquidity, false), 'dbcBuy'),
        'dbcBuy',
      );
      current = next;
      left = 0n;
      break;
    }
    output = toU64Checked(
      output + toU64Checked(deltaBase(current, reference, point.liquidity, false), 'dbcBuy'),
      'dbcBuy',
    );
    current = reference;
    left -= toU64Checked(maxIn, 'dbcBuy');
    if (reference === stopSqrtPrice) break;
  }
  return { output, consumed: amountIn - left, nextSqrtPrice: current };
}

/** DBC: the most SOL one buy may add before √P passes `targetSqrtPrice` (capped at `stopSqrtPrice`), rounded down. */
export function dbcMaxQuoteIn(
  curve: readonly CurvePoint[],
  sqrtPrice: bigint,
  stopSqrtPrice: bigint,
  targetSqrtPrice: bigint,
): bigint {
  const end = min(u128(targetSqrtPrice, 'targetSqrtPrice'), u128(stopSqrtPrice, 'stopSqrtPrice'));
  let total = 0n;
  let current = u128(sqrtPrice, 'sqrtPrice');
  for (const point of curve) {
    if (point.sqrtPrice === 0n || point.liquidity === 0n || current >= end) break;
    const upper = min(end, point.sqrtPrice);
    if (upper <= current) continue;
    total += deltaQuote(current, upper, point.liquidity, false);
    if (total > U256_MAX) throw new EpochMathError('dbcMaxQuoteIn');
    current = upper;
  }
  return min(total, U64_MAX);
}

/** DAMM v2 concentrated pool (collect-fee modes 0 and 1): token A out for `amountIn` of token B (SOL). */
export function dammConcentratedBuy(
  sqrtPrice: bigint,
  liquidity: bigint,
  sqrtMaxPrice: bigint,
  amountIn: bigint,
): BuyFill {
  const next = nextSqrtFromQuoteIn(sqrtPrice, liquidity, amountIn);
  if (next > u128(sqrtMaxPrice, 'sqrtMaxPrice')) throw new EpochMathError('dammConcentratedBuy');
  const output = toU64Checked(deltaBase(sqrtPrice, next, liquidity, false), 'dammConcentratedBuy');
  return { output, consumed: amountIn, nextSqrtPrice: next };
}

/** DAMM v2 concentrated pool: the most SOL one buy may add before √P passes `targetSqrtPrice` (or the range top). */
export function dammConcentratedMaxQuoteIn(
  sqrtPrice: bigint,
  liquidity: bigint,
  sqrtMaxPrice: bigint,
  targetSqrtPrice: bigint,
): bigint {
  const end = min(u128(targetSqrtPrice, 'targetSqrtPrice'), u128(sqrtMaxPrice, 'sqrtMaxPrice'));
  if (end <= u128(sqrtPrice, 'sqrtPrice')) return 0n;
  return min(deltaQuote(sqrtPrice, end, liquidity, false), U64_MAX);
}

/** DAMM v2 compounding pool (collect-fee mode 2): `out = a × in / (b + in)`, rounded down. */
export function dammCompoundingBuy(reserveA: bigint, reserveB: bigint, amountIn: bigint): BuyFill {
  u64(reserveA, 'reserveA');
  u64(reserveB, 'reserveB');
  u64(amountIn, 'amountIn');
  const den = reserveB + amountIn;
  if (den === 0n) throw new EpochMathError('dammCompoundingBuy');
  return {
    output: toU64Checked((reserveA * amountIn) / den, 'dammCompoundingBuy'),
    consumed: amountIn,
    nextSqrtPrice: 0n,
  };
}

/** Compounding pool: SOL that raises √P by `maxImpactBps / 2` (`b × maxImpactBps / 20,000`). */
export function dammCompoundingMaxQuoteIn(reserveB: bigint, maxImpactBps: number): bigint {
  return min((u64(reserveB, 'reserveB') * uint(maxImpactBps, 16, 'maxImpactBps')) / 20_000n, U64_MAX);
}

/** The √P a slice may reach: `√P × (1 + maxImpactBps / 20,000)`, rounded down (≈ `maxImpactBps` on the price). */
export function impactTargetSqrtPrice(sqrtPrice: bigint, maxImpactBps: number): bigint {
  const next = u128(sqrtPrice, 'sqrtPrice') + (sqrtPrice * uint(maxImpactBps, 16, 'maxImpactBps')) / 20_000n;
  if (next > U128_MAX) throw new EpochMathError('impactTargetSqrtPrice');
  return next;
}

/** The lowest `min_amount_out` the program accepts: `feeFreeOut × (1 − maxSlippageBps)`, rounded up, at least 1. */
export function minOutFloor(feeFreeOut: bigint, maxSlippageBps: number): bigint {
  u64(feeFreeOut, 'feeFreeOut');
  const slippage = uint(maxSlippageBps, 16, 'maxSlippageBps');
  if (slippage > BPS) throw new EpochMathError('minOutFloor');
  const v = (feeFreeOut * (BPS - slippage) + BPS - 1n) / BPS;
  return v > 1n ? v : 1n;
}

// ─── One buyback slice, as `execute_buyback` computes it ──────────────────

/** A revenue token's venue, as `execute_buyback` reads it (raw on-chain values). */
export type BuybackVenueState =
  | {
      kind: 'dbc';
      sqrtPrice: bigint;
      quoteReserve: bigint;
      isMigrated: boolean;
      /** From the DBC config. */
      migrationSqrtPrice: bigint;
      migrationQuoteThreshold: bigint;
      curve: readonly CurvePoint[];
    }
  | {
      kind: 'dammV2';
      sqrtPrice: bigint;
      liquidity: bigint;
      sqrtMaxPrice: bigint;
      /** 0 BothToken, 1 OnlyB, 2 Compounding. */
      collectFeeMode: number;
      tokenAAmount: bigint;
      tokenBAmount: bigint;
      /** 0 = trading enabled. */
      poolStatus: number;
    };

export interface BuybackSliceInput {
  /** The current epoch. */
  epoch: bigint;
  /** The `RevenueToken` fields the slice reads. */
  revenueToken: {
    buybackEpoch: bigint;
    epochBudget: bigint;
    epochSpent: bigint;
    slicesPerEpoch: number;
    slicesDone: number;
    maxSlippageBps: number;
    maxImpactBps: number;
  };
  /** Escrow lamports above its rent-exempt minimum. */
  escrowAvailable: bigint;
  slice: number;
  venue: BuybackVenueState;
}

/** Why a slice cannot run now, as the program's error name. */
export type BuybackSkipReason = 'SliceAlreadyExecuted' | 'PoolNotSynced' | 'VenueNotTrading' | 'NothingToBuy';

export type BuybackSlicePlan =
  | {
      status: 'ready';
      /** SOL the slice spends (DBC may use less: partial fill at the migration price). */
      amount: bigint;
      /** Tokens out before fees, from the same state the program will read. */
      feeFreeOut: bigint;
      /** The lowest `min_amount_out` the program accepts. */
      floor: bigint;
      nextSqrtPrice: bigint;
    }
  | { status: 'skip'; reason: BuybackSkipReason };

/**
 * Mirror of `execute_buyback` from the budget to the min-out floor: the epoch budget (reset on a new epoch), the slice
 * budget, the impact cap and the fee-free fill. Timing, the sweep check and the pause flag are the caller's (see
 * `sliceTiming`). The program re-reads the pool when it runs, so a quote taken now is exact only if nothing trades in
 * between.
 */
export function planBuybackSlice(input: BuybackSliceInput): BuybackSlicePlan {
  const { revenueToken: rt, venue } = input;
  const slice = Number(uint(input.slice, 8, 'slice'));
  if (slice >= rt.slicesPerEpoch) throw new RangeError(`slice ${slice} is out of range (InvalidSlice)`);
  const fresh = rt.buybackEpoch !== u64(input.epoch, 'epoch');
  const budget = fresh ? input.escrowAvailable : rt.epochBudget;
  const spent = fresh ? 0n : rt.epochSpent;
  const slicesDone = fresh ? 0 : rt.slicesDone;
  if (((slicesDone >>> slice) & 1) === 1) return { status: 'skip', reason: 'SliceAlreadyExecuted' };
  let amount = sliceBudget(budget, spent, rt.slicesPerEpoch, slicesDone, input.escrowAvailable);
  let fill: BuyFill;
  if (venue.kind === 'dbc') {
    if (venue.isMigrated) return { status: 'skip', reason: 'PoolNotSynced' };
    if (venue.quoteReserve >= venue.migrationQuoteThreshold) return { status: 'skip', reason: 'VenueNotTrading' };
    const target = impactTargetSqrtPrice(venue.sqrtPrice, rt.maxImpactBps);
    amount = min(amount, dbcMaxQuoteIn(venue.curve, venue.sqrtPrice, venue.migrationSqrtPrice, target));
    if (amount === 0n) return { status: 'skip', reason: 'NothingToBuy' };
    fill = dbcBuy(venue.curve, venue.sqrtPrice, venue.migrationSqrtPrice, amount);
  } else {
    if (venue.poolStatus !== 0) return { status: 'skip', reason: 'VenueNotTrading' };
    if (venue.collectFeeMode === 2) {
      amount = min(amount, dammCompoundingMaxQuoteIn(venue.tokenBAmount, rt.maxImpactBps));
      if (amount === 0n) return { status: 'skip', reason: 'NothingToBuy' };
      fill = dammCompoundingBuy(venue.tokenAAmount, venue.tokenBAmount, amount);
    } else {
      const target = impactTargetSqrtPrice(venue.sqrtPrice, rt.maxImpactBps);
      amount = min(amount, dammConcentratedMaxQuoteIn(venue.sqrtPrice, venue.liquidity, venue.sqrtMaxPrice, target));
      if (amount === 0n) return { status: 'skip', reason: 'NothingToBuy' };
      fill = dammConcentratedBuy(venue.sqrtPrice, venue.liquidity, venue.sqrtMaxPrice, amount);
    }
  }
  if (fill.output === 0n) return { status: 'skip', reason: 'NothingToBuy' };
  return {
    status: 'ready',
    amount,
    feeFreeOut: fill.output,
    floor: minOutFloor(fill.output, rt.maxSlippageBps),
    nextSqrtPrice: fill.nextSqrtPrice,
  };
}

// ─── Treasury claims: what DBC pays the partner (`math/treasury.rs`) ──────

const SURPLUS_SHARE = BigInt(PROGRAM_CONSTANTS.DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE);

function sub(a: bigint, b: bigint, fn: string): bigint {
  if (b > a) throw new EpochMathError(fn);
  return a - b;
}

function add(a: bigint, b: bigint, fn: string): bigint {
  return toU64(a + b, fn);
}

/** DBC `split_partner_and_creator_fee`, partner side: `fee` less the creator's percentage of it (rounded down). */
export function dbcPartnerPart(fee: bigint, creatorTradingFeePercentage: number): bigint {
  u64(fee, 'fee');
  const pct = uint(creatorTradingFeePercentage, 8, 'creatorTradingFeePercentage');
  if (pct === 0n) return fee;
  return sub(fee, mulDiv(fee, pct, 100n), 'dbcPartnerPart');
}

/**
 * DBC `get_partner_surplus`: of the quote above the migration threshold, partner and creator share 80% (rounded
 * down), split by the creator's trading-fee percentage. Throws while the curve is not complete.
 */
export function dbcPartnerSurplus(
  quoteReserve: bigint,
  migrationQuoteThreshold: bigint,
  creatorTradingFeePercentage: number,
): bigint {
  const total = sub(
    u64(quoteReserve, 'quoteReserve'),
    u64(migrationQuoteThreshold, 'migrationQuoteThreshold'),
    'dbcPartnerSurplus',
  );
  return dbcPartnerPart(mulDiv(total, SURPLUS_SHARE, 100n), creatorTradingFeePercentage);
}

/**
 * DBC `get_migration_fee_distribution`, partner side: the fee is `threshold − ceil(threshold × (100 − fee%) / 100)`,
 * less the creator's `creatorMigrationFeePercentage` of it (rounded down).
 */
export function dbcPartnerMigrationFee(
  migrationQuoteThreshold: bigint,
  migrationFeePercentage: number,
  creatorMigrationFeePercentage: number,
): bigint {
  const threshold = u64(migrationQuoteThreshold, 'migrationQuoteThreshold');
  const keptPct = sub(100n, uint(migrationFeePercentage, 8, 'migrationFeePercentage'), 'dbcPartnerMigrationFee');
  const quoteAmount = toU64(
    (mul128(threshold, keptPct, 'dbcPartnerMigrationFee') + 99n) / 100n,
    'dbcPartnerMigrationFee',
  );
  const fee = sub(threshold, quoteAmount, 'dbcPartnerMigrationFee');
  const creatorPct = uint(creatorMigrationFeePercentage, 8, 'creatorMigrationFeePercentage');
  return sub(fee, mulDiv(fee, creatorPct, 100n), 'dbcPartnerMigrationFee');
}

/** DBC `withdraw_leftover`: the base vault less the unclaimed base fees and the protocol's migration base fee. */
export function dbcLeftover(
  baseVaultAmount: bigint,
  partnerBaseFee: bigint,
  protocolBaseFee: bigint,
  creatorBaseFee: bigint,
  protocolMigrationBaseFeeAmount: bigint,
): bigint {
  const fees = add(
    add(u64(partnerBaseFee, 'partnerBaseFee'), u64(protocolBaseFee, 'protocolBaseFee'), 'dbcLeftover'),
    u64(creatorBaseFee, 'creatorBaseFee'),
    'dbcLeftover',
  );
  return sub(
    sub(u64(baseVaultAmount, 'baseVaultAmount'), fees, 'dbcLeftover'),
    u64(protocolMigrationBaseFeeAmount, 'protocolMigrationBaseFeeAmount'),
    'dbcLeftover',
  );
}
