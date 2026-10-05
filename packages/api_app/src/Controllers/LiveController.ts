import type { Request, Response } from '@epoch/common_http_server';

import type { LiveEpochParams, LiveLeadersQuery, LiveSlotsQuery } from '../dto/Live.dto';
import { getLiveService } from '../Services/Live';
import type { FeeDistribution, LiveLeaders, LiveSlots, LiveSummary, SolamiUsageResponse } from '../types/Live.types';

/** The Live page (Solami Track): the Solana Fee Index computed live from mainnet blocks. See docs/pages/live.md. */
export class LiveController {
  /** GET /v1/live/summary: tip, processed slot, lag, epoch progress, running estimate, last final value, health. */
  static async summary(_req: Request, res: Response): Promise<LiveSummary> {
    res.setHeader('cache-control', 'no-store');
    return getLiveService().summary();
  }

  /** GET /v1/live/slots?limit= — the newest blocks, newest first (default 60, at most 500). */
  static async slots(_req: Request, res: Response): Promise<LiveSlots> {
    const { limit } = res.locals.query as LiveSlotsQuery;
    res.setHeader('cache-control', 'no-store');
    return getLiveService().slots(limit);
  }

  /** GET /v1/live/leaders?epoch=&limit= — per-leader medians, slots, stake and rank (default: the epoch in progress). */
  static async leaders(_req: Request, res: Response): Promise<LiveLeaders> {
    const { epoch, limit } = res.locals.query as LiveLeadersQuery;
    res.setHeader('cache-control', 'public, max-age=5');
    return getLiveService().leaders(epoch, limit);
  }

  /** GET /v1/live/solami — what Epoch uses of Solami, per component: gRPC, RPC (p50/p95), Beam, the last error. */
  static async solami(_req: Request, res: Response): Promise<SolamiUsageResponse> {
    res.setHeader('cache-control', 'no-store');
    return getLiveService().solami();
  }

  /** GET /v1/live/epochs/:epoch/distribution — histogram and percentiles of the epoch's slot medians. */
  static async distribution(_req: Request, res: Response): Promise<FeeDistribution> {
    const { epoch } = res.locals.params as LiveEpochParams;
    res.setHeader('cache-control', 'public, max-age=5');
    return getLiveService().distribution(epoch);
  }
}
