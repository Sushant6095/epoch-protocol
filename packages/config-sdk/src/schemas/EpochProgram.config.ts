import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/**
 * Which program-cluster epoch the Fee Index of a finished mainnet epoch is posted under: `P = M + offset`, or `auto`
 * (the program cluster's current epoch − 1 at posting time). See packages/publisher_app/README.md. The publisher posts
 * by it; the API numbers the Fee Index points by it.
 */
export const feeIndexEpochOffset = z
  .string()
  .trim()
  .default('0')
  .refine((value) => value === 'auto' || /^-?\d+$/.test(value), 'a whole number or "auto"')
  .transform((value): number | 'auto' => (value === 'auto' ? 'auto' : Number(value)));

/**
 * The Epoch program's cluster (devnet for now, decision 6). Separate from the mainnet data RPC
 * (`DATA_RPC_URL`): the Vault, Manage tab, Fee Market and Launch read the program here.
 */
export const EpochProgramConfigSchema = z.object({
  EPOCH_CLUSTER: z.enum(['localnet', 'devnet', 'testnet', 'mainnet']).default('devnet'),
  EPOCH_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  EPOCH_RPC_FALLBACK_URL: z.string().url().optional(),
  /** Websocket for logsSubscribe; derived from EPOCH_RPC_URL (https → wss) when unset. */
  EPOCH_RPC_WS_URL: z.string().url().optional(),
  /** Deployed program id. Unset → program endpoints answer 503 PROGRAM_NOT_CONFIGURED. */
  EPOCH_PROGRAM_ID: z.string().min(32).max(44).optional(),
  /** Epoch's market-maker key: /v1/market lists only this maker's quotes (post_quote is open to any key). */
  EPOCH_MARKET_MAKER: z.string().min(32).max(44).optional(),
  /** Read program events (logsSubscribe + signature backfill) into program_events. */
  PROGRAM_EVENTS_INGEST: flag('true'),
  /** Most transactions to backfill on start when there is no cursor yet. */
  PROGRAM_EVENTS_BACKFILL_LIMIT: z.coerce.number().int().min(0).max(100_000).default(2_000),
  /** Mainnet epoch M ↔ program epoch P for the Fee Index (publisher_app's EpochMapping): 0 on mainnet, `auto` on devnet. */
  FEE_INDEX_EPOCH_OFFSET: feeIndexEpochOffset,
});

export type EpochProgramConfig = z.infer<typeof EpochProgramConfigSchema>;
