import { loadConfig, MarketDataConfigSchema } from '@epoch/config-sdk';

import { JsonRpcClient } from '../Lib/Http';
import { JitoKobeSource, PriceSource, StakewizSource, TokenSource } from '../Sources/ExternalSources';
import { SolanaDataSource } from '../Sources/SolanaDataSource';
import { DelegatorLabels, keyBase64 } from './DelegatorLabels';
import { DelegatorScanService } from './DelegatorScanService';
import { DelegatorService } from './DelegatorService';
import { MarketData } from './MarketData';
import { NetworkService } from './NetworkService';
import { ValidatorTable } from './ValidatorTable';

export interface ApiServices {
  network: NetworkService;
  validators: ValidatorTable;
  delegators: DelegatorService;
  scan: DelegatorScanService;
  labels: DelegatorLabels;
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
  const validators = new ValidatorTable(market, () => scan.latest);
  services = {
    network: new NetworkService(market, validators, () => scan.latest),
    validators,
    delegators: new DelegatorService(scan, labels, validators),
    scan,
    labels,
  };
  return services;
}
