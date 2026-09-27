import { randomUUID } from 'crypto';
import type { Server } from 'http';

import { GracefulShutdown } from '@epoch/common';
import { EpochException } from '@epoch/exceptions';
import { getTraceId, Logger, runWithTrace } from '@epoch/logger';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express';

import { type ApiError } from './ResponseType';

export interface ExpressAppServerProps {
  appName: string;
  port: number;
  corsOrigins?: string;
  requestBodyLimit?: string;
}

/** Shared HTTP server: CORS, JSON body, trace IDs, access logs, 404 and error mapping. */
export class ExpressAppServer {
  readonly app: Express;
  private readonly logger: Logger;
  private server?: Server;

  constructor(private readonly props: ExpressAppServerProps) {
    this.logger = Logger.create(props.appName);
    this.app = express();
    this.app.disable('x-powered-by');
    this.app.use(
      cors({ origin: props.corsOrigins === '*' || !props.corsOrigins ? true : props.corsOrigins.split(',') }),
    );
    this.app.use(express.json({ limit: props.requestBodyLimit ?? '1mb' }));
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const traceId = req.header('x-request-id') ?? randomUUID();
      res.setHeader('x-request-id', traceId);
      const started = Date.now();
      res.on('finish', () =>
        this.logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, { ms: Date.now() - started }),
      );
      runWithTrace(next, traceId);
    });
  }

  route(path: string, router: Router): this {
    this.app.use(path, router);
    return this;
  }

  start(): Promise<void> {
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      next(new EpochException(`Route not found: ${req.method} ${req.path}`, 'NOT_FOUND', 404));
    });
    // Express error handlers need all four arguments.

    this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const exception =
        err instanceof EpochException ? err : new EpochException('Internal server error', 'INTERNAL', 500);
      if (exception.statusCode >= 500) this.logger.error('Request failed', err);
      const body: ApiError = { ok: false, error: exception.toJSON(), traceId: getTraceId() };
      res.status(exception.statusCode).json(body);
    });

    return new Promise((resolve) => {
      this.server = this.app.listen(this.props.port, () => {
        this.logger.info(`listening on :${this.props.port}`);
        resolve();
      });
      GracefulShutdown.register(`${this.props.appName}-http`, () => this.stop());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
