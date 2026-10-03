import { type Request, type Response } from '@epoch/common_http_server';

import { requireDb } from '../Lib/Db';
import { currentSession, requireSession } from '../Lib/Session';
import { type LeaderboardQuery, type PredictCallBody } from '../dto/Account.dto';
import { getAccountServices } from '../Services/Account';
import { type PredictLeaderboard, type PredictSnapshot } from '../types/Account.types';

/** Predict in points mode (request #11). Reading is public; a call needs the sign-in session, never a transaction. */
export class PredictController {
  /** GET /v1/predict/markets (with the session: points left and the wallet's calls) */
  static async markets(_req: Request, res: Response): Promise<PredictSnapshot> {
    requireDb();
    res.setHeader('cache-control', 'private, no-store');
    return getAccountServices().predict.snapshot(currentSession(res)?.address);
  }

  /** POST /v1/predict/calls { marketId, side, points } → the fresh snapshot for the wallet. */
  static async call(_req: Request, res: Response): Promise<PredictSnapshot> {
    requireDb();
    res.setHeader('cache-control', 'private, no-store');
    const { address } = requireSession(res);
    return getAccountServices().predict.call(address, res.locals.body as PredictCallBody);
  }

  /** GET /v1/predict/leaderboard?epochs=30 */
  static async leaderboard(_req: Request, res: Response): Promise<PredictLeaderboard> {
    requireDb();
    const { predict, config } = getAccountServices();
    const { epochs } = res.locals.query as LeaderboardQuery;
    res.setHeader('cache-control', 'public, max-age=60');
    return predict.leaderboard(epochs ?? config.predict.PREDICT_LEADERBOARD_EPOCHS);
  }
}
