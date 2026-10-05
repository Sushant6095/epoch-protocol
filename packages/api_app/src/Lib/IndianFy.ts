/**
 * India's financial year runs 1 April 00:00 IST to 31 March 23:59:59 IST and is written `2026-27`; the assessment year
 * that taxes it is the next one (`AY 2027-28`). Every date here is India Standard Time (UTC+05:30, no daylight saving).
 */

const IST_OFFSET_MS = 330 * 60_000;
/** The first year with Solana staking rewards (inflation started in February 2021, within FY 2020-21). */
export const FIRST_FY_START_YEAR = 2020;

export interface FinancialYear {
  /** `2026-27` */
  label: string;
  startYear: number;
  /** 1 April 00:00 IST, epoch ms. */
  startMs: number;
  /** The next 1 April 00:00 IST, epoch ms (exclusive). */
  endMs: number;
}

const label = (startYear: number): string => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

export function financialYear(startYear: number): FinancialYear {
  return {
    label: label(startYear),
    startYear,
    startMs: Date.UTC(startYear, 3, 1) - IST_OFFSET_MS,
    endMs: Date.UTC(startYear + 1, 3, 1) - IST_OFFSET_MS,
  };
}

/** The financial year a moment falls in, by the IST calendar. */
export function financialYearAt(ms: number): FinancialYear {
  const ist = new Date(ms + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  return financialYear(ist.getUTCMonth() >= 3 ? year : year - 1);
}

/** Reads `2026-27`, `2026-2027` or `FY2026-27`; null for anything else (the two years must be consecutive). */
export function parseFinancialYear(text: string): FinancialYear | null {
  const match = /^(?:FY\s?)?(\d{4})-(\d{2}|\d{4})$/i.exec(text.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const expected = match[2].length === 2 ? (start + 1) % 100 : start + 1;
  return end === expected ? financialYear(start) : null;
}

/** `AY 2027-28` for FY 2026-27. */
export const assessmentYear = (fy: FinancialYear): string => `AY ${label(fy.startYear + 1)}`;

/** The financial years with staking rewards up to the one containing `now`, newest first. */
export function financialYearsUpTo(now: number): FinancialYear[] {
  const current = financialYearAt(now).startYear;
  const years: FinancialYear[] = [];
  for (let year = current; year >= FIRST_FY_START_YEAR; year--) years.push(financialYear(year));
  return years;
}

function istParts(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString();
}

/** `2026-10-02` in IST. */
export const istDate = (ms: number): string => istParts(ms).slice(0, 10);

/** `2026-10-02 23:49:59` in IST. */
export const istDateTime = (ms: number): string => istParts(ms).slice(0, 19).replace('T', ' ');

/** `2026-10` in IST. */
export const istMonth = (ms: number): string => istParts(ms).slice(0, 7);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct 2026` for `2026-10`. */
export const monthLabel = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** The months of a financial year in order, `2026-04` … `2027-03`. */
export function financialYearMonths(fy: FinancialYear): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = (3 + i) % 12;
    const year = fy.startYear + (i >= 9 ? 1 : 0);
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  });
}
