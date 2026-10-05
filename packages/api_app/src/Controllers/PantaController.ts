import { type Request, type Response } from '@epoch/common_http_server';

import { currentSession } from '../Lib/Session';
import {
  type FeeIndexEpochParams,
  type PantaBuildBody,
  type PantaClaimBody,
  type PantaMarketParams,
  type PantaMarketsQuery,
  type PantaPositionsQuery,
  type PantaQuoteBody,
  type PantaSubmitBody,
  type PantaTradeParams,
} from '../dto/Panta.dto';
import { getPantaServices } from '../Services/Panta';
import { type RequestContext } from '../Services/Panta/PantaService';
import { countryOf } from '../Services/Panta/PantaSupport';
import { getFeeIndexEpochService } from '../Services/Program/FeeIndexEpochService';
import {
  type FeeIndexEpochView,
  type PantaBuildView,
  type PantaCategoriesView,
  type PantaMarketDetail,
  type PantaMarketsPage,
  type PantaPositionsView,
  type PantaQuoteView,
  type PantaStatsView,
  type PantaSubmitView,
  type PantaTradeStatusView,
} from '../types/Panta.types';

/** The visitor's country (trusted proxy header) and SIWS session. */
function context(req: Request, res: Response): RequestContext {
  const { config } = getPantaServices();
  return { country: countryOf(req.headers, config.PANTA_GEO_HEADERS), session: currentSession(res) };
}

/**
 * Real-money Predict through Panta (USDC on Solana mainnet; decision of 3 Oct 2026). Reads are public; build, submit
 * and claims need the trading wallet's sign-in session and `consent: true`. Panta's API key never leaves the server.
 */
export class PantaController {
  /** GET /v1/predict/panta/markets */
  static async markets(req: Request, res: Response): Promise<PantaMarketsPage> {
    res.setHeader('cache-control', 'private, max-age=5');
    return getPantaServices().service.marketsPage(res.locals.query as PantaMarketsQuery, context(req, res));
  }

  /** GET /v1/predict/panta/markets/:marketId */
  static async market(req: Request, res: Response): Promise<PantaMarketDetail> {
    res.setHeader('cache-control', 'private, max-age=5');
    const { marketId } = res.locals.params as PantaMarketParams;
    return getPantaServices().service.marketDetail(marketId, context(req, res));
  }

  /** GET /v1/predict/panta/categories */
  static async categories(_req: Request, res: Response): Promise<PantaCategoriesView> {
    res.setHeader('cache-control', 'public, max-age=300');
    return getPantaServices().service.categories();
  }

  /** GET /v1/predict/panta/positions?wallet= */
  static async positions(_req: Request, res: Response): Promise<PantaPositionsView> {
    res.setHeader('cache-control', 'private, no-store');
    const { wallet } = res.locals.query as PantaPositionsQuery;
    return getPantaServices().service.positions(wallet);
  }

  /** GET /v1/predict/panta/stats */
  static async stats(_req: Request, res: Response): Promise<PantaStatsView> {
    res.setHeader('cache-control', 'public, max-age=30');
    return getPantaServices().service.stats();
  }

  /** POST /v1/predict/panta/quote */
  static async quote(req: Request, res: Response): Promise<PantaQuoteView> {
    res.setHeader('cache-control', 'no-store');
    return getPantaServices().service.quote(res.locals.body as PantaQuoteBody, context(req, res));
  }

  /** POST /v1/predict/panta/build */
  static async build(req: Request, res: Response): Promise<PantaBuildView> {
    res.setHeader('cache-control', 'no-store');
    return getPantaServices().service.build(res.locals.body as PantaBuildBody, context(req, res));
  }

  /** POST /v1/predict/panta/submit */
  static async submit(req: Request, res: Response): Promise<PantaSubmitView> {
    res.setHeader('cache-control', 'no-store');
    return getPantaServices().service.submit(res.locals.body as PantaSubmitBody, context(req, res));
  }

  /** GET /v1/predict/panta/status/:tradeId */
  static async status(_req: Request, res: Response): Promise<PantaTradeStatusView> {
    res.setHeader('cache-control', 'no-store');
    const { tradeId } = res.locals.params as PantaTradeParams;
    return getPantaServices().service.status(tradeId);
  }

  /** POST /v1/predict/panta/claim/build */
  static async claim(req: Request, res: Response): Promise<PantaBuildView> {
    res.setHeader('cache-control', 'no-store');
    return getPantaServices().service.claimBuild(res.locals.body as PantaClaimBody, context(req, res));
  }
}

export class FeeIndexEpochController {
  /** GET /v1/index/epochs/:epoch: one mainnet epoch's Fee Index and status (Epoch's Panta markets resolve from it). */
  static async get(_req: Request, res: Response): Promise<FeeIndexEpochView> {
    const { epoch } = res.locals.params as FeeIndexEpochParams;
    const view = await getFeeIndexEpochService().epoch(epoch);
    res.setHeader('cache-control', view.final ? 'public, max-age=300' : 'public, max-age=15');
    return view;
  }
}
