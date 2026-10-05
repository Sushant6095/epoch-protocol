/**
 * @epoch/panta: a typed client for the Panta public API (USDC prediction markets on Solana mainnet,
 * https://docs.panta.market). Per-family request budgets under Panta's per-account rate limits, retries with jittered
 * backoff, zod-validated answers, typed errors, and helpers that turn Panta's instruction lists into one unsigned
 * transaction a wallet can sign. The API key stays server-side: it only ever travels in the `X-Api-Key` header.
 */

export {
  type BuyBuildRequest,
  type BuyQuoteRequest,
  type ListMarketsParams,
  PANTA_DEFAULT_BASE_URL,
  type PantaApi,
  PantaClient,
  type PantaClientOptions,
  retryAfterSeconds,
} from './client';
export {
  type FamilyBudget,
  PANTA_FAMILIES,
  PANTA_RATE_LIMITS,
  type PantaFamily,
  type RateLimit,
  RequestBudget,
  type RequestBudgetOptions,
} from './budget';
export {
  isKnownPantaCode,
  isRetryablePantaError,
  PANTA_ERROR_CODES,
  PantaApiError,
  type PantaApiErrorInit,
  pantaApiError,
  PantaAuthError,
  PantaBudgetError,
  PantaConfigError,
  PantaConflictError,
  PantaError,
  type PantaErrorCode,
  PantaForbiddenError,
  PantaInputError,
  PantaNetworkError,
  PantaNotFoundError,
  PantaRateLimitedError,
  PantaRequestError,
  PantaResponseError,
  pantaRetryAfterSeconds,
  PantaServerError,
} from './errors';
export * from './schemas';
export {
  compileUnsignedTransaction,
  decodeTransaction,
  describeTransaction,
  messageHash,
  toTransactionInstructions,
  transactionSignature,
  type TransactionSummary,
  type UnsignedTransaction,
} from './transactions';
export { baseToUsdc, baseUnits, decimalToNumber, isUsdcAmount, USDC_DECIMALS, usdcToBase } from './units';
