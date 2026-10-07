import { z } from '@epoch/common/pkg/zod';

import { EpochProgramConfigSchema } from './EpochProgram.config';
import { KeeperConfigSchema } from './Keeper.config';
import { MarketDataConfigSchema } from './MarketData.config';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const address = z.string().min(32).max(44);

/** Priority fee for crank, publisher and operator transactions, micro-lamports per compute unit. */
export const computeUnitPrice = z.coerce.number().int().min(0).max(10_000_000).default(10_000);

/**
 * cranks_app: the epoch-boundary jobs (score, sweep, mark default, accrue, withdrawals) and the minute poller
 * (finalize the Fee Index, settle swaps). The program's cluster comes from the EPOCH_* variables (devnet for now);
 * the scorer's validator data comes from DATA_RPC_URL (mainnet) and Jito Kobe.
 */
export const CranksConfigSchema = z.object({
  ...EpochProgramConfigSchema.pick({
    EPOCH_CLUSTER: true,
    EPOCH_RPC_URL: true,
    EPOCH_RPC_FALLBACK_URL: true,
    EPOCH_MARKET_MAKER: true,
  }).shape,
  /** Required here: the cranks have nothing to do without a deployed program. */
  EPOCH_PROGRAM_ID: address,
  ...KeeperConfigSchema.pick({ CRANK_KEYPAIR_PATH: true }).shape,
  /** Must be the Pool's `scorer`. Unset: UpdateScoreJob is skipped. */
  SCORER_KEYPAIR_PATH: z.string().min(1).optional(),
  CRANK_CU_PRICE_MICROLAMPORTS: computeUnitPrice,
  ...MarketDataConfigSchema.pick({ DATA_RPC_URL: true, DATA_RPC_FALLBACK_URL: true, JITO_KOBE_API_URL: true }).shape,
  /** Simulate every transaction and log the result; send nothing. */
  DRY_RUN: flag('false'),
  /** How often the runner wakes up: retries unfinished boundary jobs, then finalizes and settles. */
  CRANK_POLL_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),
  /** A blocking boundary job (sweep, mark default, accrue) still unfinished this long after the boundary logs an error. */
  CRANK_ALERT_AFTER_MINUTES: z.coerce.number().int().min(1).max(1_440).default(60),
  /** Jito's tip-distribution program on the Epoch program's cluster (ClaimMevJob reads its accounts). */
  JITO_TIP_DISTRIBUTION_PROGRAM_ID: z.string().min(32).max(44).default('4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7'),
  /** The sweep waits at most this long after the boundary for Jito to claim each validator's MEV commission. */
  MEV_CLAIM_WAIT_MINUTES: z.coerce.number().int().min(0).max(1_440).default(360),
});

export type CranksConfig = z.infer<typeof CranksConfigSchema>;
