import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { MarketController } from '../Controllers/MarketController';
import { ValidatorProfileController } from '../Controllers/ValidatorProfileController';
import { DelegatorQueryDto, StakeHistoryQueryDto, ValidatorListQueryDto } from '../dto/MarketQuery.dto';
import { VoteParamsDto } from '../dto/Wallet.dto';

export const networkRouter: HttpRouter = createRouter()
  .get('/', handle(MarketController.network))
  .get('/stake-history', validate(StakeHistoryQueryDto, 'query'), handle(MarketController.stakeHistory));

export const validatorsRouter: HttpRouter = createRouter()
  .get('/', validate(ValidatorListQueryDto, 'query'), handle(MarketController.validators))
  // One validator's profile (request #5).
  .get('/:vote', validate(VoteParamsDto, 'params'), handle(ValidatorProfileController.profile));

export const delegatorsRouter: HttpRouter = createRouter()
  .get('/biggest', validate(DelegatorQueryDto, 'query'), handle(MarketController.biggestDelegators))
  .get('/retail-magnets', validate(DelegatorQueryDto, 'query'), handle(MarketController.retailMagnets));
