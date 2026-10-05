import { type LaunchPageConfig, LaunchPageConfigSchema, loadConfig } from '@epoch/config-sdk';
import { PostgresConnectionManager } from '@epoch/pg_models';
import { ConnectionManager } from '@epoch/solana';

import { getLaunchServices } from '.';
import { getServices } from '..';
import { dbAvailable } from '../../Lib/Db';
import { RateLimiter } from '../../Lib/RateLimiter';
import { optional } from '../MarketData';
import { type StreamHub } from '../Stream/StreamHub';
import { RpcLaunchChainReader } from './LaunchChain';
import { RpcLaunchLiveChain } from './LaunchLiveChain';
import { LaunchPageService } from './LaunchPageService';
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
  const live = new RpcLaunchLiveChain(connections, launchConfig.LAUNCH_RPC_URL);
  // The ingester and the page service call each other (graduations, new trades): wire through closures.
  const wiring: { page?: LaunchPageService } = {};
  const ingester = new LaunchTradeIngester({
    chain: live,
    store: trades,
    launches: () => (wiring.page ? wiring.page.ingestLaunches() : Promise.resolve([])),
    pollMs: config.LAUNCH_TRADES_POLL_SECONDS * 1_000,
    backfillLimit: config.LAUNCH_TRADES_BACKFILL_LIMIT,
    enabled: config.LAUNCH_TRADES_INGEST && !!launchConfig.LAUNCHES_PATH,
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
