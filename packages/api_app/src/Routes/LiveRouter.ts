import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { LiveController } from '../Controllers/LiveController';
import { LiveEpochParamsDto, LiveLeadersQueryDto, LiveSlotsQueryDto } from '../dto/Live.dto';

/** /v1/live: the Solana Fee Index streamed live from mainnet through Solami (indexer_app → Postgres). */
export const liveRouter: HttpRouter = createRouter()
  .get('/summary', handle(LiveController.summary))
  .get('/slots', validate(LiveSlotsQueryDto, 'query'), handle(LiveController.slots))
  .get('/leaders', validate(LiveLeadersQueryDto, 'query'), handle(LiveController.leaders))
  .get('/epochs/:epoch/distribution', validate(LiveEpochParamsDto, 'params'), handle(LiveController.distribution))
  .get('/solami', handle(LiveController.solami));
