import {
  assessmentYear,
  financialYear,
  financialYearAt,
  financialYearMonths,
  financialYearsUpTo,
  istDate,
  istDateTime,
  istMonth,
  monthLabel,
  parseFinancialYear,
} from './IndianFy';

describe('Indian financial year (IST)', () => {
  it('starts on 1 April 00:00 IST, not at midnight UTC', () => {
    // 31 Mar 23:59 IST is 18:29 UTC on 31 Mar; 1 Apr 00:00 IST is 18:30 UTC on 31 Mar (still 31 Mar in UTC).
    expect(financialYearAt(Date.parse('2026-03-31T23:59:00+05:30')).label).toBe('2025-26');
    expect(financialYearAt(Date.parse('2026-03-31T23:59:59.999+05:30')).label).toBe('2025-26');
    expect(financialYearAt(Date.parse('2026-04-01T00:00:00+05:30')).label).toBe('2026-27');
    expect(financialYearAt(Date.parse('2026-03-31T18:30:00Z')).label).toBe('2026-27');
    expect(financialYearAt(Date.parse('2026-03-31T18:29:59Z')).label).toBe('2025-26');
    expect(financialYearAt(Date.parse('2027-01-15T12:00:00+05:30')).label).toBe('2026-27');
  });

  it('gives the bounds in epoch ms, end exclusive', () => {
    const fy = financialYear(2026);
    expect(fy).toEqual({
      label: '2026-27',
      startYear: 2026,
      startMs: Date.parse('2026-04-01T00:00:00+05:30'),
      endMs: Date.parse('2027-04-01T00:00:00+05:30'),
    });
    expect(financialYear(2099).label).toBe('2099-00');
    expect(assessmentYear(fy)).toBe('AY 2027-28');
  });

  it('reads the ways people write a year', () => {
    expect(parseFinancialYear('2025-26')?.startYear).toBe(2025);
    expect(parseFinancialYear('2025-2026')?.startYear).toBe(2025);
    expect(parseFinancialYear('FY2025-26')?.label).toBe('2025-26');
    expect(parseFinancialYear(' fy 2025-26 ')?.label).toBe('2025-26');
    for (const bad of ['2025-27', '2025', '2025-26-27', 'abcd-ef', '2025-2027', '']) {
      expect(parseFinancialYear(bad)).toBeNull();
    }
  });

  it('lists the years with rewards, newest first', () => {
    expect(financialYearsUpTo(Date.parse('2026-10-03T18:15:00+05:30')).map((fy) => fy.label)).toEqual([
      '2026-27',
      '2025-26',
      '2024-25',
      '2023-24',
      '2022-23',
      '2021-22',
      '2020-21',
    ]);
  });

  it('prints dates and months in IST', () => {
    const ms = Date.parse('2026-10-01T19:11:02+05:30');
    expect([istDate(ms), istDateTime(ms), istMonth(ms)]).toEqual(['2026-10-01', '2026-10-01 19:11:02', '2026-10']);
    // 31 Mar 20:00 UTC is already 1 April in India.
    expect(istDate(Date.parse('2026-03-31T20:00:00Z'))).toBe('2026-04-01');
    expect(monthLabel('2027-03')).toBe('Mar 2027');
    const months = financialYearMonths(financialYear(2026));
    expect([months[0], months[8], months[9], months[11], months.length]).toEqual([
      '2026-04',
      '2026-12',
      '2027-01',
      '2027-03',
      12,
    ]);
  });
});
