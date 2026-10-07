import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { FeeIndexController } from '../Controllers/FeeIndexController';
import { FeeIndexForecastController } from '../Controllers/PantaController';
import { FeeIndexQueryDto } from '../dto/FeeIndexQuery.dto';

export const feeIndexRouter: HttpRouter = createRouter()
  .get('/', validate(FeeIndexQueryDto, 'query'), handle(FeeIndexController.list))
  // The newest final value from the FeeIndex account: the provider-neutral read (no Switchboard mirror, plan F9).
  .get('/latest-final', handle(FeeIndexController.latestFinal))
  // The crowd's forecast of the next epoch's index from Epoch's Panta markets (the Terminal's Fee Index card).
  .get('/forecast', handle(FeeIndexForecastController.get));
