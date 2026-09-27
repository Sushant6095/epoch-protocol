import { z } from '@epoch/common/pkg/zod';

export const ApiConfigSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_CORS_ORIGINS: z.string().default('*'),
});
