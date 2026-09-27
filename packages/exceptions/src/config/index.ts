import { EpochException, type ExceptionDetails } from '../EpochException';

export class ConfigException extends EpochException {
  constructor(message: string, details: ExceptionDetails = {}) {
    super(message, 'CONFIG_ERROR', 500, details);
  }
}
