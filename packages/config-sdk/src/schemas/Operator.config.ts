import { z } from '@epoch/common/pkg/zod';

import { computeUnitPrice } from './Cranks.config';
import { EpochProgramConfigSchema } from './EpochProgram.config';

/** The operator CLI (packages/operator_cli): commission, identity, bond and release for an onboarded validator. */
export const OperatorConfigSchema = z.object({
  ...EpochProgramConfigSchema.pick({ EPOCH_CLUSTER: true, EPOCH_RPC_URL: true, EPOCH_RPC_FALLBACK_URL: true }).shape,
  EPOCH_PROGRAM_ID: z.string().min(32).max(44),
  /** The position's operator keypair file (signs and pays). Kept outside the repo. */
  OPERATOR_KEYPAIR_PATH: z.string().min(1),
  OPERATOR_CU_PRICE_MICROLAMPORTS: computeUnitPrice,
});

export type OperatorConfig = z.infer<typeof OperatorConfigSchema>;
