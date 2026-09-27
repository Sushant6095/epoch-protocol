import { z } from '@epoch/common/pkg/zod';

export const FeeIndexQueryDto = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export type FeeIndexQuery = z.infer<typeof FeeIndexQueryDto>;
