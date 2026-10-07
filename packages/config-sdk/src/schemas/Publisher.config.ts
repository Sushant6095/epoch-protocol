import { z } from '@epoch/common/pkg/zod';

import { computeUnitPrice } from './Cranks.config';
import { EpochProgramConfigSchema, feeIndexEpochOffset } from './EpochProgram.config';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const address = z.string().min(32).max(44);

/**
 * Comma-separated keypair paths of the Fee Index operators this process votes for (cast_index_vote), at most 8 (the
 * registry's size), no duplicates. Empty when unset.
 */
export const indexOperatorKeypairPaths = z
  .string()
  .trim()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path.length > 0),
  )
  .refine((paths) => paths.length <= 8, 'at most 8 keypair paths (the operator registry holds 8)')
  .refine((paths) => new Set(paths).size === paths.length, 'a keypair path is listed twice');

/** publisher_app: the Fee Index publisher (post_index) and Epoch's seeded market maker (post_quote, withdraw_quote). */
export const PublisherConfigSchema = z.object({
  ...EpochProgramConfigSchema.pick({
    EPOCH_CLUSTER: true,
    EPOCH_RPC_URL: true,
    EPOCH_RPC_FALLBACK_URL: true,
    EPOCH_MARKET_MAKER: true,
  }).shape,
  EPOCH_PROGRAM_ID: address,
  /**
   * The FeeIndex's `publisher` key (legacy post_index); also needs DATABASE_URL. With INDEX_OPERATOR_KEYPAIR_PATHS
   * unset it is also the one operator key that votes once consensus is on. Unset with no operator keys: the index
   * publisher is off.
   */
  PUBLISHER_KEYPAIR_PATH: z.string().min(1).optional(),
  /**
   * Fee Index operator keys that vote (cast_index_vote) once the admin turns consensus on (initialize_index_operators):
   * several in one process for a demo, one per process in production. See packages/publisher_app/README.md.
   */
  INDEX_OPERATOR_KEYPAIR_PATHS: indexOperatorKeypairPaths,
  /** Epoch's market maker (funds every quote's collateral). Unset: the quote maker is off. */
  MAKER_KEYPAIR_PATH: z.string().min(1).optional(),
  PUBLISHER_CU_PRICE_MICROLAMPORTS: computeUnitPrice,
  PUBLISHER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),
  /** Simulate every transaction and log the result; send nothing and write nothing to the database. */
  DRY_RUN: flag('false'),
  FEE_INDEX_EPOCH_OFFSET: feeIndexEpochOffset,
  /** SOL, up to 9 decimals. Collateral per quote = max notional × max move. */
  QUOTE_MAX_NOTIONAL_SOL: z
    .string()
    .trim()
    .default('50')
    .refine((value) => /^\d+(\.\d{1,9})?$/.test(value) && Number(value) > 0, 'a positive SOL amount'),
  QUOTE_MAX_MOVE_BPS: z.coerce.number().int().min(1).max(10_000).default(2_000),
  QUOTE_EPOCHS_AHEAD: z.coerce.number().int().min(1).max(16).default(5),
  /** Fixed rate = last final index × (10,000 + spread) / 10,000. Negative quotes below the index. */
  QUOTE_SPREAD_BPS: z.coerce.number().int().min(-9_999).max(10_000).default(0),
});

export type PublisherConfig = z.infer<typeof PublisherConfigSchema>;
