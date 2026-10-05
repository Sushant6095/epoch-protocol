/**
 * USDC amounts without floating point. Panta uses two formats (https://docs.panta.market/index.md → Amounts):
 * create-market fees are base units as integer strings (`"50000000"` = 50 USDC, 6 decimals); primary buys are
 * human decimal strings (`"20.00"`).
 */

export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);
const DECIMAL = /^(\d{1,15})(?:\.(\d{1,6}))?$/;

/** True for a positive decimal with at most 6 decimals ("20", "20.5", "0.000001"). */
export function isUsdcAmount(text: string): boolean {
  if (typeof text !== 'string' || !DECIMAL.test(text.trim())) return false;
  return usdcToBase(text) > 0n;
}

/** "20.00" → 20_000_000n. Throws on negatives, exponents or more than 6 decimals. */
export function usdcToBase(text: string): bigint {
  const match = DECIMAL.exec(String(text).trim());
  if (!match) throw new RangeError(`Not a USDC amount: "${String(text).slice(0, 32)}"`);
  const [, whole, fraction = ''] = match;
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, '0'));
}

/** An integer string or number of base units ("50000000", 50000000) → 50_000_000n. */
export function baseUnits(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new RangeError(`Not a base-unit integer: "${text.slice(0, 32)}"`);
  return BigInt(text);
}

/**
 * 20_000_000n → "20.00": at least `minDecimals` (default 2), more only when the amount needs them (at most 6).
 */
export function baseToUsdc(base: bigint, minDecimals = 2): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / SCALE;
  let fraction = (abs % SCALE).toString().padStart(USDC_DECIMALS, '0');
  while (fraction.length > minDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const body = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/**
 * A catalog trade amount (`yesAmount`, `noAmount`, `feePaid` of GET /markets/{id}/trades/) as a decimal string. The
 * live API sends 1e6 base units ("10500000" → "10.5"; Panta's playground divides them by 1e6) while the docs example
 * shows decimals ("10.00", kept as is): an integer is read as base units, anything with a point as a decimal. Null when
 * absent or unreadable.
 */
export function catalogAmount(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return baseToUsdc(BigInt(text), 0);
  return /^\d+\.\d+$/.test(text) ? text : null;
}

/** A decimal string from the API as a number, for display maths only (prices, shares). NaN when unreadable. */
export function decimalToNumber(text: string | null | undefined): number {
  if (text === null || text === undefined || text.trim() === '') return Number.NaN;
  return Number(text);
}
