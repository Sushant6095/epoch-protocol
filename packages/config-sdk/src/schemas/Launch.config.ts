import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/**
 * Revenue-token launches on Meteora (request #22): `GET /v1/launches` reads the launch registry and each launch's DBC and
 * DAMM v2 pools on the launch cluster (devnet for now, decision 6), and samples their prices every minute.
 */
export const LaunchConfigSchema = z
  .object({
    /** The launch registry (JSON array, written by the launch script). Unset: the list is empty, with a note. */
    LAUNCHES_PATH: z.string().min(1).optional(),
    /** Only registry entries on this cluster are served; it is the `network` of every response. */
    LAUNCH_CLUSTER: z.enum(['devnet', 'mainnet']).default('devnet'),
    /** RPC for the pools and token accounts. Defaults to EPOCH_RPC_URL (the program's cluster). */
    LAUNCH_RPC_URL: z.string().url().optional(),
    LAUNCH_RPC_FALLBACK_URL: z.string().url().optional(),
    EPOCH_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
    /** How long a read of every launch is served before the next one. */
    LAUNCH_CACHE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),
    /** Holders come from one getProgramAccounts per token: cached longer. */
    LAUNCH_HOLDERS_CACHE_MINUTES: z.coerce.number().int().min(1).max(1_440).default(10),
    /** Price samples into launch_price_samples (needs DATABASE_URL and LAUNCHES_PATH). */
    LAUNCH_SAMPLER_ENABLED: flag('true'),
    LAUNCH_SAMPLE_SECONDS: z.coerce.number().int().min(15).max(3_600).default(60),
  })
  .transform(({ EPOCH_RPC_URL, LAUNCH_RPC_URL, ...rest }) => ({
    ...rest,
    LAUNCH_RPC_URL: LAUNCH_RPC_URL ?? EPOCH_RPC_URL,
  }));

export type LaunchConfig = z.infer<typeof LaunchConfigSchema>;
