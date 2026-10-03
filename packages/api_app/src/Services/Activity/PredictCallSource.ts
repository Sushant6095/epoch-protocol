import { type EpochDb, predictCalls, predictMarkets } from '@epoch/pg_models';
import { desc, eq } from 'drizzle-orm';

import { type PredictCallEvent } from '../../Lib/EventBus';

/** Recent Predict calls (points mode, request #11), newest first. */
export interface PredictCallSource {
  recent(limit: number): Promise<PredictCallEvent[]>;
}

/** predict_calls joined with predict_markets for the label. */
export class PgPredictCallSource implements PredictCallSource {
  constructor(private readonly db: EpochDb) {}

  async recent(limit: number): Promise<PredictCallEvent[]> {
    const rows = await this.db
      .select({
        id: predictCalls.id,
        marketId: predictCalls.marketId,
        address: predictCalls.address,
        side: predictCalls.side,
        points: predictCalls.points,
        createdAt: predictCalls.createdAt,
        label: predictMarkets.label,
      })
      .from(predictCalls)
      .leftJoin(predictMarkets, eq(predictMarkets.id, predictCalls.marketId))
      .orderBy(desc(predictCalls.createdAt), desc(predictCalls.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      marketId: row.marketId,
      label: row.label ?? row.marketId,
      address: row.address,
      side: row.side.toLowerCase() === 'no' ? 'no' : 'yes',
      points: row.points,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
