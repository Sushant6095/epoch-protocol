import { IndiaConfigSchema, loadConfig, MarketDataConfigSchema } from '@epoch/config-sdk';

import { getServices } from '..';
import { RateLimiter } from '../../Lib/RateLimiter';
import { StakewizSource } from '../../Sources/ExternalSources';
import { BinanceKlinesSource, CoinGeckoSource, FrankfurterSource } from '../../Sources/IndiaPriceSources';
import { InflationRewards } from '../InflationRewards';
import { optional } from '../MarketData';
import { EpochCalendar } from './EpochCalendar';
import { IndiaRewardsService } from './IndiaRewardsService';
import { IndiaValidatorService } from './IndiaValidators';
import { InrPriceService } from './InrPriceService';

/** The services behind /v1/india (the Superteam India track page). */
export interface IndiaServices {
  prices: InrPriceService;
  validators: IndiaValidatorService;
  rewards: IndiaRewardsService;
  /** Per-IP request limits on the wallet routes. */
  limits: { rewards: RateLimiter; csv: RateLimiter };
}

let indiaServices: IndiaServices | undefined;

/** One set per process, built on first use from IndiaConfig and the mainnet services of `getServices()`. */
export function getIndiaServices(): IndiaServices {
  if (indiaServices) return indiaServices;
  const config = loadConfig(IndiaConfigSchema);
  const marketConfig = loadConfig(MarketDataConfigSchema);
  const { market, solana, validators, profiles } = getServices();
  const prices = new InrPriceService({
    coingecko: new CoinGeckoSource(config.COINGECKO_API_URL, config.COINGECKO_API_KEY),
    solUsd: async () => ({ value: await market.solUsd.get(), loadedAtMs: market.solUsd.loadedAtMs }),
    usdInr: async () => ({ value: await market.usdInr.get(), loadedAtMs: market.usdInr.loadedAtMs }),
    usdHistory: new BinanceKlinesSource(config.INDIA_SOL_USD_HISTORY_URL),
    fxHistory: new FrankfurterSource(config.INDIA_FX_HISTORY_URL),
  });
  const currentEpoch = async (): Promise<number> => (await market.epochInfo.get()).epoch;
  const calendar = new EpochCalendar(new StakewizSource(marketConfig.STAKEWIZ_API_URL), currentEpoch);
  indiaServices = {
    prices,
    validators: new IndiaValidatorService({
      table: () => validators.get(),
      stakewiz: () => optional(market.stakewiz, new Map()),
      profile: (vote) => profiles.get(vote),
      prices,
      calendar,
      listedVotes: new Set(config.INDIA_VALIDATOR_VOTES),
    }),
    rewards: new IndiaRewardsService({
      stakeAccounts: (wallet) => solana.getStakeAccountsByAuthority(wallet),
      // Its own cache: a year of epochs per wallet would push My Stake's and the profiles' entries out.
      rewards: new InflationRewards(solana, 300_000),
      calendar,
      currentEpoch,
      prices,
      rpcConcurrency: config.INDIA_RPC_CONCURRENCY,
      newReadsPerHour: config.INDIA_NEW_WALLETS_PER_HOUR,
    }),
    limits: {
      rewards: new RateLimiter(config.INDIA_REWARDS_PER_MINUTE, 60_000),
      csv: new RateLimiter(config.INDIA_CSV_PER_MINUTE, 60_000),
    },
  };
  return indiaServices;
}

/** Replaces the process-wide set (tests); `undefined` rebuilds it on next use. */
export function setIndiaServices(services: IndiaServices | undefined): void {
  indiaServices = services;
}
