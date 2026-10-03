import { type Request, type Response } from '@epoch/common_http_server';

import { requireDb } from '../Lib/Db';
import { requireSession, type SessionInfo } from '../Lib/Session';
import { type AlertPrefsPutBody, type WatchlistPutBody } from '../dto/Account.dto';
import { getAccountServices } from '../Services/Account';
import { type AlertPrefs, type AlertTestResult, type TelegramLink, type Watchlist } from '../types/Account.types';

/** 503 without Postgres, 401 when signed out; private data is never cached. */
function signedIn(res: Response): SessionInfo {
  requireDb();
  res.setHeader('cache-control', 'private, no-store');
  return requireSession(res);
}

/** The signed-in wallet's watchlist and alerts (requests #14, #15). */
export class MeController {
  /** GET /v1/me/watchlist */
  static async watchlist(_req: Request, res: Response): Promise<Watchlist> {
    return getAccountServices().watchlist.get(signedIn(res).address);
  }

  /** PUT /v1/me/watchlist { votes } */
  static async putWatchlist(_req: Request, res: Response): Promise<Watchlist> {
    const { address } = signedIn(res);
    const body = res.locals.body as WatchlistPutBody;
    return getAccountServices().watchlist.put(address, body.votes);
  }

  /** GET /v1/me/alerts */
  static async alerts(_req: Request, res: Response): Promise<AlertPrefs> {
    return getAccountServices().alerts.get(signedIn(res).address);
  }

  /** PUT /v1/me/alerts { rules, channels?, reminders? } */
  static async putAlerts(_req: Request, res: Response): Promise<AlertPrefs> {
    const { address } = signedIn(res);
    const body = res.locals.body as AlertPrefsPutBody;
    return getAccountServices().alerts.put(address, body);
  }

  /** POST /v1/me/alerts/telegram-link */
  static async telegramLink(_req: Request, res: Response): Promise<TelegramLink> {
    return getAccountServices().alerts.createTelegramLink(signedIn(res).address);
  }

  /** POST /v1/me/alerts/test */
  static async testAlert(_req: Request, res: Response): Promise<AlertTestResult> {
    return getAccountServices().alerts.sendTest(signedIn(res).address);
  }
}
