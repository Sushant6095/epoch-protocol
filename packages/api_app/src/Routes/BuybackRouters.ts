import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { BuybackController } from '../Controllers/BuybackController';
import { BuybackParamsDto } from '../dto/Buyback.dto';

/** Mounted at `/v1/launches` next to the launch router: `/:mint/buybacks` (one segment deeper than `/:mint`). */
export const buybackRouter: HttpRouter = createRouter().get(
  '/:mint/buybacks',
  validate(BuybackParamsDto, 'params'),
  handle(BuybackController.list),
);
