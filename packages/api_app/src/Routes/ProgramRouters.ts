import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { ProgramController } from '../Controllers/ProgramController';
import { AddressParamsDto, VoteParamsDto } from '../dto/Program.dto';

/** Mounted at /v1/vault. */
export const vaultRouter: HttpRouter = createRouter().get('/', handle(ProgramController.vault));

/** Mounted at /v1/validators next to validatorsRouter (`/` and `/:vote` there); Express falls through between them. */
export const validatorPositionRouter: HttpRouter = createRouter().get(
  '/:vote/position',
  validate(VoteParamsDto, 'params'),
  handle(ProgramController.position),
);

/** Mounted at /v1/wallets; `/:address/stake` lives on its own router. */
export const lenderRouter: HttpRouter = createRouter().get(
  '/:address/lender',
  validate(AddressParamsDto, 'params'),
  handle(ProgramController.lender),
);

/** Mounted at /v1/market. */
export const marketRouter: HttpRouter = createRouter().get('/', handle(ProgramController.market));
