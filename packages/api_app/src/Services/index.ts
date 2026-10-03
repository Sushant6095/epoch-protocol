import {
  EpochProgramConfigSchema,
  loadConfig,
  MarketDataConfigSchema,
  ValidatorHistoryConfigSchema,
} from '@epoch/config-sdk';
import { PostgresConnectionManager } from '@epoch/pg_models';

import { dbAvailable } from '../Lib/Db';
import { JsonRpcClient } from '../Lib/Http';
import { EpochProgramSource } from '../Sources/EpochProgramSource';
import { JitoKobeSource, PriceSource, StakewizSource, TokenSource } from '../Sources/ExternalSources';
import { SolanaDataSource } from '../Sources/SolanaDataSource';
import { DelegatorLabels, keyBase64 } from './DelegatorLabels';
import { DelegatorScanService } from './DelegatorScanService';
import { DelegatorService } from './DelegatorService';
import { InflationRewards } from './InflationRewards';
import { MarketData } from './MarketData';
import { NetworkService } from './NetworkService';
import { MemoryEventStore, PgEventStore, type ProgramEventStore } from './Program/ProgramEventStore';
import { ValidatorHistoryRecorder } from './Validator/ValidatorHistoryRecorder';
import { PgValidatorHistoryStore } from './Validator/ValidatorHistoryStore';
import { ValidatorProfileService } from './Validator/ValidatorProfileService';
import { VoteRewardsWarmer } from './Validator/VoteRewardsWarmer';
import { ValidatorTable } from './ValidatorTable';
import { WalletStakeService } from './Wallet/WalletStakeService';

export interface ApiServices {
  /** Mainnet reads (RPC, Stakewiz, Jito, prices), shared by every mainnet service. */
  market: MarketData;
  solana: SolanaDataSource;
  /** The Epoch program on its own cluster (devnet for now). */
  program: EpochProgramSource;
  /** Ingested program events: Postgres when DATABASE_URL is set, else the last 5,000 in memory. */
  events: ProgramEventStore;
  network: NetworkService;
  validators: ValidatorTable;
  delegators: DelegatorService;
  scan: DelegatorScanService;
  labels: DelegatorLabels;
  /** Commission and stake per validator per epoch (Postgres); `start()` only with DATABASE_URL. */
  history: ValidatorHistoryRecorder;
  /** GET /v1/validators/:vote */
  profiles: ValidatorProfileService;
  /** Every validator's inflation commission for the last 10 epochs, read in the background for the profiles. */
  voteRewards: VoteRewardsWarmer;
  /** GET /v1/wallets/:address/stake */
  wallets: WalletStakeService;
}

let services: ApiServices | undefined;

/** One set of services per process, built from MarketDataConfig on first use. */
export function getServices(): ApiServices {
  if (services) return services;
  const config = loadConfig(MarketDataConfigSchema);
  const rpc = new JsonRpcClient([config.DATA_RPC_URL, config.DATA_RPC_FALLBACK_URL].filter((u): u is string => !!u));
  const solana = new SolanaDataSource(rpc);
  const market = new MarketData(
    solana,
    new StakewizSource(config.STAKEWIZ_API_URL),
    new JitoKobeSource(config.JITO_KOBE_API_URL),
    new PriceSource(config.PRICE_API_URL, config.FX_API_URL),
  );
  const labels = new DelegatorLabels(
    solana,
    new TokenSource(config.TOKEN_API_URL),
    config.DELEGATOR_LABELS_PATH,
    config.STAKE_POOL_PROGRAM_IDS,
  );
  const scan = new DelegatorScanService(solana, {
    enabled: config.DELEGATOR_SCAN_ENABLED,
    intervalHours: config.DELEGATOR_SCAN_INTERVAL_HOURS,
    concurrency: config.DELEGATOR_SCAN_CONCURRENCY,
    voteLimit: config.DELEGATOR_SCAN_VOTE_LIMIT,
    foundationKeys: new Set(config.FOUNDATION_AUTHORITIES.map(keyBase64)),
    // Name the largest owners (stake pools by token symbol) before the first request sees them.
    beforePublish: (snapshot) => labels.warm(snapshot.topOwners.map((owner) => owner.key)),
  });
  // Validator history, profiles and wallet stake (requests #5, #5b, #10, #10b).
  const historyConfig = loadConfig(ValidatorHistoryConfigSchema);
  const stakewizApi = new StakewizSource(config.STAKEWIZ_API_URL);
  const kobeApi = new JitoKobeSource(config.JITO_KOBE_API_URL);
  const history = new ValidatorHistoryRecorder(
    market,
    stakewizApi,
    dbAvailable() && historyConfig.VALIDATOR_HISTORY_ENABLED
      ? new PgValidatorHistoryStore(PostgresConnectionManager.getDb())
      : undefined,
    { backfill: historyConfig.VALIDATOR_HISTORY_BACKFILL },
  );
  // Separate caches, so wallets never push out the vote rewards the warmer read.
  const voteRewards = new InflationRewards(solana);
  const stakeRewards = new InflationRewards(solana, 200_000);

  const validators = new ValidatorTable(
    market,
    () => scan.latest,
    () => history.latest,
  );
  const program = new EpochProgramSource(loadConfig(EpochProgramConfigSchema));
  services = {
    market,
    solana,
    program,
    events: dbAvailable() ? new PgEventStore(PostgresConnectionManager.getDb()) : new MemoryEventStore(),
    network: new NetworkService(market, validators, () => scan.latest),
    validators,
    delegators: new DelegatorService(scan, labels, validators),
    scan,
    labels,
    history,
    profiles: new ValidatorProfileService(
      market,
      solana,
      validators,
      labels,
      voteRewards,
      stakewizApi,
      kobeApi,
      () => history.latest,
      new Set(config.FOUNDATION_AUTHORITIES.map(keyBase64)),
    ),
    voteRewards: new VoteRewardsWarmer(market, voteRewards),
    wallets: new WalletStakeService(market, solana, validators, stakeRewards, () => scan.latest),
  };
  return services;
}
