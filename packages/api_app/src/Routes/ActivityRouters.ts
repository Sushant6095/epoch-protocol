import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { ActivityController } from '../Controllers/ActivityController';
import { ActivityQueryDto } from '../dto/Activity.dto';

/** /v1/activity. The Fee Index (/v1/index) keeps its own router (FeeIndexRouter.ts). */
export const activityRouter: HttpRouter = createRouter().get(
  '/',
  validate(ActivityQueryDto, 'query'),
  handle(ActivityController.list),
);
