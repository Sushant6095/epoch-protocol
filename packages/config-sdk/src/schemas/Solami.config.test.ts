import { loadConfig } from '../loadConfig';
import { BeamConfigSchema, IndexerConfigSchema, LiveConfigSchema, SolamiApiConfigSchema } from './Solami.config';

describe('IndexerConfigSchema', () => {
  it('defaults to Solami gRPC in auto mode with public RPC as the fallback RPC', () => {
    const config = loadConfig(IndexerConfigSchema, {});
    expect(config).toMatchObject({
      SOLAMI_GRPC_URL: 'https://grpc.solami.dev',
      SLOT_SOURCE: 'auto',
      SOLAMI_GRPC_COMPRESSION: 'none',
      DATA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      GAP_FILL_RPS: 8,
      GAP_FILL_CONCURRENCY: 4,
      INDEXER_BACKFILL_EPOCH: false,
      RPC_SLOT_STRIDE: 1,
    });
    expect(config.SOLAMI_RPC_URL).toBeUndefined();
    expect(config.SOLAMI_TOKEN).toBeUndefined();
  });

  it('accepts host:port and URL forms of the gRPC endpoint', () => {
    expect(loadConfig(IndexerConfigSchema, { SOLAMI_GRPC_URL: 'grpc.solami.dev:443' }).SOLAMI_GRPC_URL).toBe(
      'https://grpc.solami.dev',
    );
    expect(loadConfig(IndexerConfigSchema, { SOLAMI_GRPC_URL: 'https://fra.grpc.solami.dev' }).SOLAMI_GRPC_URL).toBe(
      'https://fra.grpc.solami.dev',
    );
  });

  it('treats an empty SOLAMI_RPC_URL as unset and rejects a malformed one', () => {
    expect(loadConfig(IndexerConfigSchema, { SOLAMI_RPC_URL: '' }).SOLAMI_RPC_URL).toBeUndefined();
    expect(
      loadConfig(IndexerConfigSchema, { SOLAMI_RPC_URL: 'https://rpc.solami.dev/sol?api_key=k' }).SOLAMI_RPC_URL,
    ).toBe('https://rpc.solami.dev/sol?api_key=k');
    expect(() => loadConfig(IndexerConfigSchema, { SOLAMI_RPC_URL: 'rpc.solami.dev' })).toThrow('SOLAMI_RPC_URL');
    expect(() => loadConfig(IndexerConfigSchema, { SLOT_SOURCE: 'shreds' })).toThrow('SLOT_SOURCE');
  });
});

describe('BeamConfigSchema', () => {
  it('is off without a URL and enforces the 100,000 lamport tip floor', () => {
    const config = loadConfig(BeamConfigSchema, {});
    expect(config.SOLAMI_BEAM_URL).toBeUndefined();
    expect(config.SOLAMI_BEAM_TIP_LAMPORTS).toBe(100_000);
    expect(config.SOLAMI_TIP_ADDRESSES_URL).toBe('https://api.solami.dev/onchain/tip-addresses');
    expect(() => loadConfig(BeamConfigSchema, { SOLAMI_BEAM_TIP_LAMPORTS: '99999' })).toThrow(
      'SOLAMI_BEAM_TIP_LAMPORTS',
    );
  });
});

describe('LiveConfigSchema', () => {
  it('defaults the staleness window and the feed', () => {
    expect(loadConfig(LiveConfigSchema, {})).toEqual({ LIVE_STALE_AFTER_SECONDS: 20, LIVE_FEED_ENABLED: true });
  });
});

describe('SolamiApiConfigSchema', () => {
  it('streams through Solami when a key is set, with the same endpoint rules as the indexer', () => {
    expect(loadConfig(SolamiApiConfigSchema, {})).toEqual({
      SOLAMI_GRPC_URL: 'https://grpc.solami.dev',
      SOLAMI_TOKEN: undefined,
      SOLAMI_GRPC_COMPRESSION: 'none',
      SOLAMI_API_STREAM: true,
      SOLAMI_USAGE_STALE_SECONDS: 120,
    });
    const config = loadConfig(SolamiApiConfigSchema, {
      SOLAMI_GRPC_URL: 'grpc.solami.dev:443',
      SOLAMI_TOKEN: ' k ',
      SOLAMI_GRPC_COMPRESSION: 'zstd',
      SOLAMI_API_STREAM: 'false',
    });
    expect(config).toMatchObject({
      SOLAMI_GRPC_URL: 'https://grpc.solami.dev',
      SOLAMI_TOKEN: 'k',
      SOLAMI_GRPC_COMPRESSION: 'zstd',
      SOLAMI_API_STREAM: false,
    });
  });
});
