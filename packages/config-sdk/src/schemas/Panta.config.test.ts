import { loadConfig } from '../loadConfig';
import { PantaBotConfigSchema, PantaTradingConfigSchema } from './Panta.config';

const KEY = 'pk_live_example0000000000';

describe('PantaTradingConfigSchema', () => {
  it('turns trading on exactly when a key is set, unless the flag says otherwise', () => {
    // .env.example leaves the variables empty: that is "unset", not an invalid URL.
    const off = loadConfig(PantaTradingConfigSchema, { PANTA_API_URL: '', PANTA_API_KEY: '' });
    expect(off).toMatchObject({
      PANTA_API_URL: 'https://live-api.panta.market/api/v1',
      PANTA_TRADING_ENABLED: false,
      PANTA_BLOCKED_COUNTRIES: [],
      PANTA_GEO_HEADERS: ['cf-ipcountry', 'x-vercel-ip-country'],
      PANTA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      PANTA_RATE_LIMIT_SHARE: 0.8,
      PANTA_STREAM_INTERVAL_SECONDS: 15,
    });
    expect(off.PANTA_API_KEY).toBeUndefined();
    expect(loadConfig(PantaTradingConfigSchema, { PANTA_API_KEY: KEY }).PANTA_TRADING_ENABLED).toBe(true);
    expect(
      loadConfig(PantaTradingConfigSchema, { PANTA_API_KEY: KEY, PANTA_TRADING_ENABLED: 'false' })
        .PANTA_TRADING_ENABLED,
    ).toBe(false);
  });

  it('validates the key format without echoing the key', () => {
    let message = '';
    try {
      loadConfig(PantaTradingConfigSchema, { PANTA_API_KEY: 'sk_secret_value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PANTA_API_KEY');
    expect(message).not.toContain('sk_secret_value');
  });

  it('parses the blocklist, the geo headers and the trade limits', () => {
    const config = loadConfig(PantaTradingConfigSchema, {
      PANTA_BLOCKED_COUNTRIES: 'us, gb ,',
      PANTA_GEO_HEADERS: 'CF-IPCountry',
      PANTA_MAX_TRADE_USDC: '250.5',
      DATA_RPC_URL: 'https://mainnet.example/rpc',
    });
    expect(config).toMatchObject({
      PANTA_BLOCKED_COUNTRIES: ['US', 'GB'],
      PANTA_GEO_HEADERS: ['cf-ipcountry'],
      PANTA_MAX_TRADE_USDC: '250.5',
      PANTA_RPC_URL: 'https://mainnet.example/rpc',
    });
    expect(() => loadConfig(PantaTradingConfigSchema, { PANTA_BLOCKED_COUNTRIES: 'USA' })).toThrow(
      'PANTA_BLOCKED_COUNTRIES',
    );
    expect(() => loadConfig(PantaTradingConfigSchema, { PANTA_STREAM_INTERVAL_SECONDS: '5' })).toThrow(
      'PANTA_STREAM_INTERVAL_SECONDS',
    );
    expect(() => loadConfig(PantaTradingConfigSchema, { PANTA_MAX_TRADE_USDC: '1e3' })).toThrow('PANTA_MAX_TRADE_USDC');
  });
});

describe('PantaBotConfigSchema', () => {
  it('defaults to one cost-aware market per epoch, two epochs ahead', () => {
    const config = loadConfig(PantaBotConfigSchema, {});
    expect(config).toMatchObject({
      PANTA_MARKETS_PER_EPOCH: 1,
      PANTA_EPOCHS_AHEAD: 2,
      PANTA_MAX_CREATE_USDC_PER_DAY: '100',
      PANTA_MIN_TRADING_HOURS: 6,
      PANTA_CLOSE_BEFORE_EPOCH_MINUTES: 60,
      PANTA_RESOLUTION_BUFFER_HOURS: 6,
      PANTA_RESOLUTION_GRACE_HOURS: 48,
      PANTA_TICK_SECONDS: 300,
      PANTA_DRY_RUN: false,
      PANTA_REGION: 'Global',
      PANTA_BOT_RATE_LIMIT_SHARE: 0.2,
      PANTA_USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      EPOCH_CLUSTER: 'devnet',
      PANTA_METHODOLOGY_URL: 'https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md',
    });
    expect(config.PANTA_BOT_KEYPAIR_PATH).toBeUndefined();
    expect(config.PUBLIC_API_URL).toBeUndefined();
  });

  it('prefers PANTA_RPC_URL over DATA_RPC_URL and validates amounts', () => {
    const config = loadConfig(PantaBotConfigSchema, {
      PANTA_RPC_URL: 'https://rpc-fast.example',
      DATA_RPC_URL: 'https://data.example',
      DATA_RPC_FALLBACK_URL: 'https://fallback.example',
      PANTA_DRY_RUN: 'true',
    });
    expect(config).toMatchObject({ PANTA_RPC_URL: 'https://rpc-fast.example', PANTA_DRY_RUN: true });
    expect(config.PANTA_RPC_FALLBACK_URL).toBeUndefined();
    expect(() => loadConfig(PantaBotConfigSchema, { PANTA_MAX_CREATE_USDC_PER_DAY: '-5' })).toThrow();
    expect(() => loadConfig(PantaBotConfigSchema, { PANTA_MARKETS_PER_EPOCH: '9' })).toThrow();
    expect(() => loadConfig(PantaBotConfigSchema, { PANTA_MARKET_IMAGE_URL: 'not a url' })).toThrow();
  });
});
