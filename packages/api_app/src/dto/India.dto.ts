import { z } from '@epoch/common/pkg/zod';

import {
  financialYear,
  financialYearAt,
  FIRST_FY_START_YEAR,
  type FinancialYear,
  parseFinancialYear,
} from '../Lib/IndianFy';
import { ValidatorListQueryDto } from './MarketQuery.dto';

/** GET /v1/india/validators: the /v1/validators query (tab, chips, q, sort, dir, fee, client, votes, cursor, limit). */
export const IndiaValidatorQueryDto = ValidatorListQueryDto.omit({ country: true });
export type IndiaValidatorQuery = z.infer<typeof IndiaValidatorQueryDto>;

/** GET /v1/india/price?days=30: CoinGecko's daily price for a sparkline (0 = none). */
export const IndiaPriceQueryDto = z.object({
  days: z.coerce.number().int().min(0).max(365).default(0),
});
export type IndiaPriceQuery = z.infer<typeof IndiaPriceQueryDto>;

/** `?fy=2026-27` (or `2026-2027`, `FY2026-27`): from 2020-21 to the current year, which is the default. */
export const IndiaRewardsQueryDto = z.object({
  fy: z
    .string()
    .max(16)
    .optional()
    .transform((value, ctx): FinancialYear => {
      const now = Date.now();
      const current = financialYearAt(now);
      if (value === undefined || value === '') return current;
      const fy = parseFinancialYear(value);
      if (!fy || fy.startYear < FIRST_FY_START_YEAR || fy.startYear > current.startYear) {
        ctx.addIssue({
          code: 'custom',
          message: `a financial year from ${financialYear(FIRST_FY_START_YEAR).label} to ${current.label}, e.g. ${current.label}`,
        });
        return z.NEVER;
      }
      return fy;
    }),
});
export type IndiaRewardsQuery = z.infer<typeof IndiaRewardsQueryDto>;
