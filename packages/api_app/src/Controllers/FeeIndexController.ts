import type { Request, Response } from '@epoch/common_http_server';

import type { FeeIndexQuery } from '../dto/FeeIndexQuery.dto';
import { getLatestFinalReader, latestFinal } from '../Services/Program/FeeIndexLatestFinal';
import { getProgramEventServices } from '../Services/Program/ProgramEventServices';
import type { FeeIndexLatestFinal, FeeIndexPoint } from '../types/Activity.types';

export class FeeIndexController {
  /**
   * GET /v1/index?from=&to=&limit= — the Solana Fee Index per epoch, newest first, with the program's `status`
   * (final, proposed, vetoed; request #3). Epochs only the indexer computed carry no status.
   */
  static async list(_req: Request, res: Response): Promise<FeeIndexPoint[]> {
    const query = res.locals.query as FeeIndexQuery;
    const points = await getProgramEventServices().feeIndex.points(query);
    res.setHeader('cache-control', 'public, max-age=15');
    return points;
  }

  /**
   * GET /v1/index/latest-final — the newest final value straight from the FeeIndex account (epoch, value, finalize
   * slot, inputs hash, the account's address): the provider-neutral read for off-chain consumers.
   */
  static async latestFinal(_req: Request, res: Response): Promise<FeeIndexLatestFinal> {
    const view = await latestFinal(getLatestFinalReader());
    res.setHeader('cache-control', 'public, max-age=15');
    return view;
  }
}
