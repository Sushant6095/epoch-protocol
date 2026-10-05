import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/**
 * Revenue-token buybacks in cranks_app (BuybackJob, ADR 0006): one `execute_buyback` per due slice, on the program's
 * cluster. The program enforces its own floor on `min_amount_out` (the pool's fee-free output less the token's
 * `max_slippage_bps`) and caps every slice's price impact; these settings are the crank's side.
 */
export const BuybackConfigSchema = z.object({
  /** Run BuybackJob (slices, `sync_revenue_token_pool` after graduation, `close_revenue_token` after the term). */
  BUYBACK_ENABLED: flag('true'),
  /** The crank's `min_amount_out`: a fresh Meteora quote for the slice less this many bps. */
  BUYBACK_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(2_000).default(100),
  /** Sends per slice and epoch before the job leaves that slice (transient failures, the price moving under a quote). */
  BUYBACK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  /** Compute-unit limit for `execute_buyback` (it used ~94k on DBC and ~79k on DAMM v2 against the real programs). */
  BUYBACK_COMPUTE_UNITS: z.coerce.number().int().min(150_000).max(1_400_000).default(300_000),
});

export type BuybackConfig = z.infer<typeof BuybackConfigSchema>;
