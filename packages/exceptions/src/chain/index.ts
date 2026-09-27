import { EpochException, type ExceptionDetails } from '../EpochException';

/** RPC, gRPC or program errors. */
export class ChainException extends EpochException {
  constructor(message: string, details: ExceptionDetails = {}) {
    super(message, 'CHAIN_ERROR', 502, details);
  }
}

export class TransactionFailedException extends EpochException {
  constructor(message: string, details: ExceptionDetails = {}) {
    super(message, 'TRANSACTION_FAILED', 502, details);
  }
}
