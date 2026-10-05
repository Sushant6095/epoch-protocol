import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { IndiaController } from '../Controllers/IndiaController';
import { IndiaPriceQueryDto, IndiaRewardsQueryDto, IndiaValidatorQueryDto } from '../dto/India.dto';
import { WalletParamsDto } from '../dto/Wallet.dto';

/** Mounted at /v1/india: the Superteam India track page (docs/pages/india.md). Public mainnet data, no sign-in. */
export const indiaRouter: HttpRouter = createRouter()
  .get('/summary', handle(IndiaController.summary))
  .get('/price', validate(IndiaPriceQueryDto, 'query'), handle(IndiaController.price))
  .get('/validators', validate(IndiaValidatorQueryDto, 'query'), handle(IndiaController.validators))
  .get(
    '/wallets/:address/rewards',
    validate(WalletParamsDto, 'params'),
    validate(IndiaRewardsQueryDto, 'query'),
    handle(IndiaController.rewards),
  )
  .get(
    '/wallets/:address/rewards.csv',
    validate(WalletParamsDto, 'params'),
    validate(IndiaRewardsQueryDto, 'query'),
    handle(IndiaController.rewardsCsv),
  );
