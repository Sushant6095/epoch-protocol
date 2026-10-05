import { loadConfig } from '../loadConfig';
import { BuybackConfigSchema } from './Buyback.config';

describe('BuybackConfigSchema', () => {
  it('defaults to buybacks on, 1% below a fresh quote, 3 attempts, 300k compute units', () => {
    expect(loadConfig(BuybackConfigSchema, {})).toEqual({
      BUYBACK_ENABLED: true,
      BUYBACK_SLIPPAGE_BPS: 100,
      BUYBACK_MAX_ATTEMPTS: 3,
      BUYBACK_COMPUTE_UNITS: 300_000,
    });
  });

  it('parses overrides and refuses values outside their bounds', () => {
    expect(loadConfig(BuybackConfigSchema, { BUYBACK_ENABLED: 'false', BUYBACK_SLIPPAGE_BPS: '50' })).toMatchObject({
      BUYBACK_ENABLED: false,
      BUYBACK_SLIPPAGE_BPS: 50,
    });
    expect(() => loadConfig(BuybackConfigSchema, { BUYBACK_SLIPPAGE_BPS: '2001' })).toThrow('BUYBACK_SLIPPAGE_BPS');
    expect(() => loadConfig(BuybackConfigSchema, { BUYBACK_COMPUTE_UNITS: '100000' })).toThrow('BUYBACK_COMPUTE_UNITS');
    expect(() => loadConfig(BuybackConfigSchema, { BUYBACK_ENABLED: 'yes' })).toThrow('BUYBACK_ENABLED');
  });
});
