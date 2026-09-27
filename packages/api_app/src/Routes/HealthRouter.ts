import { createRouter, handle, type HttpRouter } from '@epoch/common_http_server';

import { HealthController } from '../Controllers/HealthController';

export const healthRouter: HttpRouter = createRouter().get('/', handle(HealthController.status));
