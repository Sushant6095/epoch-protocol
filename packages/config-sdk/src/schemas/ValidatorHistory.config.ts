import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/**
 * The validator history recorder in api_app (request #5b): commission, MEV commission, active stake and vote
 * credits per validator per epoch in Postgres (`validator_epoch_stats`). It only runs with DATABASE_URL.
 */
export const ValidatorHistoryConfigSchema = z.object({
  /** Turn off on extra API replicas so one process records. */
  VALIDATOR_HISTORY_ENABLED: flag('true'),
  /** Fill the last epochs once from Stakewiz (commission change logs, stake per epoch): two calls per validator. */
  VALIDATOR_HISTORY_BACKFILL: flag('true'),
});

export type ValidatorHistoryConfig = z.infer<typeof ValidatorHistoryConfigSchema>;
