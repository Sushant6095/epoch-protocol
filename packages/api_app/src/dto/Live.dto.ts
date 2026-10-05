import { z } from '@epoch/common/pkg/zod';

export const LiveSlotsQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(60),
});

export const LiveLeadersQueryDto = z.object({
  /** Mainnet epoch; default the epoch in progress. */
  epoch: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(200),
});

export const LiveEpochParamsDto = z.object({
  epoch: z.coerce.number().int().nonnegative(),
});

export type LiveSlotsQuery = z.infer<typeof LiveSlotsQueryDto>;
export type LiveLeadersQuery = z.infer<typeof LiveLeadersQueryDto>;
export type LiveEpochParams = z.infer<typeof LiveEpochParamsDto>;
