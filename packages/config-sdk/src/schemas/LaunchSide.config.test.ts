import { loadConfig } from '../loadConfig';
import { DEFAULT_LAUNCH_CLAIM_KINDS, LaunchClaimsConfigSchema } from './LaunchClaims.config';
import { LaunchPageConfigSchema } from './LaunchPage.config';

describe('LaunchClaimsConfigSchema', () => {
  it('is off by default, and claims everything (the leftover is burned) when on', () => {
    const config = loadConfig(LaunchClaimsConfigSchema, {});
    expect(config).toMatchObject({
      LAUNCH_CLAIMS_ENABLED: false,
      LAUNCH_CLUSTER: 'devnet',
      LAUNCH_RPC_URL: 'https://api.devnet.solana.com',
      LAUNCH_CREATOR_KEYPAIR_PATHS: [],
      LAUNCH_CLAIM_MIN_SOL: 0.001,
      LAUNCH_CLAIM_INTERVAL_MINUTES: 30,
      LAUNCH_CLAIMS_DRY_RUN: false,
      LAUNCH_CLAIM_CU_PRICE_MICROLAMPORTS: 10_000,
    });
    expect(config.LAUNCH_CLAIM_KINDS).toEqual(DEFAULT_LAUNCH_CLAIM_KINDS);
    expect(config.LAUNCH_CLAIM_KINDS).toContain('leftover');
    expect(config.TREASURY_KEYPAIR_PATH).toBeUndefined();
  });

  it('needs the registry when enabled, and reads the lists', () => {
    expect(() => loadConfig(LaunchClaimsConfigSchema, { LAUNCH_CLAIMS_ENABLED: 'true' })).toThrow('LAUNCHES_PATH');
    const config = loadConfig(LaunchClaimsConfigSchema, {
      LAUNCH_CLAIMS_ENABLED: 'true',
      LAUNCHES_PATH: '/srv/epoch/launches.json',
      LAUNCH_CLUSTER: 'mainnet',
      EPOCH_RPC_URL: 'https://rpc.example',
      LAUNCH_CREATOR_KEYPAIR_PATHS: ' /keys/a.json, /keys/b.json ,',
      LAUNCH_CLAIM_KINDS: 'partnerTradingFee,lpFee,leftover',
    });
    expect(config).toMatchObject({
      LAUNCH_CLAIMS_ENABLED: true,
      LAUNCH_CLUSTER: 'mainnet',
      LAUNCH_RPC_URL: 'https://rpc.example',
      LAUNCH_CREATOR_KEYPAIR_PATHS: ['/keys/a.json', '/keys/b.json'],
      LAUNCH_CLAIM_KINDS: ['partnerTradingFee', 'lpFee', 'leftover'],
    });
    expect(loadConfig(LaunchClaimsConfigSchema, { LAUNCH_RPC_URL: 'https://pools.example' }).LAUNCH_RPC_URL).toBe(
      'https://pools.example',
    );
  });

  it('refuses unknown claim kinds and bad flags', () => {
    expect(() => loadConfig(LaunchClaimsConfigSchema, { LAUNCH_CLAIM_KINDS: 'partnerTradingFee,everything' })).toThrow(
      'unknown claim kinds: everything',
    );
    expect(() => loadConfig(LaunchClaimsConfigSchema, { LAUNCH_CLAIMS_DRY_RUN: 'yes' })).toThrow(
      'LAUNCH_CLAIMS_DRY_RUN',
    );
  });
});

describe('LaunchPageConfigSchema', () => {
  it('reads the realtime feed settings', () => {
    const config = loadConfig(LaunchPageConfigSchema, {
      LAUNCH_REALTIME: 'websocket',
      LAUNCH_RPC_WS_URL: ' ws://127.0.0.1:38900 ',
      LAUNCH_TRADES_BACKSTOP_SECONDS: '90',
    });
    expect(config).toMatchObject({
      LAUNCH_REALTIME: 'websocket',
      LAUNCH_RPC_WS_URL: 'ws://127.0.0.1:38900',
      LAUNCH_TRADES_BACKSTOP_SECONDS: 90,
    });
    expect(() => loadConfig(LaunchPageConfigSchema, { LAUNCH_REALTIME: 'firehose' })).toThrow('LAUNCH_REALTIME');
    expect(loadConfig(LaunchPageConfigSchema, { LAUNCH_RPC_WS_URL: '' }).LAUNCH_RPC_WS_URL).toBeUndefined();
  });

  it('defaults the ingest, caches and ticket guardrails', () => {
    expect(loadConfig(LaunchPageConfigSchema, {})).toEqual({
      LAUNCH_TRADES_INGEST: true,
      LAUNCH_TRADES_POLL_SECONDS: 10,
      LAUNCH_REALTIME: 'auto',
      LAUNCH_RPC_WS_URL: undefined,
      LAUNCH_TRADES_BACKSTOP_SECONDS: 60,
      LAUNCH_TRADES_BACKFILL_LIMIT: 1_000,
      LAUNCH_MARKET_CACHE_SECONDS: 10,
      LAUNCH_STALE_SECONDS: 120,
      LAUNCH_TRADE_MAX_SOL: 10,
      LAUNCH_TRADE_REQUESTS_PER_MINUTE: 30,
      LAUNCH_TRADE_PRIORITY_MICROLAMPORTS: 100_000,
      LAUNCH_INDEXED_DATA: 'auto',
      LAUNCH_DAMM_DATA_API_URL: 'https://damm-v2.datapi.meteora.ag',
    });
  });

  it('bounds the poll interval', () => {
    expect(
      loadConfig(LaunchPageConfigSchema, { LAUNCH_TRADES_INGEST: 'false', LAUNCH_TRADES_POLL_SECONDS: '3' }),
    ).toMatchObject({
      LAUNCH_TRADES_INGEST: false,
      LAUNCH_TRADES_POLL_SECONDS: 3,
    });
    expect(() => loadConfig(LaunchPageConfigSchema, { LAUNCH_TRADES_POLL_SECONDS: '1' })).toThrow(
      'LAUNCH_TRADES_POLL_SECONDS',
    );
  });
});
