import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { WalletController } from '../Controllers/WalletController';
import { WalletParamsDto } from '../dto/Wallet.dto';

/** Mounted at /v1/wallets. `/:address/lender` (request #8d) lives on its own router at the same path. */
export const walletStakeRouter: HttpRouter = createRouter().get(
  '/:address/stake',
  validate(WalletParamsDto, 'params'),
  handle(WalletController.stake),
);
