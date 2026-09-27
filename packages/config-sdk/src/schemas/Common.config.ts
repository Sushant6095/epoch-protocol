import { z } from '@epoch/common/pkg/zod';

export const CommonConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  CLUSTER: z.enum(['localnet', 'devnet', 'testnet', 'mainnet']).default('devnet'),
});
