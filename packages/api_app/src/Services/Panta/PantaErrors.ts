import { EpochException, ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import {
  PantaApiError,
  PantaBudgetError,
  PantaConfigError,
  PantaError,
  PantaInputError,
  PantaNetworkError,
  PantaResponseError,
} from '@epoch/panta';

const logger = Logger.create('PantaErrors');

/** Panta's documented codes → this API's status and stable code (`PANTA_…`), with the message the app may show. */
const BY_CODE: Record<string, { status: number; code: string; message: string }> = {
  INVALID_MARKET_PARAMS: { status: 400, code: 'PANTA_INVALID_PARAMS', message: 'Panta rejected the request' },
  AMOUNT_TOO_SMALL: { status: 400, code: 'PANTA_AMOUNT_TOO_SMALL', message: 'The amount is below Panta’s minimum' },
  MARKET_NOT_FOUND: { status: 404, code: 'PANTA_MARKET_NOT_FOUND', message: 'No such Panta market' },
  MARKET_NOT_IN_PRIMARY: {
    status: 409,
    code: 'PANTA_MARKET_CLOSED',
    message: 'This market is not taking buys any more',
  },
  QUOTE_EXPIRED: { status: 409, code: 'PANTA_QUOTE_EXPIRED', message: 'The quote expired: get a new one' },
  QUOTE_STALE: { status: 409, code: 'PANTA_QUOTE_STALE', message: 'The price moved past your slippage: re-quote' },
  NOT_CLAIMABLE: { status: 409, code: 'PANTA_NOT_CLAIMABLE', message: 'Nothing to claim in this market' },
  TX_NOT_FOUND: { status: 409, code: 'PANTA_TX_NOT_FOUND', message: 'Panta has not seen the transaction yet' },
  TX_FAILED: { status: 409, code: 'PANTA_TX_FAILED', message: 'The transaction failed on chain' },
  TX_MISMATCH: { status: 400, code: 'PANTA_TX_MISMATCH', message: 'The transaction does not match the order' },
  TX_FEE_MISMATCH: { status: 400, code: 'PANTA_TX_FEE_MISMATCH', message: 'The transaction amount does not match' },
  DUPLICATE_MARKET: { status: 409, code: 'PANTA_DUPLICATE_MARKET', message: 'That market already exists' },
  CREATE_EXPIRED: { status: 409, code: 'PANTA_CREATE_EXPIRED', message: 'The create session expired' },
  NOT_MARKET_CREATOR: { status: 403, code: 'PANTA_NOT_MARKET_CREATOR', message: 'Only the market creator can' },
  MARKET_NOT_GRADUATED: { status: 409, code: 'PANTA_MARKET_NOT_GRADUATED', message: 'The market has not graduated' },
  NO_CREATOR_FEES: { status: 409, code: 'PANTA_NO_CREATOR_FEES', message: 'No creator fees to claim' },
  // Eligibility, region and account restrictions Panta enforces: shown as such, never worked around.
  FORBIDDEN: {
    status: 403,
    code: 'PANTA_FORBIDDEN',
    message: 'Panta does not allow this for this wallet or region',
  },
  CREATE_NOT_PERMITTED: {
    status: 403,
    code: 'PANTA_CREATE_NOT_PERMITTED',
    message: 'Market creation is not permitted for this account',
  },
};

/**
 * Turns anything `@epoch/panta` throws into an EpochException with a stable code. Panta's own words (`message`,
 * `field`, `fields`) go into `details`; credentials and headers never do (the client never puts them in errors).
 * 401 from Panta is OUR key's problem (503 PANTA_AUTH_FAILED), never the user's.
 */
export function toEpochException(error: unknown): EpochException {
  if (error instanceof EpochException) return error;
  if (error instanceof PantaBudgetError) {
    return new EpochException('Predict is busy right now: try again shortly', 'PANTA_BUSY', 429, {
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  if (error instanceof PantaConfigError) {
    return new ServiceUnavailableException(
      'Real-money Predict is not configured on this server',
      'PANTA_NOT_CONFIGURED',
    );
  }
  if (error instanceof PantaNetworkError) {
    return new EpochException('Panta did not answer', 'PANTA_UNAVAILABLE', 502, { timedOut: error.timedOut });
  }
  if (error instanceof PantaResponseError) {
    logger.error('Panta answered in an unexpected shape', undefined, {
      endpoint: error.endpoint,
      issues: error.issues,
    });
    return new EpochException('Panta answered in an unexpected shape', 'PANTA_BAD_RESPONSE', 502);
  }
  if (error instanceof PantaInputError) {
    return new EpochException(error.message, 'PANTA_BAD_REQUEST', 400);
  }
  if (error instanceof PantaApiError) {
    const details: Record<string, unknown> = { pantaCode: error.code };
    if (error.message) details.pantaMessage = error.message;
    if (error.field) details.field = error.field;
    if (error.fields) details.fields = error.fields;
    if (error.status === 429) {
      return new EpochException('Panta is rate-limiting us: try again shortly', 'PANTA_RATE_LIMITED', 429, {
        ...details,
        retryAfterSeconds: error.retryAfterSeconds ?? 5,
      });
    }
    if (error.status === 401) {
      logger.error('Panta refused our API key', undefined, { endpoint: error.endpoint });
      return new ServiceUnavailableException('Real-money Predict is unavailable right now', 'PANTA_AUTH_FAILED');
    }
    const known = BY_CODE[error.code];
    if (known) return new EpochException(known.message, known.code, known.status, details);
    if (error.status === 403) {
      return new EpochException(BY_CODE.FORBIDDEN.message, BY_CODE.FORBIDDEN.code, 403, details);
    }
    if (error.status >= 500) return new EpochException('Panta failed to answer', 'PANTA_UNAVAILABLE', 502, details);
    return new EpochException(
      'Panta rejected the request',
      'PANTA_ERROR',
      error.status >= 400 ? error.status : 400,
      details,
    );
  }
  if (error instanceof PantaError) return new EpochException(error.message, 'PANTA_ERROR', 502);
  return new EpochException('Internal server error', 'INTERNAL', 500);
}

/** Runs `fn`, rethrowing Panta failures as EpochExceptions (anything else passes through untouched). */
export async function mapPanta<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PantaError) throw toEpochException(error);
    throw error;
  }
}
