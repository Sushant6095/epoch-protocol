import type { NextFunction, Request, RequestHandler as ExpressHandler, Response } from 'express';

import { ok } from './ResponseType';

type Handler<T> = (req: Request, res: Response) => Promise<T>;

/** Wraps an async controller: success → `{ ok: true, data }`, errors → the shared error handler. */
export function handle<T>(fn: Handler<T>): ExpressHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res)
      .then((data) => {
        if (!res.headersSent) res.json(ok(data));
      })
      .catch(next);
  };
}
