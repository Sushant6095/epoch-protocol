import { z } from '@epoch/common/pkg/zod';

/** `GET /v1/launches/:mint/trades?limit=&before=` */
export const LaunchTradesQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** `nextCursor` from the previous page. */
  before: z.string().min(1).max(120).optional(),
});
export type LaunchTradesQuery = z.infer<typeof LaunchTradesQueryDto>;

/** `GET /v1/launches/:mint/candles?interval=&from=&to=` (unix seconds) */
export const LaunchCandlesQueryDto = z.object({
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});
export type LaunchCandlesQuery = z.infer<typeof LaunchCandlesQueryDto>;

/** `GET /v1/launches/:mint/indexed`: the candle and volume bucket (the DAMM v2 data API's timeframes). */
export const LaunchIndexedQueryDto = z.object({
  timeframe: z.enum(['5m', '30m', '1h', '2h', '4h', '12h', '24h']).optional(),
});
export type LaunchIndexedQuery = z.infer<typeof LaunchIndexedQueryDto>;

const amount = z.number().positive().finite().max(1e15);

/** `POST /v1/launches/:mint/quote` */
export const LaunchQuoteBodyDto = z.object({
  side: z.enum(['buy', 'sell']),
  /** SOL to spend for a buy, tokens to sell for a sell. */
  amount,
  /** Default 100 (1%); 1–5,000 (never 0 or unlimited). */
  slippageBps: z.number().int().min(1).max(5_000).optional(),
});
export type LaunchQuoteBody = z.infer<typeof LaunchQuoteBodyDto>;

/** `POST /v1/launches/:mint/build`: the quote's fields plus the signing wallet and the trader's consent. */
export const LaunchBuildBodyDto = LaunchQuoteBodyDto.extend({
  owner: z.string().min(32).max(44),
  /** The reviewed quote's `minimumOut`, so the transaction enforces what the review showed. */
  minimumOut: z.number().nonnegative().finite().optional(),
  /** Must be `true`: the trader saw the review and the risk line (checked in the service, with its own error). */
  consent: z.boolean().optional(),
});
export type LaunchBuildBody = z.infer<typeof LaunchBuildBodyDto>;
