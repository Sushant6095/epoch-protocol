/**
 * Rupee amounts as India writes them: the last three digits, then pairs (₹1,23,45,678.90), and lakh / crore for
 * headline figures (₹45.60 L, ₹1,234.56 Cr). Pure string work, so it does not depend on the runtime's ICU data.
 */

const LAKH = 1e5;
const CRORE = 1e7;

/** Groups a string of digits the Indian way: `12345678` → `1,23,45,678`. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) pairs.unshift(rest);
  return `${pairs.join(',')},${lastThree}`;
}

/** `value` rounded half away from zero to `decimals` places, as a fixed-point string without sign. */
function fixed(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  // Nudge by a relative epsilon so binary fractions like 1.005 round the way people expect.
  return (Math.round(Math.abs(value) * factor * (1 + Number.EPSILON)) / factor).toFixed(decimals);
}

function signed(value: number, digits: string, suffix = ''): string {
  const isZero = /^[0.]*$/.test(digits.replace(/,/g, ''));
  return `${value < 0 && !isZero ? '-' : ''}₹${digits}${suffix}`;
}

/** `₹1,23,45,678.90`; `-₹1,234.50` for negatives; `—` when unknown. */
export function formatInr(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const [whole, fraction] = fixed(value, decimals).split('.');
  return signed(value, fraction === undefined ? groupIndian(whole) : `${groupIndian(whole)}.${fraction}`);
}

/** Headline form: `₹1,234.56 Cr` from a crore, `₹45.60 L` from a lakh, else whole rupees (`₹56,789`). */
export function formatInrCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= CRORE) return compact(value, CRORE, ' Cr');
  if (abs >= LAKH) return compact(value, LAKH, ' L');
  return formatInr(value, 0);
}

function compact(value: number, unit: number, suffix: string): string {
  const [whole, fraction] = fixed(value / unit, 2).split('.');
  return signed(value, `${groupIndian(whole)}.${fraction}`, suffix);
}

/** Rupees rounded to paise, or null. */
export const roundInr = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Number(fixed(value, 2)) * Math.sign(value);

/** A rupee amount with its display forms (the `Rupees` shape of the India API). */
export function rupees(value: number | null | undefined): { inr: number | null; formatted: string; compact: string } {
  const inr = roundInr(value);
  return { inr, formatted: formatInr(inr), compact: formatInrCompact(inr) };
}
