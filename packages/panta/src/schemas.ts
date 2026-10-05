/**
 * The Panta public API shapes this package relies on, as zod schemas. Written from the documentation pages cited on
 * each block (index: https://docs.panta.market/llms.txt, read 3 Oct 2026). Responses are validated leniently: unknown
 * fields are dropped, fields we do not use are optional, and numbers the docs show both as strings and as numbers
 * (prices, amounts, shares) are accepted either way and normalised to strings.
 */
import { z } from '@epoch/common/pkg/zod';

/** A decimal or integer the API may send as a string or a number; always handed on as a string. */
const decimalLike = z.union([z.string(), z.number()]).transform((value) => String(value));
const nullableDecimal = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === null || value === undefined ? null : String(value)));
const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const countMap = z.record(z.string(), z.number()).default({});

// ── Errors · https://docs.panta.market/guides/errors.md ──────────────────────────────────────────────

/** `{ code, message, field? , fields? }`. */
export const PantaErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
  field: z.string().optional(),
  fields: z.record(z.string(), z.array(z.string())).optional(),
});
export type PantaErrorEnvelope = z.infer<typeof PantaErrorEnvelopeSchema>;

// ── Account · https://docs.panta.market/api-reference/account/get.md ─────────────────────────────────

export const PantaAccountSchema = z.object({
  userId: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  /** `active` or `suspended`. */
  status: z.string(),
  /** Operators may turn it off; create routes then answer CREATE_NOT_PERMITTED. */
  canCreateMarkets: z.boolean(),
  createdAt: z.string().optional(),
  apiKeyId: nullableString,
});
export type PantaAccount = z.infer<typeof PantaAccountSchema>;

/** A create-session row · https://docs.panta.market/api-reference/account/creates.md */
export const PantaCreateRowSchema = z.object({
  createId: z.string(),
  wallet: nullableString,
  eventPda: nullableString,
  signature: nullableString,
  /** `pending` | `built` | `registered` | … */
  status: z.string(),
  /** Human decimal ("50.00"). */
  paymentUsdc: nullableDecimal,
  /** Integer base units ("50000000"). */
  paymentUsdcBase: nullableDecimal,
  createdAt: nullableString,
  updatedAt: nullableString,
});
export type PantaCreateRow = z.infer<typeof PantaCreateRowSchema>;

/** An attribution row · https://docs.panta.market/api-reference/account/trades.md */
export const PantaAttributedTradeSchema = z.object({
  signature: z.string(),
  wallet: z.string(),
  marketId: z.string(),
  side: nullableString,
  /** `buy` | `claim`. */
  kind: z.string(),
  amountUsdc: nullableDecimal,
  amountUsdcBase: nullableDecimal,
  status: z.string(),
  createdAt: nullableString,
});
export type PantaAttributedTrade = z.infer<typeof PantaAttributedTradeSchema>;

const tradeSummary = z.object({
  total: z.number(),
  /** Sum of attributed sizes in USDC base units. */
  volumeUsdcBase: decimalLike.default('0'),
  byKind: countMap,
});
const createSummary = z.object({ total: z.number(), byStatus: countMap });

/** https://docs.panta.market/api-reference/account/metrics.md */
export const PantaMetricsSchema = z.object({
  summary: z.object({
    creates: createSummary,
    trades: tradeSummary,
    keys: z.object({ active: z.number(), revoked: z.number(), total: z.number() }).optional(),
  }),
  creates: z.array(PantaCreateRowSchema).default([]),
  trades: z.array(PantaAttributedTradeSchema).default([]),
});
export type PantaMetrics = z.infer<typeof PantaMetricsSchema>;

/** https://docs.panta.market/api-reference/account/creates.md */
export const PantaCreatesSchema = z.object({
  summary: createSummary,
  items: z.array(PantaCreateRowSchema),
});
export type PantaCreates = z.infer<typeof PantaCreatesSchema>;

/** https://docs.panta.market/api-reference/account/trades.md */
export const PantaAttributedTradesSchema = z.object({
  summary: tradeSummary,
  items: z.array(PantaAttributedTradeSchema),
});
export type PantaAttributedTrades = z.infer<typeof PantaAttributedTradesSchema>;

// ── Markets catalog · https://docs.panta.market/api-reference/markets/list.md, …/get.md ────────────────

export const PANTA_PHASES = ['primary', 'secondary', 'resolved', 'cancelled'] as const;
export type PantaPhase = (typeof PANTA_PHASES)[number];

/** Allowed categories (GET /categories/ is the live list). https://docs.panta.market/api-reference/markets/categories.md */
export const PANTA_CATEGORIES = [
  'sports',
  'crypto',
  'politics',
  'entertainment',
  'finance',
  'science',
  'world',
  'other',
] as const;
export type PantaCategory = (typeof PANTA_CATEGORIES)[number];

/**
 * A catalog row. List rows carry `null` prices (no live RPC); GET /markets/{marketId}/ fills `yesPrice` / `noPrice` and
 * the primary / secondary prices from chain when RPC is available.
 */
export const PantaMarketSchema = z.object({
  /** The event address; the id every other route takes. */
  marketId: z.string(),
  category: nullableString,
  title: z.string(),
  description: nullableString,
  images: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  /** `primary` | `secondary` | `resolved` | `cancelled` (kept as a string so a new phase does not break reads). */
  phase: z.string(),
  marketType: nullableString,
  /** Unix seconds. */
  startTime: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  endTime: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  resolutionTime: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  region: nullableString,
  resolved: z.boolean().default(false),
  status: nullableString,
  /** Human-readable volume ("1200.00"). */
  volumeUsdc: nullableDecimal,
  campaignId: nullableString,
  /** True when this API account created the market. */
  createdByPartner: z.boolean().default(false),
  yesPrice: nullableDecimal,
  noPrice: nullableDecimal,
  primaryYesPrice: nullableDecimal,
  primaryNoPrice: nullableDecimal,
  secondaryYesPrice: nullableDecimal,
  secondaryNoPrice: nullableDecimal,
});
export type PantaMarket = z.infer<typeof PantaMarketSchema>;

export const PantaMarketListSchema = z.object({
  items: z.array(PantaMarketSchema),
  nextCursor: nullableString,
});
export type PantaMarketList = z.infer<typeof PantaMarketListSchema>;

/** A catalog trade (the public tape) · https://docs.panta.market/api-reference/markets/trades.md */
export const PantaCatalogTradeSchema = z.object({
  id: decimalLike,
  marketId: z.string(),
  wallet: z.string(),
  isPrimary: z.boolean(),
  yesAmount: decimalLike,
  noAmount: decimalLike,
  feePaid: decimalLike,
  /** Unix seconds. */
  blockTime: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  signature: z.string(),
  quoteAsset: nullableString,
});
export type PantaCatalogTrade = z.infer<typeof PantaCatalogTradeSchema>;

export const PantaMarketTradesSchema = z.object({ marketId: z.string(), items: z.array(PantaCatalogTradeSchema) });
export type PantaMarketTrades = z.infer<typeof PantaMarketTradesSchema>;

/** https://docs.panta.market/api-reference/markets/wallet-trades.md */
export const PantaWalletTradesSchema = z.object({ wallet: z.string(), items: z.array(PantaCatalogTradeSchema) });
export type PantaWalletTrades = z.infer<typeof PantaWalletTradesSchema>;

export const PantaCategoriesSchema = z.object({ categories: z.array(z.string()) });
export type PantaCategories = z.infer<typeof PantaCategoriesSchema>;

// ── Create market · https://docs.panta.market/api-reference/markets/quote.md, …/build.md, …/register.md ─

const unixSeconds = z.number().int().nonnegative();
const httpUrl = z
  .string()
  .max(2_048)
  .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL');

/**
 * POST /markets/create/quote/ body. `question` with `wallet` derives the event address, so the same question from the
 * same wallet can never make a second market (DUPLICATE_MARKET). Times are unix seconds: `startTime < endTime ≤
 * resolutionTime`, and a standard market's `startTime` must be at least the on-chain `minimumStartDelay` (typically
 * 3,600 s) ahead of now.
 */
export const PantaCreateQuoteRequestSchema = z
  .object({
    wallet: z.string().min(32).max(44),
    question: z.string().min(1).max(512),
    resolutionRule: z.string().min(1).max(2_048),
    sourcesOfTruth: z.array(z.string().min(1)).min(1).max(20),
    category: z.enum(PANTA_CATEGORIES),
    startTime: unixSeconds,
    endTime: unixSeconds,
    resolutionTime: unixSeconds,
    /** Catalog only (not on-chain); a public http(s) URL, 1024×1024 recommended. */
    imageUrl: httpUrl,
    marketType: z.enum(['standard', 'breaking']).optional(),
    /** Breaking markets only. */
    eventInProgress: z.boolean().optional(),
    /** Defaults to `question`. */
    title: z.string().min(1).max(512).optional(),
    description: z.string().max(4_000).optional(),
    /** Defaults to `Global`. */
    region: z.string().min(1).max(64).optional(),
    /** Defaults to `sourcesOfTruth` joined by `,`. */
    oracle: z.string().max(2_048).optional(),
  })
  .refine((body) => body.startTime < body.endTime && body.endTime <= body.resolutionTime, {
    message: 'times must satisfy startTime < endTime <= resolutionTime',
  });
export type PantaCreateQuoteRequest = z.input<typeof PantaCreateQuoteRequestSchema>;

/** Fee amounts are USDC base units as integer strings (6 decimals). */
export const PantaCreateQuoteSchema = z.object({
  createId: z.string(),
  expectedEventPda: z.string(),
  /** Total creation fee. */
  paymentUsdc: decimalLike,
  /** The part of the fee that seeds the market's liquidity. */
  liquidityInjectionUsdc: decimalLike.default('0'),
  /** The part Panta keeps. */
  platformRevenueUsdc: decimalLike.default('0'),
  marketType: nullableString,
  /** The session (~5 minutes). */
  expiresAt: z.string(),
  blockhashExpiryHintSec: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
});
export type PantaCreateQuote = z.infer<typeof PantaCreateQuoteSchema>;

export const PantaCreateBuildSchema = z.object({
  createId: z.string(),
  expectedEventPda: nullableString,
  /** Base64 unsigned VersionedTransaction. Never modify it: register checks the chain against the quote. */
  transaction: z.string().min(1),
  recentBlockhash: z.string(),
  lastValidBlockHeight: z.number().int(),
  blockhashExpiryHintSec: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  buildFingerprint: nullableString,
  paymentUsdc: nullableDecimal,
  liquidityInjectionUsdc: nullableDecimal,
  platformRevenueUsdc: nullableDecimal,
  marketType: nullableString,
  /** Accounts the transaction references (`event`, `vaultAuthority`, `marketConfig`, …). */
  derived: z.record(z.string(), z.string()).default({}),
  expiresAt: nullableString,
});
export type PantaCreateBuild = z.infer<typeof PantaCreateBuildSchema>;

export const PantaRegisterSchema = z.object({
  createId: nullableString,
  /** The event address: the market id everywhere else. */
  marketId: z.string(),
  /** `registered` on success. */
  status: z.string(),
  signature: nullableString,
  category: nullableString,
  title: nullableString,
  images: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
});
export type PantaRegister = z.infer<typeof PantaRegisterSchema>;

// ── Primary buy · https://docs.panta.market/api-reference/orders/quote.md, …/build.md, …/submit.md, …/verify.md

export const PANTA_SIDES = ['yes', 'no'] as const;
export type PantaSide = (typeof PANTA_SIDES)[number];
const side = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(PANTA_SIDES));

/** One instruction of an unsigned build (primary buy, win claim, creator-fee claim). `data` is base64. */
export const PantaInstructionSchema = z.object({
  programId: z.string(),
  data: z.string(),
  accounts: z.array(z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() })),
});
export type PantaInstruction = z.infer<typeof PantaInstructionSchema>;

export const PantaBuyQuoteSchema = z.object({
  /** ~90 s session for build. */
  quoteId: z.string(),
  marketId: z.string(),
  side,
  /** Decimal USDC ("20.00"). */
  amountUsdc: decimalLike,
  shares: decimalLike,
  avgPrice: decimalLike,
  /** Protocol fee, decimal USDC. */
  feeUsdc: decimalLike,
  expiresAt: z.string(),
  blockhashExpiryHintSec: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
});
export type PantaBuyQuote = z.infer<typeof PantaBuyQuoteSchema>;

export const PantaBuyBuildSchema = z.object({
  /** ~120 s session for submit / verify. */
  orderId: z.string(),
  quoteId: nullableString,
  wallet: z.string(),
  marketId: z.string(),
  side,
  amountUsdc: decimalLike,
  expectedShares: decimalLike,
  feeUsdc: nullableDecimal,
  status: nullableString,
  /** Compile a versioned transaction from these and `recentBlockhash`, payer = wallet. */
  instructions: z.array(PantaInstructionSchema).min(1),
  derived: z.record(z.string(), z.string()).default({}),
  recentBlockhash: z.string(),
  lastValidBlockHeight: z.number().int(),
  expiresAt: nullableString,
  blockhashExpiryHintSec: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
});
export type PantaBuyBuild = z.infer<typeof PantaBuyBuildSchema>;

export const PantaSubmitSchema = z.object({
  orderId: z.string(),
  /** `submitted` when the signature is registered. */
  status: z.string(),
  signature: nullableString,
});
export type PantaSubmit = z.infer<typeof PantaSubmitSchema>;

export const PANTA_ORDER_STATUSES = ['built', 'submitted', 'confirmed', 'failed', 'expired'] as const;
export type PantaOrderStatus = (typeof PANTA_ORDER_STATUSES)[number];

/** Note: verify returns `amountUsdc` in base units (an integer), unlike quote and build. */
export const PantaVerifySchema = z.object({
  orderId: z.string(),
  status: z.string(),
  signature: nullableString,
  marketId: nullableString,
  side: side.nullish().transform((value) => value ?? null),
  amountUsdc: nullableDecimal,
});
export type PantaVerify = z.infer<typeof PantaVerifySchema>;

// ── Positions · https://docs.panta.market/api-reference/positions.md ─────────────────────────────────

/** A wallet with YES and NO shares in one market has two rows. */
export const PantaPositionSchema = z.object({
  marketId: z.string(),
  category: nullableString,
  side,
  shares: decimalLike,
  phase: z.string(),
  /** A win claim can be built for this side. */
  claimable: z.boolean(),
  claimed: z.boolean().default(false),
  /** `yes` / `no` after resolution. */
  outcome: z
    .string()
    .nullish()
    .transform((value) => (value ? value.toLowerCase() : null)),
});
export type PantaPosition = z.infer<typeof PantaPositionSchema>;

export const PantaPositionsSchema = z.object({ wallet: z.string(), positions: z.array(PantaPositionSchema) });
export type PantaPositions = z.infer<typeof PantaPositionsSchema>;

// ── Claims · https://docs.panta.market/api-reference/claims/build.md, …/creator-fees.md ───────────────

export const PantaWinClaimSchema = z.object({
  wallet: z.string(),
  marketId: z.string(),
  /** The winning outcome label (`YES` / `NO`), lower-cased here. */
  outcome: z.string().transform((value) => value.toLowerCase()),
  winningShares: decimalLike,
  instructions: z.array(PantaInstructionSchema).min(1),
  derived: z.record(z.string(), z.string()).default({}),
  recentBlockhash: z.string(),
  lastValidBlockHeight: z.number().int(),
});
export type PantaWinClaim = z.infer<typeof PantaWinClaimSchema>;

export const PantaCreatorFeeClaimSchema = z.object({
  wallet: z.string(),
  marketId: z.string(),
  /** USDC base units ("2500000" = 2.50 USDC). */
  claimableFeesUsdc: decimalLike,
  instructions: z.array(PantaInstructionSchema).min(1),
  derived: z.record(z.string(), z.string()).default({}),
  recentBlockhash: z.string(),
  lastValidBlockHeight: z.number().int(),
});
export type PantaCreatorFeeClaim = z.infer<typeof PantaCreatorFeeClaimSchema>;

// ── Trade attribution · https://docs.panta.market/api-reference/trades/report.md, …/status.md ─────────

export const PantaReportTradeRequestSchema = z.object({
  signature: z.string().min(64).max(100),
  wallet: z.string().min(32).max(44),
  marketId: z.string().min(32).max(44),
  quoteId: z.string().max(128).optional(),
  clientOrderId: z.string().max(128).optional(),
  userId: z.string().max(128).optional(),
});
export type PantaReportTradeRequest = z.infer<typeof PantaReportTradeRequestSchema>;

export const PantaReportTradeSchema = z.object({
  signature: z.string(),
  /** `processed` when attribution is stored. */
  status: z.string(),
  marketId: nullableString,
  wallet: nullableString,
  side: nullableString,
  /** `buy` (primary order) or `claim` (win claim). */
  kind: nullableString,
});
export type PantaReportTrade = z.infer<typeof PantaReportTradeSchema>;

export const PANTA_ATTRIBUTION_STATUSES = ['processed', 'pending_attribution', 'unknown', 'failed'] as const;
export type PantaAttributionStatus = (typeof PANTA_ATTRIBUTION_STATUSES)[number];

export const PantaTradeStatusSchema = z.object({
  signature: z.string(),
  status: z.string(),
  marketId: nullableString,
  wallet: nullableString,
});
export type PantaTradeStatus = z.infer<typeof PantaTradeStatusSchema>;
