import { formatInr, formatInrCompact, groupIndian, roundInr, rupees } from './Inr';

describe('Indian number formatting', () => {
  it('groups the last three digits, then pairs', () => {
    expect(['1', '12', '123', '1234', '12345', '123456', '1234567', '12345678', '123456789'].map(groupIndian)).toEqual([
      '1',
      '12',
      '123',
      '1,234',
      '12,345',
      '1,23,456',
      '12,34,567',
      '1,23,45,678',
      '12,34,56,789',
    ]);
  });

  it('writes rupees with paise', () => {
    expect(formatInr(12345678.9)).toBe('₹1,23,45,678.90');
    expect(formatInr(11496.63)).toBe('₹11,496.63');
    expect(formatInr(999.999)).toBe('₹1,000.00');
    expect(formatInr(1.005)).toBe('₹1.01');
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(-1234.5)).toBe('-₹1,234.50');
    expect(formatInr(-0.001)).toBe('₹0.00');
    expect(formatInr(1234.5678, 0)).toBe('₹1,235');
    expect([formatInr(null), formatInr(undefined), formatInr(Number.NaN)]).toEqual(['—', '—', '—']);
  });

  it('matches the runtime en-IN currency format', () => {
    const intl = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
    for (const value of [0.5, 12.34, 123456.78, 98765432.1, 1234567890.12])
      expect(formatInr(value)).toBe(intl.format(value));
  });

  it('writes headline figures in lakh and crore', () => {
    expect(formatInrCompact(56789.4)).toBe('₹56,789');
    expect(formatInrCompact(456000)).toBe('₹4.56 L');
    expect(formatInrCompact(12345678.9)).toBe('₹1.23 Cr');
    expect(formatInrCompact(51_133_000_000_000)).toBe('₹51,13,300.00 Cr');
    expect(formatInrCompact(-432733.95)).toBe('-₹4.33 L');
    expect(formatInrCompact(null)).toBe('—');
  });

  it('builds the Rupees shape, rounded to paise', () => {
    expect(rupees(267.0468)).toEqual({ inr: 267.05, formatted: '₹267.05', compact: '₹267' });
    expect(rupees(null)).toEqual({ inr: null, formatted: '—', compact: '—' });
    expect(roundInr(-19807.944)).toBe(-19807.94);
  });
});
