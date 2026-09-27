import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { FeeIndexController } from '../Controllers/FeeIndexController';
import { FeeIndexQueryDto } from '../dto/FeeIndexQuery.dto';

export const feeIndexRouter: HttpRouter = createRouter().get(
  '/',
  validate(FeeIndexQueryDto, 'query'),
  handle(FeeIndexController.list),
);
