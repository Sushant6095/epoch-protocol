import { z } from '@epoch/common/pkg/zod';

export const KeeperConfigSchema = z.object({
  CRANK_KEYPAIR_PATH: z.string().min(1),
  PUBLISHER_KEYPAIR_PATH: z.string().optional(),
});

export const PantaConfigSchema = z.object({
  PANTA_API_URL: z.string().url(),
  PANTA_API_KEY: z.string().min(1),
});
