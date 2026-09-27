import winston from 'winston';

import { getTraceId } from './TraceContext';

const isProduction = process.env.NODE_ENV === 'production';

const root = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format((info) => {
      const traceId = getTraceId();
      if (traceId) info.traceId = traceId;
      return info;
    })(),
    isProduction
      ? winston.format.json()
      : winston.format.printf(({ timestamp, level, message, tag, traceId, ...meta }) => {
          const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          const trace = traceId ? ` [${String(traceId).slice(0, 8)}]` : '';
          return `${timestamp} ${level.toUpperCase()} [${tag}]${trace} ${message}${extra}`;
        }),
  ),
  transports: [new winston.transports.Console()],
});

export type LogMeta = Record<string, unknown>;

/** Tagged logger. Create one per module: `const logger = Logger.create('SweepJob');` */
export class Logger {
  private constructor(private readonly child: winston.Logger) {}

  static create(tag: string): Logger {
    return new Logger(root.child({ tag }));
  }

  debug(message: string, meta: LogMeta = {}): void {
    this.child.debug(message, meta);
  }

  info(message: string, meta: LogMeta = {}): void {
    this.child.info(message, meta);
  }

  warn(message: string, meta: LogMeta = {}): void {
    this.child.warn(message, meta);
  }

  error(message: string, error?: unknown, meta: LogMeta = {}): void {
    const err = error instanceof Error ? { error: error.message, stack: error.stack } : { error };
    this.child.error(message, { ...meta, ...err });
  }
}
