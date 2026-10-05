import { baseToUsdc, baseUnits, decimalToNumber, isUsdcAmount, usdcToBase } from './units';

describe('USDC units', () => {
  it('converts the two formats Panta uses without floating point', () => {
    expect(usdcToBase('20.00')).toBe(20_000_000n);
    expect(usdcToBase('0.000001')).toBe(1n);
    expect(usdcToBase(' 50 ')).toBe(50_000_000n);
    expect(baseUnits('50000000')).toBe(50_000_000n);
    expect(baseUnits(20_000_000)).toBe(20_000_000n);
    expect(baseToUsdc(50_000_000n)).toBe('50.00');
    expect(baseToUsdc(2_500_000n)).toBe('2.50');
    expect(baseToUsdc(1n)).toBe('0.000001');
    expect(baseToUsdc(123_450_000n, 0)).toBe('123.45');
    expect(baseToUsdc(-1_500_000n)).toBe('-1.50');
  });

  it('rejects what is not a plain positive amount', () => {
    for (const bad of ['-1', '1e6', '1.0000001', '', 'abc', '0x10']) expect(isUsdcAmount(bad)).toBe(false);
    expect(isUsdcAmount('0')).toBe(false);
    expect(isUsdcAmount('0.01')).toBe(true);
    expect(() => usdcToBase('1e6')).toThrow(RangeError);
    expect(() => baseUnits('50.5')).toThrow(RangeError);
    expect(decimalToNumber('0.52')).toBe(0.52);
    expect(decimalToNumber(null)).toBeNaN();
  });
});
