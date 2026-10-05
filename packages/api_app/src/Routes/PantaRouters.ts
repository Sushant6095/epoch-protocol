import {
  createRouter,
  handle,
  type HttpRouter,
  type NextFunction,
  type Request,
  type Response,
  validate,
} from '@epoch/common_http_server';
import { EpochException, ServiceUnavailableException } from '@epoch/exceptions';

import { FeeIndexEpochController, PantaController } from '../Controllers/PantaController';
import {
  FeeIndexEpochParamsDto,
  PantaBuildDto,
  PantaClaimDto,
  PantaMarketParamsDto,
  PantaMarketsQueryDto,
  PantaPositionsQueryDto,
  PantaQuoteDto,
  PantaSubmitDto,
  PantaTradeParamsDto,
} from '../dto/Panta.dto';
import { type RateLimiter } from '../Lib/RateLimiter';
import { currentSession } from '../Lib/Session';
import { getPantaServices, type PantaLimits } from '../Services/Panta';
import { countryOf, isGeoBlocked } from '../Services/Panta/PantaSupport';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/**
 * Counts the request against one of our limits (429 TOO_MANY_REQUESTS with `retryAfterSeconds`). Keys: the IP
 * (`req.ip`, real behind a proxy with API_TRUST_PROXY) or the signed-in wallet.
 */
function limit(pick: (limits: PantaLimits) => RateLimiter, by: 'ip' | 'wallet', message: string): Middleware {
  return (req, res, next) => {
    try {
      const key = by === 'ip' ? `ip:${req.ip ?? 'unknown'}` : currentSession(res)?.address;
      if (key) pick(getPantaServices().limits).consume(key, message);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Trading routes answer 503 while trading is off (PANTA_TRADING_ENABLED=false) or the server has no API key. */
const tradingOn: Middleware = (_req, _res, next) => {
  const { service, config } = getPantaServices();
  if (service.tradingEnabled) return next();
  next(
    config.PANTA_API_KEY
      ? new ServiceUnavailableException('Real-money trading is switched off right now', 'PANTA_TRADING_DISABLED')
      : new ServiceUnavailableException('Real-money Predict is not configured on this server', 'PANTA_NOT_CONFIGURED'),
  );
};

/** Visitors from PANTA_BLOCKED_COUNTRIES (per the trusted proxy's geo header) may browse but not trade: 403. */
const geoGate: Middleware = (req, _res, next) => {
  const { config } = getPantaServices();
  const country = countryOf(req.headers, config.PANTA_GEO_HEADERS);
  if (!isGeoBlocked(country, config.PANTA_BLOCKED_COUNTRIES)) return next();
  next(new EpochException('Real-money trading is not available in your region', 'PANTA_GEO_BLOCKED', 403, { country }));
};

const readLimit = limit((l) => l.read, 'ip', 'Too many requests, try again shortly');
const tradeIpLimit = limit((l) => l.trade, 'ip', 'Too many trades from your network; wait a minute');

/**
 * /v1/predict/panta: real money (USDC via Panta on Solana mainnet). Who needs what, and why:
 * - Reads (markets, a market, categories, positions, stats, a trade's status) are public and rate-limited per IP:
 *   they show public chain and catalog data, and the page must work before a wallet connects.
 * - quote is public too (a price preview, nothing to sign), limited per IP: Panta allows only 30 quotes a minute
 *   for the whole app.
 * - build, submit and claim/build need the SIWS session of the very wallet that trades (401 / 403 WALLET_MISMATCH),
 *   plus `consent: true` on builds. A build spends Panta's scarcest budget (20 a minute for the whole app), so it is
 *   tied to a wallet that proved ownership and limited per wallet as well as per IP; and every attributed trade is then
 *   linked to a signed-in Epoch wallet (the traction record). Points-mode players are signed in already.
 * Trading routes answer 503 when trading is off and 403 PANTA_GEO_BLOCKED from blocked countries.
 */
export const pantaRouter: HttpRouter = createRouter()
  .get('/markets', readLimit, validate(PantaMarketsQueryDto, 'query'), handle(PantaController.markets))
  .get('/markets/:marketId', readLimit, validate(PantaMarketParamsDto, 'params'), handle(PantaController.market))
  .get('/categories', readLimit, handle(PantaController.categories))
  .get('/positions', readLimit, validate(PantaPositionsQueryDto, 'query'), handle(PantaController.positions))
  .get('/stats', readLimit, handle(PantaController.stats))
  .get('/status/:tradeId', readLimit, validate(PantaTradeParamsDto, 'params'), handle(PantaController.status))
  .post(
    '/quote',
    tradingOn,
    geoGate,
    limit((l) => l.quote, 'ip', 'Too many quotes from your network; wait a minute'),
    validate(PantaQuoteDto),
    handle(PantaController.quote),
  )
  .post(
    '/build',
    tradingOn,
    geoGate,
    tradeIpLimit,
    limit((l) => l.build, 'wallet', 'Too many orders from this wallet; wait a minute'),
    validate(PantaBuildDto),
    handle(PantaController.build),
  )
  .post(
    '/submit',
    tradingOn,
    geoGate,
    tradeIpLimit,
    limit((l) => l.submit, 'wallet', 'Too many submissions from this wallet; wait a minute'),
    validate(PantaSubmitDto),
    handle(PantaController.submit),
  )
  .post(
    '/claim/build',
    tradingOn,
    geoGate,
    tradeIpLimit,
    limit((l) => l.build, 'wallet', 'Too many claims from this wallet; wait a minute'),
    validate(PantaClaimDto),
    handle(PantaController.claim),
  );

/** /v1/index/epochs/:epoch: the resolution source of Epoch's Panta markets. Public. */
export const feeIndexEpochRouter: HttpRouter = createRouter().get(
  '/:epoch',
  validate(FeeIndexEpochParamsDto, 'params'),
  handle(FeeIndexEpochController.get),
);
