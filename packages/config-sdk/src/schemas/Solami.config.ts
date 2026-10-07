import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined))
  .pipe(z.string().url().optional());

/** `grpc.solami.dev:443` and `https://grpc.solami.dev` both work; the native client wants the URL form. */
export const normalizeGrpcUrl = (value: string): string =>
  /^https?:\/\//.test(value.trim()) ? value.trim() : `https://${value.trim().replace(/:443$/, '')}`;

const grpcEndpoint = (fallback: string) => z.string().trim().default(fallback).transform(normalizeGrpcUrl);

/** Solami's Yellowstone gRPC: shared by indexer_app and api_app. */
const solamiGrpc = {
  /** Yellowstone gRPC. The key goes on the `x-token` metadata (SOLAMI_TOKEN), never in the URL. */
  SOLAMI_GRPC_URL: grpcEndpoint('https://grpc.solami.dev'),
  SOLAMI_TOKEN: z.string().trim().optional(),
  /** zstd or gzip asks the gRPC server to compress the stream (and compresses our requests). Both were accepted by
   * grpc.solami.dev on 5 Oct 2026; `pnpm solami:check --compression zstd` checks it with your key. */
  SOLAMI_GRPC_COMPRESSION: z.enum(['none', 'zstd', 'gzip']).default('none'),
};

/**
 * indexer_app: the Solana Fee Index computed live from mainnet blocks (Solami Track). Every key is read from the
 * environment and never logged; URLs are logged by host only.
 */
export const IndexerConfigSchema = z.object({
  SOLAMI_GRPC_URL: solamiGrpc.SOLAMI_GRPC_URL,
  SOLAMI_TOKEN: solamiGrpc.SOLAMI_TOKEN,
  /** Optional failover stream (RPC Fast), used only after Solami fails. */
  RPC_FAST_GRPC_URL: z.string().trim().optional(),
  RPC_FAST_TOKEN: z.string().trim().optional(),
  /** Solami RPC with the key in the query string: https://rpc.solami.dev/sol?api_key=<key>. Gap fill, leader schedule,
   * stake snapshots, `hybrid` and `rpc` modes. Unset: DATA_RPC_URL (public mainnet by default). */
  SOLAMI_RPC_URL: optionalUrl,
  DATA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  /**
   * Where block contents come from:
   * - `grpc`: every non-vote transaction over Yellowstone gRPC (a firehose request: needs gRPC pay-as-you-go on Solami);
   * - `hybrid`: block meta + slots over gRPC (allowed on plan streams), each block's transactions via RPC getBlock;
   * - `rpc`: getSlot polling + getBlock, no gRPC at all (fallback, local runs);
   * - `auto`: `grpc`, then `hybrid` if Solami refuses the firehose; `rpc` when there is no SOLAMI_TOKEN.
   */
  SLOT_SOURCE: z.enum(['auto', 'grpc', 'hybrid', 'rpc']).default('auto'),
  SOLAMI_GRPC_COMPRESSION: solamiGrpc.SOLAMI_GRPC_COMPRESSION,
  /** RPC requests per second and in flight for gap fill (and for block fetches in `hybrid` / `rpc` mode). */
  GAP_FILL_RPS: z.coerce.number().positive().max(500).default(8),
  GAP_FILL_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** A saved cursor further behind the tip than this is abandoned (logged) instead of gap-filled. */
  GAP_FILL_MAX_SLOTS: z.coerce.number().int().min(1_000).max(10_000_000).default(432_000),
  /** On a fresh start, begin at the current epoch's first slot (gap-filled over RPC) so that epoch is complete. */
  INDEXER_BACKFILL_EPOCH: flag('false'),
  /** `rpc` mode: how often to ask for the confirmed slot. */
  RPC_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(400),
  /** `rpc` mode only: process one slot in N (a gentle sample for public RPC demos). Above 1 the epoch index is not
   * written, the estimate is marked sampled, and gap fill is off. */
  RPC_SLOT_STRIDE: z.coerce.number().int().min(1).max(1_000).default(1),
  /** How often the running estimate is recomputed, stored and pushed. */
  LIVE_INDEX_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  /** Rows kept in live_slots (the Live page's recent slots). */
  LIVE_SLOTS_KEEP: z.coerce.number().int().min(100).max(1_000_000).default(20_000),
  /** Epochs of per-block fee composition kept in slot_fee_mix (≈ 45 MB each); epoch_fee_mix keeps every total. */
  FEE_MIX_KEEP_EPOCHS: z.coerce.number().int().min(1).max(64).default(3),
  /** Jito MEV scan (validator_mev_epochs) on DATA_RPC_URL: minutes between scans; 0 turns it off. */
  MEV_SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1_440).default(60),
  /** Epochs the MEV scan keeps current, newest first (TDAs are closed 10 epochs after their epoch). */
  MEV_BACKFILL_EPOCHS: z.coerce.number().int().min(1).max(10).default(10),
  /** Pause between the MEV scan's RPC calls (public RPC is rate-limited). */
  MEV_SCAN_SPACING_MS: z.coerce.number().int().min(0).max(10_000).default(400),
});

export type IndexerConfig = z.infer<typeof IndexerConfigSchema>;

/**
 * Beam over HTTP for every mainnet transaction we sign (publisher_app, cranks_app): a JSON-RPC `sendTransaction`
 * carrying a tip transfer goes out through Beam's stake-weighted lane.
 */
export const BeamConfigSchema = z.object({
  /** The HTTP endpoint for the tipped sendTransaction: your Solami RPC URL (https://rpc.solami.dev/sol?api_key=<key>).
   * Solami's llms.txt also names https://beam-http.solami.dev, which did not resolve on 5 Oct 2026. Unset: Beam is
   * off. */
  SOLAMI_BEAM_URL: optionalUrl,
  /** Tip per transaction, lamports. Solami's floor is 100,000 (0.0001 SOL). */
  SOLAMI_BEAM_TIP_LAMPORTS: z.coerce.number().int().min(100_000).max(100_000_000).default(100_000),
  /** Current tip addresses (no auth), cached 10 minutes; the list pinned from Solami's SDK covers an outage. */
  SOLAMI_TIP_ADDRESSES_URL: z.string().url().default('https://api.solami.dev/onchain/tip-addresses'),
});

export type BeamConfig = z.infer<typeof BeamConfigSchema>;

/** api_app `/v1/live` and the `slots` / `index:live` stream channels. */
export const LiveConfigSchema = z.object({
  /** Data older than this is served with `live: false`. */
  LIVE_STALE_AFTER_SECONDS: z.coerce.number().int().min(3).max(3_600).default(20),
  /** LISTEN for the indexer's NOTIFY feed (needs DATABASE_URL). */
  LIVE_FEED_ENABLED: flag('true'),
});

export type LiveConfig = z.infer<typeof LiveConfigSchema>;

/**
 * api_app's own Solami gRPC stream (one connection): slot updates for the WS `slot` channel and, when the program runs
 * on mainnet, the Epoch program's transactions for program_events. Polling and logsSubscribe stay as the fallbacks.
 */
export const SolamiApiConfigSchema = z.object({
  ...solamiGrpc,
  /** Off: the API polls slots and uses logsSubscribe even with SOLAMI_TOKEN set. */
  SOLAMI_API_STREAM: flag('true'),
  /** A component's usage row older than this is shown as stale in GET /v1/live/solami. */
  SOLAMI_USAGE_STALE_SECONDS: z.coerce.number().int().min(10).max(86_400).default(120),
});

export type SolamiApiConfig = z.infer<typeof SolamiApiConfigSchema>;
