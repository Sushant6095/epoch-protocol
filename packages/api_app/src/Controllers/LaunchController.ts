import type { Request, Response } from '@epoch/common_http_server';

import type { LaunchParams } from '../dto/Launch.dto';
import { getLaunchServices } from '../Services/Launch';
import type { LaunchDetail, LaunchList } from '../types/Launch.types';

/** Validator revenue tokens on Meteora (request #22). Public, devnet for now (decision 6). */
export class LaunchController {
  /** GET /v1/launches */
  static async list(_req: Request, res: Response): Promise<LaunchList> {
    res.setHeader('cache-control', 'public, max-age=60');
    return getLaunchServices().launches.list();
  }

  /** GET /v1/launches/:mint (a mint, or a symbol such as rKEST) */
  static async detail(_req: Request, res: Response): Promise<LaunchDetail> {
    const { mint } = res.locals.params as LaunchParams;
    res.setHeader('cache-control', 'public, max-age=60');
    return getLaunchServices().launches.detail(mint);
  }
}
