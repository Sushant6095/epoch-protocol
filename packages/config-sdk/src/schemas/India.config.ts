import { z } from '@epoch/common/pkg/zod';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

/**
 * The India page (Superteam India track): SOL in rupees, validators hosted in India and a wallet's staking rewards per
 * Indian financial year. Mainnet reads (RPC, Stakewiz, Jupiter, USD/INR) come from MarketDataConfigSchema; this adds
 * the rupee price sources and the limits on the wallet routes.
 */
export const IndiaConfigSchema = z.object({
  /** CoinGecko API v3: live SOL/INR (`simple/price`) and daily history (`market_chart`; 365 days on the free tier). */
  COINGECKO_API_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  /** Optional, sent only when set: a demo key (api.coingecko.com) or a paid one with COINGECKO_API_URL on pro-api. */
  COINGECKO_API_KEY: z
    .string()
    .optional()
    // `COINGECKO_API_KEY=` as in .env.example means unset.
    .transform((value) => value?.trim() || undefined),
  /** Daily SOL/USDT candles for dates CoinGecko cannot serve (over 365 days ago, or while it is down). */
  INDIA_SOL_USD_HISTORY_URL: z.string().url().default('https://data-api.binance.vision/api/v3/klines'),
  /** Daily USD/INR reference rates (European Central Bank) for those dates. */
  INDIA_FX_HISTORY_URL: z.string().url().default('https://api.frankfurter.dev/v1'),
  /** Vote accounts listed as Indian validators besides those Stakewiz geolocates in India (operator-declared). */
  INDIA_VALIDATOR_VOTES: csv,
  /** Requests per minute per IP to `/v1/india/wallets/:address/rewards` (the page polls while a year loads). */
  INDIA_REWARDS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  /** Requests per minute per IP to `/v1/india/wallets/:address/rewards.csv`. */
  INDIA_CSV_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),
  /** New wallet-year reads per IP per hour: each is one getInflationReward call per epoch (100–200 a year). */
  INDIA_NEW_WALLETS_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(20),
  /** getInflationReward calls in flight across every wallet read. */
  INDIA_RPC_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
});

export type IndiaConfig = z.infer<typeof IndiaConfigSchema>;
