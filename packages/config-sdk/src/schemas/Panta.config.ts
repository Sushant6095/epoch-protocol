import { z } from '@epoch/common/pkg/zod';

import { computeUnitPrice } from './Cranks.config';
import { EpochProgramConfigSchema } from './EpochProgram.config';

// Panta: USDC prediction markets on Solana mainnet (https://docs.panta.market). Decision of 3 Oct 2026: Predict trades
// REAL money (USDC) through Panta; points mode stays as the free tier. The API key is server-side only (Panta Terms of
// Use §3): it is read here, handed to @epoch/panta, and never logged or sent to a browser.

/** `.env.example` leaves these as `NAME=`: an empty value means unset. */
const blank = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalUrl = z.preprocess(blank, z.string().url().optional());
const flag = (fallback: 'true' | 'false') =>
  z.preprocess(
    blank,
    z
      .enum(['true', 'false'])
      .default(fallback)
      .transform((value) => value === 'true'),
  );
/** A USDC amount as a decimal string (no float maths downstream). */
const usdcAmount = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .refine((value) => /^\d{1,12}(\.\d{1,6})?$/.test(value), 'a USDC amount such as 100 or 12.5');
const csv = (fallback: string, normalize: (part: string) => string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((part) => normalize(part.trim()))
        .filter(Boolean),
    );

export const PANTA_DEFAULT_API_URL = 'https://live-api.panta.market/api/v1';
export const SOLANA_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const FEE_INDEX_METHODOLOGY_URL =
  'https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md';
/** api_app serves the markets' catalog image here (1024×1024 PNG); the bot's default PANTA_MARKET_IMAGE_URL. */
export const PANTA_MARKET_IMAGE_PATH = '/v1/predict/panta/market-image.png';

/** The Panta API, shared by api_app (trading) and panta_bot_app (market creation). */
export const PantaApiConfigSchema = z.object({
  PANTA_API_URL: z.preprocess(blank, z.string().url().default(PANTA_DEFAULT_API_URL)),
  /** `pk_live_…` (or `pk_test_…`; both work on the public API). Unset: every Panta feature is off. */
  PANTA_API_KEY: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .regex(/^pk_(live|test)_\S+$/, 'must be a pk_live_… or pk_test_… key')
      .optional(),
  ),
  /** Per request attempt. */
  PANTA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /**
   * Share of Panta's per-ACCOUNT rate limits this process may use (read 120, positions 60, quote 30, build 20,
   * register 40 per minute). The API and the bot share one key: their shares should add up to at most 1.
   */
  PANTA_RATE_LIMIT_SHARE: z.coerce.number().gt(0).max(1).default(0.8),
  /** Solana MAINNET RPC for broadcasting and confirming Panta transactions. Default DATA_RPC_URL, else the public one. */
  PANTA_RPC_URL: optionalUrl,
  PANTA_RPC_FALLBACK_URL: optionalUrl,
  DATA_RPC_URL: optionalUrl,
  DATA_RPC_FALLBACK_URL: optionalUrl,
  /** The Fee Index methodology: in every market's sources of truth and in GET /v1/index/epochs/:epoch. */
  PANTA_METHODOLOGY_URL: z.preprocess(blank, z.string().url().default(FEE_INDEX_METHODOLOGY_URL)),
});

type PantaApiShape = z.infer<typeof PantaApiConfigSchema>;

/** Resolves the mainnet RPC: PANTA_RPC_URL, else DATA_RPC_URL (api_app's mainnet reads), else the public endpoint. */
function withPantaRpc<T extends PantaApiShape>({ DATA_RPC_URL, DATA_RPC_FALLBACK_URL, ...rest }: T) {
  return {
    ...rest,
    PANTA_RPC_URL: rest.PANTA_RPC_URL ?? DATA_RPC_URL ?? SOLANA_MAINNET_RPC_URL,
    PANTA_RPC_FALLBACK_URL: rest.PANTA_RPC_FALLBACK_URL ?? (rest.PANTA_RPC_URL ? undefined : DATA_RPC_FALLBACK_URL),
  };
}

/** api_app: real-money Predict through Panta (`/v1/predict/panta`). */
export const PantaTradingConfigSchema = PantaApiConfigSchema.extend({
  /**
   * Trading (quote, build, submit, claims). Unset: on exactly when PANTA_API_KEY is set (decision of 3 Oct 2026, which
   * replaced PREDICT_REAL_SOL's "must stay false"). `false` keeps the read-only pages and answers 503 to trades.
   */
  PANTA_TRADING_ENABLED: z.preprocess(blank, z.enum(['true', 'false']).optional()),
  /** ISO 3166-1 alpha-2 codes (e.g. `US,GB`) whose visitors may browse but not trade. Default: none. */
  PANTA_BLOCKED_COUNTRIES: csv('', (part) => part.toUpperCase()).refine(
    (codes) => codes.every((code) => /^[A-Z]{2}$/.test(code)),
    'two-letter country codes, comma-separated',
  ),
  /**
   * Request headers a TRUSTED proxy sets to the visitor's country, first one present wins. Only meaningful behind that
   * proxy (Cloudflare: `cf-ipcountry`, Vercel: `x-vercel-ip-country`); anywhere else a client could set them itself.
   */
  PANTA_GEO_HEADERS: csv('cf-ipcountry,x-vercel-ip-country', (part) => part.toLowerCase()),
  /**
   * What a trade does when no trusted header names the visitor's country (no proxy in front, or the proxy did not
   * know). `false` (default): allowed, as before. `true`: refused like a blocked country (403 PANTA_GEO_BLOCKED), so a
   * deployment without a geo-aware proxy cannot trade by mistake.
   */
  PANTA_GEO_FAIL_CLOSED: flag('false'),
  /** Largest primary buy one request may ask for, USDC. */
  PANTA_MAX_TRADE_USDC: usdcAmount('500'),
  /** Smallest, USDC (Panta has its own minimum: AMOUNT_TOO_SMALL). */
  PANTA_MIN_TRADE_USDC: usdcAmount('1'),
  /** Catalog reads are served from cache this long; older answers are flagged `stale`. */
  PANTA_CACHE_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  /** The WS `predict:panta` channel polls prices this often while someone listens (doubles on 429, up to 5 min). */
  PANTA_STREAM_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(600).default(15),
  /** The informational model: share of the last K finished epochs above a market's threshold. */
  PANTA_MODEL_LOOKBACK_EPOCHS: z.coerce.number().int().min(5).max(365).default(30),
  /** How often submitted trades are confirmed and reported to Panta for attribution. */
  PANTA_ATTRIBUTION_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
}).transform((config) => {
  const { PANTA_TRADING_ENABLED, ...rest } = withPantaRpc(config);
  const enabled =
    PANTA_TRADING_ENABLED === undefined ? rest.PANTA_API_KEY !== undefined : PANTA_TRADING_ENABLED === 'true';
  return { ...rest, PANTA_TRADING_ENABLED: enabled };
});

/** panta_bot_app: creates Panta markets on the Solana Fee Index every epoch (F10), with real USDC. */
export const PantaBotConfigSchema = PantaApiConfigSchema.extend({
  /** The Epoch program, for the FeeIndex account listed in each market's sources of truth. */
  ...EpochProgramConfigSchema.pick({ EPOCH_CLUSTER: true, EPOCH_PROGRAM_ID: true }).shape,
  /** Keypair FILE of the market creator: pays each creation fee in USDC (and SOL for fees). Never logged. */
  PANTA_BOT_KEYPAIR_PATH: z.preprocess(blank, z.string().min(1).optional()),
  /**
   * Public catalog image for every market (http/https, 1024×1024 recommended). Default: the API's own
   * `{PUBLIC_API_URL}/v1/predict/panta/market-image.png`. Required to create.
   */
  PANTA_MARKET_IMAGE_URL: optionalUrl,
  /** Epoch's public API base (https), e.g. https://api.epoch.example: markets resolve from `/v1/index/epochs/{N}`. */
  PUBLIC_API_URL: optionalUrl,
  /** Log the full plan, call nothing that writes. Also forced while the key, keypair, image or public URL is missing. */
  PANTA_DRY_RUN: flag('false'),
  /** Creation fees the bot may spend in any rolling 24 hours, USDC. Each market's fee is quoted by Panta. */
  PANTA_MAX_CREATE_USDC_PER_DAY: usdcAmount('100'),
  /**
   * Strikes per epoch: one market per strike, each paying its own creation fee inside PANTA_MAX_CREATE_USDC_PER_DAY.
   * 1 (default) asks about the median of recent final values; 3 gives p30 / p50 / p70; up to 5 (p10 … p90).
   */
  PANTA_STRIKES_PER_EPOCH: z.preprocess(blank, z.coerce.number().int().min(1).max(5).optional()),
  /** Deprecated name of PANTA_STRIKES_PER_EPOCH (read when that one is unset). */
  PANTA_MARKETS_PER_EPOCH: z.preprocess(blank, z.coerce.number().int().min(1).max(5).optional()),
  /** Markets are opened for epochs current + 1 … current + this. */
  PANTA_EPOCHS_AHEAD: z.coerce.number().int().min(1).max(4).default(2),
  /** An epoch is skipped when its market could trade for less than this. */
  PANTA_MIN_TRADING_HOURS: z.coerce.number().min(1).max(96).default(6),
  /** Trading closes this long before the epoch's estimated start (on top of the slot-time uncertainty). */
  PANTA_CLOSE_BEFORE_EPOCH_MINUTES: z.coerce.number().int().min(0).max(720).default(60),
  /** Resolution time = the epoch's estimated end + uncertainty + this (index posting, dispute window, finalize). */
  PANTA_RESOLUTION_BUFFER_HOURS: z.coerce.number().min(1).max(72).default(6),
  /** No final value this long after the resolution time → the market resolves NO (written into its rule). */
  PANTA_RESOLUTION_GRACE_HOURS: z.coerce.number().int().min(1).max(336).default(48),
  /** Strikes are quantiles of this many recent final Fee Index values (default 10). */
  PANTA_STRIKE_LOOKBACK_EPOCHS: z.preprocess(blank, z.coerce.number().int().min(2).max(64).optional()),
  /** Deprecated name of PANTA_STRIKE_LOOKBACK_EPOCHS (read when that one is unset). */
  PANTA_THRESHOLD_LOOKBACK_EPOCHS: z.preprocess(blank, z.coerce.number().int().min(2).max(64).optional()),
  PANTA_TICK_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  /** How often a registered market is checked for claimable creator fees. */
  PANTA_CREATOR_FEE_CHECK_HOURS: z.coerce.number().min(1).max(168).default(6),
  PANTA_REGION: z.string().trim().min(1).max(64).default('Global'),
  /** Mainnet USDC: the spend guard reads the bot's balance of this mint before and after each simulated create. */
  PANTA_USDC_MINT: z.string().min(32).max(44).default(USDC_MAINNET_MINT),
  /** Most SOL one create may take from the bot (network fees and rent), checked in simulation. */
  PANTA_MAX_SOL_PER_CREATE: z
    .string()
    .trim()
    .default('0.05')
    .refine((value) => /^\d+(\.\d{1,9})?$/.test(value), 'a SOL amount such as 0.05'),
  /** Priority fee for the creator-fee claim transactions the bot builds itself. */
  PANTA_CU_PRICE_MICROLAMPORTS: computeUnitPrice,
  /** The bot's share of Panta's per-account rate limits (the API takes PANTA_RATE_LIMIT_SHARE, 0.8 by default). */
  PANTA_BOT_RATE_LIMIT_SHARE: z.coerce.number().gt(0).max(1).default(0.2),
}).transform((config) => {
  const {
    PANTA_STRIKES_PER_EPOCH,
    PANTA_MARKETS_PER_EPOCH,
    PANTA_STRIKE_LOOKBACK_EPOCHS,
    PANTA_THRESHOLD_LOOKBACK_EPOCHS,
    ...rest
  } = withPantaRpc(config);
  const publicApi = rest.PUBLIC_API_URL?.replace(/\/+$/, '');
  return {
    ...rest,
    PANTA_STRIKES_PER_EPOCH: PANTA_STRIKES_PER_EPOCH ?? PANTA_MARKETS_PER_EPOCH ?? 1,
    PANTA_STRIKE_LOOKBACK_EPOCHS: PANTA_STRIKE_LOOKBACK_EPOCHS ?? PANTA_THRESHOLD_LOOKBACK_EPOCHS ?? 10,
    PANTA_MARKET_IMAGE_URL:
      rest.PANTA_MARKET_IMAGE_URL ?? (publicApi ? `${publicApi}${PANTA_MARKET_IMAGE_PATH}` : undefined),
  };
});

export type PantaApiConfig = z.infer<typeof PantaApiConfigSchema>;
export type PantaTradingConfig = z.infer<typeof PantaTradingConfigSchema>;
export type PantaBotConfig = z.infer<typeof PantaBotConfigSchema>;
