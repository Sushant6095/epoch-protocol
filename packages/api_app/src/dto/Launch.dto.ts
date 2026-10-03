import { z } from '@epoch/common/pkg/zod';

/** `/v1/launches/:mint`: a token mint (base58), or a launch symbol such as `rKEST`. */
export const LaunchParamsDto = z.object({
  mint: z
    .string()
    .min(1)
    .max(44)
    .regex(/^[A-Za-z0-9]+$/, { message: 'a base58 mint or a launch symbol' }),
});
export type LaunchParams = z.infer<typeof LaunchParamsDto>;
