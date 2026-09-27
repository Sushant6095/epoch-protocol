export interface ExceptionDetails {
  [key: string]: unknown;
}

/** Base class for every error Epoch throws on purpose. */
export class EpochException extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
    public readonly details: ExceptionDetails = {},
  ) {
    super(message);
    this.name = new.target.name;
  }

  toJSON(): { code: string; message: string; details: ExceptionDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
