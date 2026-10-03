/**
 * Exact conversions between UI amounts (SOL, tokens) and base units (lamports, token atoms), with bigint, so a UI
 * amount like 0.1 SOL becomes exactly 100,000,000 lamports. No floating point on the way into a transaction.
 */
import BN from 'bn.js';

/** A non-negative decimal as `digits × 10^-scale` (exact). */
export interface ExactDecimal {
  digits: bigint;
  scale: number;
}

const DECIMAL = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parses a non-negative decimal number or string exactly, including exponent notation (`6.24e-4`). Numbers are read
 * through their shortest round-trip string, so `0.1` is exactly one tenth.
 */
export function parseDecimal(value: number | string): ExactDecimal {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`expected a non-negative finite amount, got ${value}`);
  }
  const text = String(value).trim();
  const match = DECIMAL.exec(text);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) {
    throw new RangeError(`not a non-negative decimal amount: ${JSON.stringify(value)}`);
  }
  const [, whole, fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  let digits = BigInt(`${whole}${fraction}` || '0');
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** UI amount → base units, rounded down to `decimals` places. Throws on a negative or unreadable amount. */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const { digits, scale } = parseDecimal(amount);
  return scale <= decimals ? digits * 10n ** BigInt(decimals - scale) : digits / 10n ** BigInt(scale - decimals);
}

/** Base units → UI amount (a JS number: fine for display and math, not for building transactions). */
export function fromBaseUnits(amount: bigint | BN | string | number, decimals: number): number {
  const value = toBigInt(amount);
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const fraction = value % unit;
  return Number(whole) + Number(fraction) / Number(unit);
}

/** bigint (or an integer) → bn.js BN, the Meteora SDKs' integer type. */
export const toBN = (value: bigint | number | string): BN => new BN(toBigInt(value).toString());

/** BN, number or decimal-integer string → bigint (numbers are truncated toward zero). */
export function toBigInt(value: BN | bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value.toString());
}
