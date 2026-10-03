import { z } from '@epoch/common/pkg/zod';

export const ActivityQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ActivityQuery = z.infer<typeof ActivityQueryDto>;
