import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { FeeIndexController } from '../Controllers/FeeIndexController';
import { FeeIndexForecastController } from '../Controllers/PantaController';
import { FeeIndexQueryDto } from '../dto/FeeIndexQuery.dto';

export const feeIndexRouter: HttpRouter = createRouter()
  .get('/', validate(FeeIndexQueryDto, 'query'), handle(FeeIndexController.list))
  // The crowd's forecast of the next epoch's index from Epoch's Panta markets (the Terminal's Fee Index card).
  .get('/forecast', handle(FeeIndexForecastController.get));
