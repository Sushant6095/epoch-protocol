import { z } from '@epoch/common/pkg/zod';

const list = <T extends string>(allowed?: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .refine((values) => !allowed || values.every((v) => (allowed as readonly string[]).includes(v)), {
      message: `allowed: ${allowed?.join(', ')}`,
    })
    .transform((values) => values as T[]);

export const StakeHistoryQueryDto = z.object({
  epochs: z.coerce.number().int().min(1).max(512).default(64),
});
export type StakeHistoryQuery = z.infer<typeof StakeHistoryQueryDto>;

export const ValidatorListQueryDto = z.object({
  tab: z.enum(['all', 'healthy', 'watch', 'watchlist']).default('all'),
  chips: list(['below', 'dep', 'hide-top18', 'firedancer', 'zero-fee'] as const),
  q: z.string().max(100).optional(),
  sort: z.enum(['stake', 'apy', 'score', 'kept', 'dels', 'fee', 'blocks', 'up']).default('stake'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  /** Commission range in %, e.g. `0-10`. */
  fee: z
    .string()
    .regex(/^\d+(\.\d+)?-\d+(\.\d+)?$/)
    .optional()
    .transform((value) => (value ? (value.split('-').map(Number) as [number, number]) : undefined)),
  client: list(['agave', 'firedancer', 'unknown'] as const),
  /** ISO country codes, e.g. `DE,US`. */
  country: list().transform((values) => values.map((v) => v.toUpperCase())),
  /** Vote keys, at most 200 (the watchlist). */
  votes: list().refine((values) => values.length <= 200, { message: 'at most 200 vote keys' }),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(50),
});
export type ValidatorListQuery = z.infer<typeof ValidatorListQueryDto>;

export const DelegatorQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type DelegatorQuery = z.infer<typeof DelegatorQueryDto>;
