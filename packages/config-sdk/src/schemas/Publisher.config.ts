import { z } from '@epoch/common/pkg/zod';

import { computeUnitPrice } from './Cranks.config';
import { EpochProgramConfigSchema } from './EpochProgram.config';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const address = z.string().min(32).max(44);

/**
 * Which program-cluster epoch the Fee Index of a finished mainnet epoch is posted under: `P = M + offset`, or `auto`
 * (the program cluster's current epoch − 1 at posting time). See packages/publisher_app/README.md.
 */
export const feeIndexEpochOffset = z
  .string()
  .trim()
  .default('0')
  .refine((value) => value === 'auto' || /^-?\d+$/.test(value), 'a whole number or "auto"')
  .transform((value): number | 'auto' => (value === 'auto' ? 'auto' : Number(value)));

/** publisher_app: the Fee Index publisher (post_index) and Epoch's seeded market maker (post_quote, withdraw_quote). */
export const PublisherConfigSchema = z.object({
  ...EpochProgramConfigSchema.pick({
    EPOCH_CLUSTER: true,
    EPOCH_RPC_URL: true,
    EPOCH_RPC_FALLBACK_URL: true,
    EPOCH_MARKET_MAKER: true,
  }).shape,
  EPOCH_PROGRAM_ID: address,
  /** The FeeIndex's `publisher` key; also needs DATABASE_URL. Unset: the index publisher is off. */
  PUBLISHER_KEYPAIR_PATH: z.string().min(1).optional(),
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
