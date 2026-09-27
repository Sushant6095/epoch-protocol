import type { Request } from '@epoch/common_http_server';

export class HealthController {
  static async status(_req: Request): Promise<{ status: string; time: string }> {
    return { status: 'ok', time: new Date().toISOString() };
  }
}
