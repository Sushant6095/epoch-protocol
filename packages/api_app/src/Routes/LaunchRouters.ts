import { createRouter, handle, type HttpRouter, validate } from '@epoch/common_http_server';

import { LaunchController } from '../Controllers/LaunchController';
import { LaunchParamsDto } from '../dto/Launch.dto';

export const launchRouter: HttpRouter = createRouter()
  .get('/', handle(LaunchController.list))
  .get('/:mint', validate(LaunchParamsDto, 'params'), handle(LaunchController.detail));
