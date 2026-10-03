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
