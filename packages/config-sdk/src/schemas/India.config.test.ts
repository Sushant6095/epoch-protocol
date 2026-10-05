import { loadConfig } from '../loadConfig';
import { IndiaConfigSchema } from './India.config';

describe('IndiaConfigSchema', () => {
  it('works with nothing set: public CoinGecko, no key, no listed validators', () => {
    expect(loadConfig(IndiaConfigSchema, {})).toEqual({
      COINGECKO_API_URL: 'https://api.coingecko.com/api/v3',
      COINGECKO_API_KEY: undefined,
      INDIA_SOL_USD_HISTORY_URL: 'https://data-api.binance.vision/api/v3/klines',
      INDIA_FX_HISTORY_URL: 'https://api.frankfurter.dev/v1',
      INDIA_VALIDATOR_VOTES: [],
      INDIA_REWARDS_PER_MINUTE: 60,
      INDIA_CSV_PER_MINUTE: 10,
      INDIA_NEW_WALLETS_PER_HOUR: 20,
      INDIA_RPC_CONCURRENCY: 3,
    });
  });

  it('treats the blank lines of .env.example as unset and reads the vote list', () => {
    const config = loadConfig(IndiaConfigSchema, {
      COINGECKO_API_KEY: '',
      INDIA_VALIDATOR_VOTES: ' voteA, ,voteB ',
      INDIA_RPC_CONCURRENCY: '5',
    });
    expect(config.COINGECKO_API_KEY).toBeUndefined();
    expect(config.INDIA_VALIDATOR_VOTES).toEqual(['voteA', 'voteB']);
    expect(config.INDIA_RPC_CONCURRENCY).toBe(5);
    expect(loadConfig(IndiaConfigSchema, { COINGECKO_API_KEY: ' CG-key ' }).COINGECKO_API_KEY).toBe('CG-key');
    expect(() => loadConfig(IndiaConfigSchema, { INDIA_RPC_CONCURRENCY: '0' })).toThrow('INDIA_RPC_CONCURRENCY');
  });
});
