import {
  createRouter,
  handle,
  type HttpRouter,
  type NextFunction,
  type Request,
  type Response,
  validate,
} from '@epoch/common_http_server';

import { LaunchPageController } from '../Controllers/LaunchPageController';
import { LaunchParamsDto } from '../dto/Launch.dto';
import {
  LaunchBuildBodyDto,
  LaunchCandlesQueryDto,
  LaunchQuoteBodyDto,
  LaunchTradesQueryDto,
} from '../dto/LaunchPage.dto';
import { getLaunchPageServices } from '../Services/Launch/LaunchLive';

/** Quotes and builds read the pools: LAUNCH_TRADE_REQUESTS_PER_MINUTE per IP. */
function tradeLimit(req: Request, _res: Response, next: NextFunction): void {
  try {
    getLaunchPageServices().tradeLimiter.consume(req.ip ?? 'unknown', 'Too many trade requests; try again in a minute');
    next();
  } catch (error) {
    next(error);
  }
}

const params = validate(LaunchParamsDto, 'params');

/**
 * The Launch page's live data under /v1/launches (plan F13, docs/pages/launch.md), next to `launchRouter`'s list and
 * detail: the first-paint bundle, market, trades, candles, holders, fees, and the buy/sell ticket.
 */
export const launchPageRouter: HttpRouter = createRouter()
  .get('/:mint/page', params, handle(LaunchPageController.page))
  .get('/:mint/market', params, handle(LaunchPageController.market))
  .get('/:mint/trades', params, validate(LaunchTradesQueryDto, 'query'), handle(LaunchPageController.trades))
  .get('/:mint/candles', params, validate(LaunchCandlesQueryDto, 'query'), handle(LaunchPageController.candles))
  .get('/:mint/holders', params, handle(LaunchPageController.holders))
  .get('/:mint/fees', params, handle(LaunchPageController.fees))
  .post('/:mint/quote', tradeLimit, params, validate(LaunchQuoteBodyDto), handle(LaunchPageController.quote))
  .post('/:mint/build', tradeLimit, params, validate(LaunchBuildBodyDto), handle(LaunchPageController.build));
