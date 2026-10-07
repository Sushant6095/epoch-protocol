import {
  IndexerConfigSchema,
  type LaunchConfig,
  type LaunchPageConfig,
  LaunchPageConfigSchema,
  loadConfig,
} from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { DammDataApi } from '@epoch/meteora';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { ConnectionManager, type GrpcEndpoint } from '@epoch/solana';
import { Connection } from '@solana/web3.js';

import { getLaunchServices } from '.';
import { getServices } from '..';
import { dbAvailable } from '../../Lib/Db';
import { solamiWsUrl } from '../../Sources/EpochProgramSource';
import { RateLimiter } from '../../Lib/RateLimiter';
import { optional } from '../MarketData';
import { type StreamHub } from '../Stream/StreamHub';
import { RpcLaunchChainReader } from './LaunchChain';
import { LaunchIndexedSource } from './LaunchIndexedSource';
import { RpcLaunchLiveChain } from './LaunchLiveChain';
import { LaunchPageService } from './LaunchPageService';
import { GrpcRealtimeSource, type LaunchRealtimeSource, WebsocketRealtimeSource } from './LaunchRealtime';
import { LaunchTradeIngester } from './LaunchTradeIngester';
import { type LaunchTradeStore, MemoryLaunchTradeStore, PgLaunchTradeStore } from './LaunchTradeStore';
import { ProgramRevenueTokenSource, RpcRevenueTokenChain } from './RevenueTokenSource';
import { EventTreasuryClaimsSource } from './TreasuryClaimsSource';

export interface LaunchPageServices {
  config: LaunchPageConfig;
  page: LaunchPageService;
  /** launch_trades and launch_fee_events (Postgres; memory without DATABASE_URL). */
  trades: LaunchTradeStore;
  ingester: LaunchTradeIngester;
  /** Quotes and builds per IP. */
  tradeLimiter: RateLimiter;
}

let pageServices: LaunchPageServices | undefined;

const isLocal = (url: string): boolean => /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
const logger = Logger.create('LaunchLive');

/**
 * The trade feed's realtime source (LAUNCH_REALTIME): Yellowstone gRPC through Solami (mainnet launches with a key;
 * RPC Fast as failover), else the launch RPC's websocket; null for `off`.
 */
export function launchRealtimeSource(
  config: Pick<LaunchPageConfig, 'LAUNCH_REALTIME' | 'LAUNCH_RPC_WS_URL'>,
  launch: Pick<LaunchConfig, 'LAUNCH_CLUSTER' | 'LAUNCH_RPC_URL'>,
  env: Record<string, string | undefined> = process.env,
): LaunchRealtimeSource | null {
  if (config.LAUNCH_REALTIME === 'off') return null;
  const grpc = loadConfig(
    IndexerConfigSchema.pick({
      SOLAMI_GRPC_URL: true,
      SOLAMI_TOKEN: true,
      RPC_FAST_GRPC_URL: true,
      RPC_FAST_TOKEN: true,
      SOLAMI_GRPC_COMPRESSION: true,
    }),
    env,
  );
  // Solami streams mainnet: a devnet launch (or a local stand-in) uses the websocket.
  const grpcUsable = !!grpc.SOLAMI_TOKEN && launch.LAUNCH_CLUSTER === 'mainnet';
  if (config.LAUNCH_REALTIME === 'grpc' && !grpcUsable) {
    logger.warn('LAUNCH_REALTIME=grpc needs SOLAMI_TOKEN and a mainnet launch cluster: using the websocket');
  }
  if (grpcUsable && config.LAUNCH_REALTIME !== 'websocket') {
    const endpoints: GrpcEndpoint[] = [{ name: 'solami', url: grpc.SOLAMI_GRPC_URL, token: grpc.SOLAMI_TOKEN }];
    if (grpc.RPC_FAST_GRPC_URL) {
      endpoints.push({ name: 'rpcfast', url: grpc.RPC_FAST_GRPC_URL, token: grpc.RPC_FAST_TOKEN });
    }
    return new GrpcRealtimeSource(endpoints, {
      compression: grpc.SOLAMI_GRPC_COMPRESSION === 'none' ? undefined : grpc.SOLAMI_GRPC_COMPRESSION,
    });
  }
  return new WebsocketRealtimeSource(
    new Connection(launch.LAUNCH_RPC_URL, {
      commitment: 'confirmed',
      // Unset: web3.js swaps the scheme, which misses Solami's separate websocket host.
      wsEndpoint: config.LAUNCH_RPC_WS_URL ?? solamiWsUrl(launch.LAUNCH_RPC_URL),
    }),
  );
}

/**
 * Meteora's DAMM v2 data API for graduated pools (LAUNCH_INDEXED_DATA): it indexes mainnet only, so `auto` turns it on
 * for mainnet launches. Cached for a minute per pool and series.
 */
export function launchIndexedSource(
  config: Pick<LaunchPageConfig, 'LAUNCH_INDEXED_DATA' | 'LAUNCH_DAMM_DATA_API_URL'>,
  cluster: LaunchConfig['LAUNCH_CLUSTER'],
): { indexed: LaunchIndexedSource | null; indexedOff?: string } {
  if (config.LAUNCH_INDEXED_DATA === 'off') return { indexed: null, indexedOff: 'off (LAUNCH_INDEXED_DATA=off)' };
  if (config.LAUNCH_INDEXED_DATA === 'auto' && cluster !== 'mainnet') {
    return { indexed: null, indexedOff: `Meteora's data API indexes mainnet pools; this API serves ${cluster}` };
  }
  return {
    indexed: new LaunchIndexedSource(new DammDataApi({ baseUrl: config.LAUNCH_DAMM_DATA_API_URL }), { ttlMs: 60_000 }),
  };
}

/** The Launch page's services (plan F13), built from LaunchPageConfig and the launch services on first use. */
export function getLaunchPageServices(): LaunchPageServices {
  if (pageServices) return pageServices;
  const launchServices = getLaunchServices();
  const { config: launchConfig } = launchServices;
  const config = loadConfig(LaunchPageConfigSchema);
  const connections = new ConnectionManager(
    launchConfig.LAUNCH_RPC_URL,
    launchConfig.LAUNCH_RPC_FALLBACK_URL,
    'confirmed',
  );
  const trades: LaunchTradeStore = dbAvailable()
    ? new PgLaunchTradeStore(PostgresConnectionManager.getDb())
    : new MemoryLaunchTradeStore();
  const programSource = getServices().program;
  const live = new RpcLaunchLiveChain(
    connections,
    launchConfig.LAUNCH_RPC_URL,
    config.LAUNCH_TRADE_PRIORITY_MICROLAMPORTS,
  );
  // The ingester and the page service call each other (graduations, new trades): wire through closures.
  const wiring: { page?: LaunchPageService } = {};
  const ingester = new LaunchTradeIngester({
    chain: live,
    store: trades,
    launches: () => (wiring.page ? wiring.page.ingestLaunches() : Promise.resolve([])),
    pollMs: config.LAUNCH_TRADES_POLL_SECONDS * 1_000,
    backfillLimit: config.LAUNCH_TRADES_BACKFILL_LIMIT,
    enabled: config.LAUNCH_TRADES_INGEST && !!launchConfig.LAUNCHES_PATH,
    realtime:
      config.LAUNCH_TRADES_INGEST && launchConfig.LAUNCHES_PATH ? launchRealtimeSource(config, launchConfig) : null,
    backstopMs: config.LAUNCH_TRADES_BACKSTOP_SECONDS * 1_000,
    onTrades: (mint, rows) => wiring.page?.onTrades(mint, rows),
    onFeeEvents: (mint, rows) => wiring.page?.onFeeEvents(mint, rows),
  });
  const page = new LaunchPageService({
    launches: launchServices.launches,
    reader: new RpcLaunchChainReader(connections),
    live,
    store: trades,
    prices: launchServices.prices,
    solUsd: () => optional(getServices().market.solUsd, null),
    // The program's RevenueToken and escrow, read on the program's own cluster (EPOCH_RPC_URL).
    revenueTokens: new ProgramRevenueTokenSource(
      programSource.programId ?? null,
      programSource.programId ? new RpcRevenueTokenChain(programSource) : null,
    ),
    // The treasury's claims from the ingested program events: the same sums as GET /v1/launches/:mint/buybacks.
    treasury: programSource.programId
      ? new EventTreasuryClaimsSource(getServices().events, programSource.programId)
      : null,
    ingester,
    network: launchConfig.LAUNCH_CLUSTER,
    explorer: {
      cluster: launchConfig.LAUNCH_CLUSTER,
      customRpc: isLocal(launchConfig.LAUNCH_RPC_URL) ? launchConfig.LAUNCH_RPC_URL : null,
    },
    marketCacheMs: config.LAUNCH_MARKET_CACHE_SECONDS * 1_000,
    staleMs: config.LAUNCH_STALE_SECONDS * 1_000,
    maxBuySol: config.LAUNCH_TRADE_MAX_SOL,
    tradePriorityMicroLamports: config.LAUNCH_TRADE_PRIORITY_MICROLAMPORTS,
    ...launchIndexedSource(config, launchConfig.LAUNCH_CLUSTER),
  });
  wiring.page = page;
  pageServices = {
    config,
    page,
    trades,
    ingester,
    tradeLimiter: new RateLimiter(config.LAUNCH_TRADE_REQUESTS_PER_MINUTE, 60_000),
  };
  return pageServices;
}

/** Replaces the services (tests); `undefined` makes the next `getLaunchPageServices()` build them from config. */
export function setLaunchPageServices(services: LaunchPageServices | undefined): void {
  pageServices = services;
}

/**
 * Starts the Launch page's live parts: WS `launch:<mint>` (a snapshot on subscribe, then each new trade, the market
 * after it, and fee events) and the trade ingester (LAUNCH_TRADES_INGEST, needs LAUNCHES_PATH).
 */
export function startLaunchLive(stream: StreamHub): void {
  const { page, ingester } = getLaunchPageServices();
  stream.registerTopic('launch', {
    validate: (key) => page.isLaunch(key),
    canonical: (key) => page.mintOf(key),
    snapshot: (key) => page.snapshot(key),
  });
  page.setPublisher((mint, message) => stream.publish(`launch:${mint}`, message));
  ingester.start();
}
