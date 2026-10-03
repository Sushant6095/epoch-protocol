import {
  createRouter,
  handle,
  type HttpRouter,
  type NextFunction,
  type Request,
  type Response,
  validate,
} from '@epoch/common_http_server';
import { EpochException } from '@epoch/exceptions';

import { AuthController } from '../Controllers/AuthController';
import { MeController } from '../Controllers/MeController';
import { PredictController } from '../Controllers/PredictController';
import {
  AlertPrefsPutDto,
  LeaderboardQueryDto,
  PredictCallDto,
  SiwsVerifyDto,
  WatchlistPutDto,
} from '../dto/Account.dto';
import { dbAvailable } from '../Lib/Db';
import { isAppOrigin } from '../Lib/Origins';
import { getAccountServices } from '../Services/Account';
import { createSessionMiddleware } from '../Services/Auth/SessionMiddleware';

/**
 * Fills `res.locals.session` from the session cookie. Register it with `.use()` before the routes; without
 * DATABASE_URL it does nothing (every request is signed out). Browser requests from other sites are signed out.
 */
export const sessionMiddleware = createSessionMiddleware(() => {
  if (!dbAvailable()) return undefined;
  const { sessions, auth, config } = getAccountServices();
  return { store: sessions, cookieName: auth.cookieName, appHosts: config.auth.SIWS_ALLOWED_DOMAINS };
});

/**
 * CSRF guard for sign-in and cookie-authenticated writes: a browser request must come from one of the app's own hosts
 * (SIWS_ALLOWED_DOMAINS), else 403 ORIGIN_NOT_ALLOWED. Requests without an Origin header (curl, servers) pass.
 */
function sameAppOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (!origin || isAppOrigin(origin, getAccountServices().config.auth.SIWS_ALLOWED_DOMAINS)) return next();
  next(new EpochException('Requests from this site are not accepted', 'ORIGIN_NOT_ALLOWED', 403, { origin }));
}

/** /v1/auth: Sign-In With Solana (request #7). */
export const authRouter: HttpRouter = createRouter()
  .post('/siws/nonce', handle(AuthController.nonce))
  .post('/siws/verify', sameAppOrigin, validate(SiwsVerifyDto), handle(AuthController.verify))
  .post('/logout', sameAppOrigin, handle(AuthController.logout))
  .get('/session', handle(AuthController.session));

/** /v1/me: the signed-in wallet's watchlist and alerts (requests #14, #15). */
export const meRouter: HttpRouter = createRouter()
  .get('/watchlist', handle(MeController.watchlist))
  .put('/watchlist', sameAppOrigin, validate(WatchlistPutDto), handle(MeController.putWatchlist))
  .get('/alerts', handle(MeController.alerts))
  .put('/alerts', sameAppOrigin, validate(AlertPrefsPutDto), handle(MeController.putAlerts))
  .post('/alerts/telegram-link', sameAppOrigin, handle(MeController.telegramLink))
  .post('/alerts/test', sameAppOrigin, handle(MeController.testAlert));

/** /v1/predict: points mode (request #11). */
export const predictRouter: HttpRouter = createRouter()
  .get('/markets', handle(PredictController.markets))
  .get('/leaderboard', validate(LeaderboardQueryDto, 'query'), handle(PredictController.leaderboard))
  .post('/calls', sameAppOrigin, validate(PredictCallDto), handle(PredictController.call));
