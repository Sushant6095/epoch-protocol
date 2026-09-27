import { EpochException, type ExceptionDetails } from '../EpochException';

export class BadRequestException extends EpochException {
  constructor(message = 'Bad request', details: ExceptionDetails = {}) {
    super(message, 'BAD_REQUEST', 400, details);
  }
}

export class UnauthorizedException extends EpochException {
  constructor(message = 'Unauthorized', details: ExceptionDetails = {}) {
    super(message, 'UNAUTHORIZED', 401, details);
  }
}

export class NotFoundException extends EpochException {
  constructor(message = 'Not found', details: ExceptionDetails = {}) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class ConflictException extends EpochException {
  constructor(message = 'Conflict', details: ExceptionDetails = {}) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class InternalServerException extends EpochException {
  constructor(message = 'Internal server error', details: ExceptionDetails = {}) {
    super(message, 'INTERNAL', 500, details);
  }
}
