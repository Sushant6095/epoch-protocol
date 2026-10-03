import BN from 'bn.js';

import { fromBaseUnits, parseDecimal, toBaseUnits, toBigInt, toBN } from './units';

describe('units', () => {
  it('parses decimals exactly, exponents included', () => {
    expect(parseDecimal('0.1')).toEqual({ digits: 1n, scale: 1 });
    expect(parseDecimal(0.000624)).toEqual({ digits: 624n, scale: 6 });
    expect(parseDecimal(6.24e-7)).toEqual({ digits: 624n, scale: 9 });
    expect(parseDecimal('1.5e3')).toEqual({ digits: 1500n, scale: 0 });
    expect(parseDecimal('12')).toEqual({ digits: 12n, scale: 0 });
    expect(parseDecimal('.5')).toEqual({ digits: 5n, scale: 1 });
  });

  it('refuses negative, non-finite and malformed amounts', () => {
    expect(() => parseDecimal(-1)).toThrow(RangeError);
    expect(() => parseDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => parseDecimal(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => parseDecimal('1,5')).toThrow(RangeError);
    expect(() => parseDecimal('')).toThrow(RangeError);
    expect(() => parseDecimal('-0.1')).toThrow(RangeError);
  });

  it('converts UI amounts to base units without floating-point error, rounding down', () => {
    expect(toBaseUnits(0.1, 9)).toBe(100_000_000n);
    expect(toBaseUnits(0.1 + 0.2, 9)).toBe(300_000_000n);
    expect(toBaseUnits('1.23456789', 6)).toBe(1_234_567n);
    expect(toBaseUnits(100_000, 6)).toBe(100_000_000_000n);
    expect(toBaseUnits('0.0000000001', 9)).toBe(0n);
  });

  it('converts base units back to UI amounts', () => {
    expect(fromBaseUnits(1_234_567n, 6)).toBeCloseTo(1.234567, 12);
    expect(fromBaseUnits(new BN('5072175373'), 9)).toBeCloseTo(5.072175373, 12);
    expect(fromBaseUnits('100000000000', 6)).toBe(100_000);
    expect(fromBaseUnits(0, 9)).toBe(0);
  });

  it('moves between bigint and BN', () => {
    expect(toBN(123n).toString()).toBe('123');
    expect(toBigInt(new BN('18446744073709551616'))).toBe(18_446_744_073_709_551_616n);
    expect(toBigInt(12.9)).toBe(12n);
  });
});
