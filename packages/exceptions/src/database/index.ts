import { EpochException, type ExceptionDetails } from '../EpochException';

export class DatabaseException extends EpochException {
  constructor(message: string, details: ExceptionDetails = {}) {
    super(message, 'DATABASE_ERROR', 500, details);
  }
}
