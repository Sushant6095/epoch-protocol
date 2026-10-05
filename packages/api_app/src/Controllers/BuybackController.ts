import type { Request, Response } from '@epoch/common_http_server';

import type { BuybackParams } from '../dto/Buyback.dto';
import { getBuybackFeed } from '../Services/Launch/BuybackFeedService';
import type { LaunchBuybackFeed } from '../types/Buyback.types';

/** A revenue token's buybacks (request #22, ADR 0006). Public; read from the program's cluster. */
export class BuybackController {
  /** GET /v1/launches/:mint/buybacks */
  static async list(_req: Request, res: Response): Promise<LaunchBuybackFeed> {
    const { mint } = res.locals.params as BuybackParams;
    res.setHeader('cache-control', 'public, max-age=30');
    return getBuybackFeed().get(mint);
  }
}
