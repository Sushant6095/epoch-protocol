/**
 * Typed Panta errors. The API answers failures as `{ code, message, field?, fields? }`
 * (https://docs.panta.market/guides/errors.md): switch on `code`, not only on the HTTP status. Apps map these to their
 * own exceptions (api_app: `Services/Panta/PantaErrors.ts`). No error here ever carries the API key or request headers.
 */

/** Every code the errors guide documents (3 Oct 2026). Panta may add more: `PantaApiError.code` is a plain string. */
export const PANTA_ERROR_CODES = [
  'UNAUTHORIZED',
  'EMAIL_TAKEN',
  'CREATE_NOT_PERMITTED',
  'FORBIDDEN',
  'INVALID_MARKET_PARAMS',
  'DUPLICATE_MARKET',
  'CREATE_EXPIRED',
  'QUOTE_EXPIRED',
  'QUOTE_STALE',
  'AMOUNT_TOO_SMALL',
  'MARKET_NOT_FOUND',
  'MARKET_NOT_IN_PRIMARY',
  'NOT_CLAIMABLE',
  'NOT_MARKET_CREATOR',
  'MARKET_NOT_GRADUATED',
  'NO_CREATOR_FEES',
  'UPLOAD_NOT_CONFIGURED',
  'TX_NOT_FOUND',
  'TX_FAILED',
  'TX_MISMATCH',
  'TX_FEE_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type PantaErrorCode = (typeof PANTA_ERROR_CODES)[number];

const KNOWN = new Set<string>(PANTA_ERROR_CODES);

/** True for a code the errors guide documents. */
export const isKnownPantaCode = (code: string): code is PantaErrorCode => KNOWN.has(code);

/** Base class: anything that went wrong talking to Panta. */
export class PantaError extends Error {
  constructor(
    message: string,
    /** `METHOD /path/` of the call, ids included (wallets and market ids are public); never query secrets. */
    readonly endpoint: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface PantaApiErrorInit {
  endpoint: string;
  status: number;
  code: string;
  message: string;
  field?: string;
  fields?: Record<string, string[]>;
  requestId?: string;
  /** From `Retry-After` on a 429. */
  retryAfterSeconds?: number;
}

/** Panta answered with an error status and (usually) an error envelope. */
export class PantaApiError extends PantaError {
  readonly status: number;
  /** Panta's `code`, or `HTTP_<status>` when the body had none. */
  readonly code: string;
  readonly field?: string;
  readonly fields?: Record<string, string[]>;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(init: PantaApiErrorInit) {
    super(init.message, init.endpoint);
    this.status = init.status;
    this.code = init.code;
    this.field = init.field;
    this.fields = init.fields;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** True for one of the codes the docs list. */
  get known(): boolean {
    return isKnownPantaCode(this.code);
  }

  /** `PantaApiError.is(error, 'DUPLICATE_MARKET')`. */
  static is(error: unknown, ...codes: PantaErrorCode[]): error is PantaApiError {
    return error instanceof PantaApiError && (codes.length === 0 || (codes as string[]).includes(error.code));
  }
}

/** 400: validation or business rule (INVALID_MARKET_PARAMS, AMOUNT_TOO_SMALL, QUOTE_STALE, TX_MISMATCH, …). */
export class PantaRequestError extends PantaApiError {}
/** 401: our credentials were refused (or a wallet binding failed). Never the end user's fault. */
export class PantaAuthError extends PantaApiError {}
/** 403: authenticated but not permitted (FORBIDDEN, CREATE_NOT_PERMITTED): eligibility, region or account limits. */
export class PantaForbiddenError extends PantaApiError {}
/** 404: market or transaction not found. */
export class PantaNotFoundError extends PantaApiError {}
/** 409: conflict. */
export class PantaConflictError extends PantaApiError {}
/** 429: Panta's rate limit. `retryAfterSeconds` from `Retry-After`. */
export class PantaRateLimitedError extends PantaApiError {}
/** 5xx: Panta failed (INTERNAL_ERROR, UPLOAD_NOT_CONFIGURED…). Retryable. */
export class PantaServerError extends PantaApiError {}

/** Builds the subclass that matches the HTTP status. */
export function pantaApiError(init: PantaApiErrorInit): PantaApiError {
  const { status } = init;
  if (status === 429 || init.code === 'RATE_LIMITED') return new PantaRateLimitedError(init);
  if (status >= 500) return new PantaServerError(init);
  if (status === 401) return new PantaAuthError(init);
  if (status === 403) return new PantaForbiddenError(init);
  if (status === 404) return new PantaNotFoundError(init);
  if (status === 409) return new PantaConflictError(init);
  return new PantaRequestError(init);
}

/** No answer: connection refused, DNS, TLS, or the timeout fired. Retryable. */
export class PantaNetworkError extends PantaError {
  constructor(
    message: string,
    endpoint: string,
    readonly timedOut: boolean,
  ) {
    super(message, endpoint);
  }
}

/** A 2xx answer that did not match the documented shape. Not retried: the same call would fail the same way. */
export class PantaResponseError extends PantaError {
  constructor(
    message: string,
    endpoint: string,
    /** zod issue paths and messages, never values. */
    readonly issues: string[],
  ) {
    super(message, endpoint);
  }
}

/** This process's own request budget for the family is spent (or Panta asked us to wait). Nothing was sent. */
export class PantaBudgetError extends PantaError {
  constructor(
    endpoint: string,
    readonly family: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`Panta ${family} budget spent; retry in ${retryAfterSeconds}s`, endpoint);
  }
}

/** The client cannot call Panta at all (no API key). */
export class PantaConfigError extends PantaError {}

/** A request this client refuses to send (bad id, out-of-range amount). Nothing was sent. */
export class PantaInputError extends PantaError {}

/** Worth trying again later: 429, 5xx, network, our own budget. */
export function isRetryablePantaError(error: unknown): boolean {
  return (
    error instanceof PantaRateLimitedError ||
    error instanceof PantaServerError ||
    error instanceof PantaNetworkError ||
    error instanceof PantaBudgetError
  );
}

/** Seconds to wait before retrying, when the error says. */
export function pantaRetryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof PantaBudgetError) return error.retryAfterSeconds;
  if (error instanceof PantaApiError) return error.retryAfterSeconds;
  return undefined;
}
