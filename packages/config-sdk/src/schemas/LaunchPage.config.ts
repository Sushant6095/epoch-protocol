import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/**
 * The Launch page's live parts in api_app (plan F13): the trade feed decoded from the launch pools' swap events
 * (`launch_trades`, backfilled then polled), candles, the market and fee reads, top holders, the buy/sell ticket and the
 * WS `launch:<mint>` channel. The pools, cluster and registry come from `LaunchConfigSchema`.
 */
export const LaunchPageConfigSchema = z.object({
  /** Read the pools' transactions into launch_trades (Postgres, else memory). Turn off on extra API replicas. */
  LAUNCH_TRADES_INGEST: flag('true'),
  /** How often each pool's new signatures are read (getSignaturesForAddress, then getTransaction per new one). */
  LAUNCH_TRADES_POLL_SECONDS: z.coerce.number().int().min(2).max(600).default(10),
  /** Transactions read back on a first start (per pool, no cursor yet); 0 = from the newest one on. */
  LAUNCH_TRADES_BACKFILL_LIMIT: z.coerce.number().int().min(0).max(100_000).default(1_000),
  /** The live market read (pool, price, reserves) is reused for this long, unless a new trade made it stale. */
  LAUNCH_MARKET_CACHE_SECONDS: z.coerce.number().int().min(1).max(600).default(10),
  /** Data older than this is flagged `stale` in responses. */
  LAUNCH_STALE_SECONDS: z.coerce.number().int().min(10).max(86_400).default(120),
  /** POST /v1/launches/:mint/build refuses buys above this many SOL (a guardrail while the demo runs on mainnet). */
  LAUNCH_TRADE_MAX_SOL: z.coerce.number().positive().max(1_000).default(10),
  /** Quote and build requests per IP per minute. */
  LAUNCH_TRADE_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(30),
});

export type LaunchPageConfig = z.infer<typeof LaunchPageConfigSchema>;
