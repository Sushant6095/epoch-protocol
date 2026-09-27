import { epochIndex, PostgresConnectionManager } from '@epoch/pg_models';
import { and, desc, gte, lte } from 'drizzle-orm';
import type { Request, Response } from '@epoch/common_http_server';

import type { FeeIndexQuery } from '../dto/FeeIndexQuery.dto';
import type { FeeIndexPoint } from '../types/Api.types';

export class FeeIndexController {
  /** GET /v1/index?from=&to=&limit= — settled Solana Fee Index values, newest first. */
  static async list(_req: Request, res: Response): Promise<FeeIndexPoint[]> {
    const { from, to, limit } = res.locals.query as FeeIndexQuery;
    const db = PostgresConnectionManager.getDb();
    const conditions = [
      from !== undefined ? gte(epochIndex.epoch, from) : undefined,
      to !== undefined ? lte(epochIndex.epoch, to) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(epochIndex)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(epochIndex.epoch))
      .limit(limit);
    return rows.map((row) => ({ epoch: row.epoch, value: row.value }));
  }
}
