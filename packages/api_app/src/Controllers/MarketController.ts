import type { Request, Response } from '@epoch/common_http_server';

import type { DelegatorQuery, StakeHistoryQuery, ValidatorListQuery } from '../dto/MarketQuery.dto';
import { getServices } from '../Services';
import { decodeCursor, queryValidators } from '../Services/ValidatorQuery';
import type {
  BiggestDelegators,
  NetworkSnapshot,
  RetailMagnets,
  StakeHistory,
  ValidatorList,
} from '../types/Api.types';

/** Public mainnet data: the network, the validator table and who delegates. No sign-in. */
export class MarketController {
  /** GET /v1/network */
  static async network(_req: Request, res: Response): Promise<NetworkSnapshot> {
    res.setHeader('cache-control', 'public, max-age=15');
    return getServices().network.snapshot();
  }

  /** GET /v1/network/stake-history?epochs=64 */
  static async stakeHistory(_req: Request, res: Response): Promise<StakeHistory> {
    const { epochs } = res.locals.query as StakeHistoryQuery;
    res.setHeader('cache-control', 'public, max-age=300');
    return getServices().network.stakeHistory(epochs);
  }

  /** GET /v1/validators?tab=&chips=&q=&sort=&dir=&fee=&client=&country=&votes=&cursor=&limit= */
  static async validators(_req: Request, res: Response): Promise<ValidatorList> {
    const q = res.locals.query as ValidatorListQuery;
    const table = await getServices().validators.get();
    const page = queryValidators(table.rows, {
      tab: q.tab,
      chips: q.chips,
      q: q.q,
      sort: q.sort,
      dir: q.dir,
      fee: q.fee,
      clients: q.client,
      countries: q.country,
      votes: q.votes,
      offset: decodeCursor(q.cursor),
      limit: q.limit,
    });
    res.setHeader('cache-control', 'public, max-age=30');
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: table.asOf,
      source: table.sources.join(', '),
      ...page,
    };
  }

  /** GET /v1/delegators/biggest?limit=10 */
  static async biggestDelegators(_req: Request, res: Response): Promise<BiggestDelegators> {
    const { limit } = res.locals.query as DelegatorQuery;
    res.setHeader('cache-control', 'public, max-age=300');
    return getServices().delegators.biggest(limit);
  }

  /** GET /v1/delegators/retail-magnets?limit=10 */
  static async retailMagnets(_req: Request, res: Response): Promise<RetailMagnets> {
    const { limit } = res.locals.query as DelegatorQuery;
    res.setHeader('cache-control', 'public, max-age=300');
    return getServices().delegators.retailMagnets(limit);
  }
}
