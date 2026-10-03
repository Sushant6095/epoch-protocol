import type { Request, Response } from '@epoch/common_http_server';

import type { ActivityQuery } from '../dto/Activity.dto';
import { getProgramEventServices } from '../Services/Program/ProgramEventServices';
import type { ActivityFeed } from '../types/Activity.types';

/** The Terminal's live activity (request #4): first paint over REST, then WS /v1/stream channel `activity`. */
export class ActivityController {
  /** GET /v1/activity?limit=50 — program events and Predict calls, newest first. */
  static async list(_req: Request, res: Response): Promise<ActivityFeed> {
    const { limit } = res.locals.query as ActivityQuery;
    const feed = await getProgramEventServices().activity.feed(limit);
    res.setHeader('cache-control', 'public, max-age=5');
    return feed;
  }
}
