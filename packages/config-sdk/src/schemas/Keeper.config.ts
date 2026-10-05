import { z } from '@epoch/common/pkg/zod';

export const KeeperConfigSchema = z.object({
  CRANK_KEYPAIR_PATH: z.string().min(1),
  PUBLISHER_KEYPAIR_PATH: z.string().optional(),
});

// The Panta settings moved to Panta.config.ts (PantaApiConfigSchema, PantaTradingConfigSchema, PantaBotConfigSchema).
