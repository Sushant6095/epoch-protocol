import { z } from '@epoch/common/pkg/zod';

export const DatabaseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
});
