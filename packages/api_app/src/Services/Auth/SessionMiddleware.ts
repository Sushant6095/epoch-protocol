import { type NextFunction, parseCookies, type Request, type Response } from '@epoch/common_http_server';
import { Logger } from '@epoch/logger';

import { isAppOrigin } from '../../Lib/Origins';
import { SESSION_LOCALS_KEY } from '../../Lib/Session';
import { type SessionStore } from './SessionStore';

const logger = Logger.create('SessionMiddleware');

/** What the middleware needs; `undefined` (no database) turns it into a no-op. */
export interface SessionSource {
  store: SessionStore;
  cookieName: string;
  /** The app's hosts (SIWS_ALLOWED_DOMAINS): a browser request from any other origin is treated as signed out. */
  appHosts: readonly string[];
}

/**
 * Express middleware that fills `res.locals.session` from the session cookie. Register it before the routes. A missing,
 * unknown, expired or revoked cookie, or a database error, just leaves the request signed out: it never fails one.
 * A request whose `Origin` is not one of the app's hosts is signed out too, so another site can neither act with the
 * cookie nor read the wallet's data, whatever SameSite and CORS allow. Requests without an Origin (servers) use it.
 */
export function createSessionMiddleware(source: () => SessionSource | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let resolved: SessionSource | undefined;
    let token: string | undefined;
    try {
      resolved = source();
      const origin = req.get('origin');
      const trusted = !origin || (resolved !== undefined && isAppOrigin(origin, resolved.appHosts));
      token = resolved && trusted ? parseCookies(req)[resolved.cookieName] : undefined;
    } catch (error) {
      logger.warn('session middleware could not start; continuing signed out', { error: String(error) });
    }
    if (!resolved || !token) {
      next();
      return;
    }
    resolved.store.lookup(token).then(
      (session) => {
        if (session) res.locals[SESSION_LOCALS_KEY] = session;
        next();
      },
      (error: unknown) => {
        logger.warn('session lookup failed; continuing signed out', { error: String(error) });
        next();
      },
    );
  };
}
