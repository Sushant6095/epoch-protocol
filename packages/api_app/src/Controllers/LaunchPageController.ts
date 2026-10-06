import type { Request, Response } from '@epoch/common_http_server';

import type { LaunchParams } from '../dto/Launch.dto';
import type {
  LaunchBuildBody,
  LaunchCandlesQuery,
  LaunchIndexedQuery,
  LaunchQuoteBody,
  LaunchTradesQuery,
} from '../dto/LaunchPage.dto';
import { getLaunchPageServices } from '../Services/Launch/LaunchLive';
import type {
  LaunchBuildResponse,
  LaunchCandles,
  LaunchFees,
  LaunchHolders,
  LaunchIndexed,
  LaunchMarket,
  LaunchPage,
  LaunchQuoteResponse,
  LaunchTradeList,
} from '../types/LaunchPage.types';

const mintOf = (res: Response): string => (res.locals.params as LaunchParams).mint;

/** The Launch page's live data (plan F13, docs/pages/launch.md). Public; quotes and builds are rate-limited per IP. */
export class LaunchPageController {
  /** GET /v1/launches/:mint/page — the first-paint bundle */
  static async page(_req: Request, res: Response): Promise<LaunchPage> {
    res.setHeader('cache-control', 'no-store');
    return getLaunchPageServices().page.page(mintOf(res));
  }

  /** GET /v1/launches/:mint/market */
  static async market(_req: Request, res: Response): Promise<LaunchMarket> {
    res.setHeader('cache-control', 'no-store');
    return getLaunchPageServices().page.market(mintOf(res));
  }

  /** GET /v1/launches/:mint/trades?limit=&before= */
  static async trades(_req: Request, res: Response): Promise<LaunchTradeList> {
    const query = res.locals.query as LaunchTradesQuery;
    res.setHeader('cache-control', 'no-store');
    return getLaunchPageServices().page.trades(mintOf(res), { limit: query.limit, before: query.before ?? null });
  }

  /** GET /v1/launches/:mint/candles?interval=&from=&to= */
  static async candles(_req: Request, res: Response): Promise<LaunchCandles> {
    const query = res.locals.query as LaunchCandlesQuery;
    res.setHeader('cache-control', 'public, max-age=5');
    return getLaunchPageServices().page.candles(mintOf(res), query);
  }

  /** GET /v1/launches/:mint/holders */
  static async holders(_req: Request, res: Response): Promise<LaunchHolders> {
    res.setHeader('cache-control', 'public, max-age=30');
    return getLaunchPageServices().page.holders(mintOf(res));
  }

  /** GET /v1/launches/:mint/fees */
  static async fees(_req: Request, res: Response): Promise<LaunchFees> {
    res.setHeader('cache-control', 'public, max-age=15');
    return getLaunchPageServices().page.fees(mintOf(res));
  }

  /** GET /v1/launches/:mint/indexed?timeframe= — the graduated pool through Meteora's DAMM v2 data API */
  static async indexed(_req: Request, res: Response): Promise<LaunchIndexed> {
    const query = res.locals.query as LaunchIndexedQuery;
    res.setHeader('cache-control', 'public, max-age=30');
    return getLaunchPageServices().page.indexed(mintOf(res), { timeframe: query.timeframe });
  }

  /** POST /v1/launches/:mint/quote */
  static async quote(_req: Request, res: Response): Promise<LaunchQuoteResponse> {
    res.setHeader('cache-control', 'no-store');
    return getLaunchPageServices().page.quote(mintOf(res), res.locals.body as LaunchQuoteBody);
  }

  /** POST /v1/launches/:mint/build */
  static async build(_req: Request, res: Response): Promise<LaunchBuildResponse> {
    const body = res.locals.body as LaunchBuildBody;
    res.setHeader('cache-control', 'no-store');
    return getLaunchPageServices().page.build(mintOf(res), { ...body, consent: body.consent === true });
  }
}
