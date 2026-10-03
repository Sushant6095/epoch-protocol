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

export class ForbiddenException extends EpochException {
  constructor(message = 'Forbidden', details: ExceptionDetails = {}) {
    super(message, 'FORBIDDEN', 403, details);
  }
}

export class TooManyRequestsException extends EpochException {
  constructor(message = 'Too many requests', details: ExceptionDetails = {}) {
    super(message, 'TOO_MANY_REQUESTS', 429, details);
  }
}

/** A dependency is missing or not ready (no database, program not deployed, scan running). `code` says which. */
export class ServiceUnavailableException extends EpochException {
  constructor(message: string, code = 'UNAVAILABLE', details: ExceptionDetails = {}) {
    super(message, code, 503, details);
  }
}
