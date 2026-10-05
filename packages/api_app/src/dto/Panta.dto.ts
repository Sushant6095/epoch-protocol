import { z } from '@epoch/common/pkg/zod';

import { isPublicKey } from '../Lib/Keys';

const publicKey = (what: string) =>
  z.string().refine(isPublicKey, { message: `${what} must be a 32-byte base58 public key` });
/** Decimal USDC, at most 6 decimals ("20", "20.50"). Min and max are checked against PANTA_*_TRADE_USDC. */
const usdcAmount = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, 'a USDC amount such as 20 or 20.50');
/** Panta session ids (`qt_…`). */
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'not a Panta quote id');
export const TRADE_ID = /^ptr_[A-Za-z0-9_-]{8,64}$/;
const tradeId = z.string().regex(TRADE_ID, 'not an Epoch trade id (ptr_…)');

// ── /v1/predict/panta ───────────────────────────────────────────────────────────────────────────────

export const PantaMarketsQueryDto = z.object({
  /** One of GET /v1/predict/panta/categories. */
  category: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{1,32}$/, 'a category slug')
    .optional(),
  status: z.enum(['primary', 'secondary', 'resolved', 'cancelled']).optional(),
  /** Searches titles and descriptions (case-insensitive) in the first catalog pages. */
  q: z.string().trim().min(2).max(64).optional(),
  /** `discover.nextCursor` of the previous page (not with `q`). */
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_=-]{1,256}$/, 'a cursor from discover.nextCursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PantaMarketsQuery = z.infer<typeof PantaMarketsQueryDto>;

export const PantaMarketParamsDto = z.object({ marketId: publicKey('marketId') });
export type PantaMarketParams = z.infer<typeof PantaMarketParamsDto>;

export const PantaPositionsQueryDto = z.object({ wallet: publicKey('wallet') });
export type PantaPositionsQuery = z.infer<typeof PantaPositionsQueryDto>;

/** GET /v1/predict/panta/forecast?epoch= (a Solana mainnet epoch; default: the soonest one still trading). */
export const PantaForecastQueryDto = z.object({ epoch: z.coerce.number().int().min(0).max(100_000_000).optional() });
export type PantaForecastQuery = z.infer<typeof PantaForecastQueryDto>;

export const PantaQuoteDto = z.object({
  wallet: publicKey('wallet'),
  marketId: publicKey('marketId'),
  side: z.enum(['yes', 'no']),
  amountUsdc: usdcAmount,
});
export type PantaQuoteBody = z.infer<typeof PantaQuoteDto>;

export const PantaBuildDto = z.object({
  quoteId: sessionId,
  wallet: publicKey('wallet'),
  /** Must be true: the user confirmed the summary (400 CONSENT_REQUIRED otherwise). */
  consent: z.boolean().optional(),
  /** Default 100 (1%), at most 5,000. */
  maxSlippageBps: z.number().int().min(0).max(5_000).optional(),
});
export type PantaBuildBody = z.infer<typeof PantaBuildDto>;

export const PantaClaimDto = z.object({
  wallet: publicKey('wallet'),
  marketId: publicKey('marketId'),
  consent: z.boolean().optional(),
});
export type PantaClaimBody = z.infer<typeof PantaClaimDto>;

export const PantaSubmitDto = z
  .object({
    tradeId,
    /** The wallet-signed transaction (base64): Epoch broadcasts it on its RPC. */
    signedTransaction: z.string().min(100).max(4_000).optional(),
    /** Or the signature of a transaction the wallet broadcast itself (signAndSendTransaction). */
    signature: z.string().min(64).max(100).optional(),
  })
  .refine((body) => (body.signedTransaction === undefined) !== (body.signature === undefined), {
    message: 'send either signedTransaction (base64) or signature',
  });
export type PantaSubmitBody = z.infer<typeof PantaSubmitDto>;

export const PantaTradeParamsDto = z.object({ tradeId });
export type PantaTradeParams = z.infer<typeof PantaTradeParamsDto>;

// ── /v1/index/epochs ────────────────────────────────────────────────────────────────────────────────

export const FeeIndexEpochParamsDto = z.object({ epoch: z.coerce.number().int().min(0).max(100_000_000) });
export type FeeIndexEpochParams = z.infer<typeof FeeIndexEpochParamsDto>;
