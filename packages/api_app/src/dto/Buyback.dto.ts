import { z } from '@epoch/common/pkg/zod';

/** `/v1/launches/:mint/buybacks`: the token mint, base58. */
export const BuybackParamsDto = z.object({
  mint: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, { message: 'a base58 mint' }),
});
export type BuybackParams = z.infer<typeof BuybackParamsDto>;
