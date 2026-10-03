import { type EpochDb, validatorEpochStats } from '@epoch/pg_models';
import { gte, sql } from 'drizzle-orm';

import { type ValidatorEpochStat } from './ValidatorHistory';

/** Where validator history lives: `validator_epoch_stats` in Postgres (or memory, in tests). */
export interface ValidatorHistoryStore {
  /** Upserts by (vote, epoch); a field that is null or missing keeps the stored value. */
  upsert(rows: readonly ValidatorEpochStat[]): Promise<void>;
  /** Every row from `sinceEpoch` on. */
  load(sinceEpoch: number): Promise<ValidatorEpochStat[]>;
}

const FIELDS = ['commissionBps', 'mevCommissionBps', 'activeStakeLamports', 'credits'] as const;
const key = (row: Pick<ValidatorEpochStat, 'vote' | 'epoch'>): string => `${row.vote}:${row.epoch}`;

/** Folds rows for the same (vote, epoch) into one; later non-null fields win. */
export function mergeStats(
  rows: readonly ValidatorEpochStat[],
  into = new Map<string, ValidatorEpochStat>(),
): Map<string, ValidatorEpochStat> {
  for (const row of rows) {
    const merged: ValidatorEpochStat = { ...(into.get(key(row)) ?? { vote: row.vote, epoch: row.epoch }) };
    for (const field of FIELDS) {
      const value = row[field];
      if (value !== null && value !== undefined) Object.assign(merged, { [field]: value });
    }
    into.set(key(row), merged);
  }
  return into;
}

export class MemoryValidatorHistoryStore implements ValidatorHistoryStore {
  private readonly rows = new Map<string, ValidatorEpochStat>();

  async upsert(rows: readonly ValidatorEpochStat[]): Promise<void> {
    mergeStats(rows, this.rows);
  }

  async load(sinceEpoch: number): Promise<ValidatorEpochStat[]> {
    return [...this.rows.values()].filter((row) => row.epoch >= sinceEpoch).map((row) => ({ ...row }));
  }
}

/** validator_epoch_stats in Postgres. */
export class PgValidatorHistoryStore implements ValidatorHistoryStore {
  constructor(private readonly db: EpochDb) {}

  async upsert(rows: readonly ValidatorEpochStat[]): Promise<void> {
    const t = validatorEpochStats;
    // One statement may not touch a row twice, so rows for the same (vote, epoch) are merged first.
    const unique = [...mergeStats(rows).values()];
    // 500 rows × 6 parameters stays far under Postgres' parameter limit.
    for (let start = 0; start < unique.length; start += 500) {
      const chunk = unique.slice(start, start + 500);
      await this.db
        .insert(t)
        .values(
          chunk.map((row) => ({
            vote: row.vote,
            epoch: row.epoch,
            commissionBps: row.commissionBps ?? null,
            mevCommissionBps: row.mevCommissionBps ?? null,
            activeStakeLamports: row.activeStakeLamports ?? null,
            credits: row.credits ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [t.vote, t.epoch],
          set: {
            commissionBps: sql`coalesce(excluded.commission_bps, ${t.commissionBps})`,
            mevCommissionBps: sql`coalesce(excluded.mev_commission_bps, ${t.mevCommissionBps})`,
            activeStakeLamports: sql`coalesce(excluded.active_stake_lamports, ${t.activeStakeLamports})`,
            credits: sql`coalesce(excluded.credits, ${t.credits})`,
            recordedAt: sql`now()`,
          },
        });
    }
  }

  async load(sinceEpoch: number): Promise<ValidatorEpochStat[]> {
    const t = validatorEpochStats;
    const rows = await this.db.select().from(t).where(gte(t.epoch, sinceEpoch));
    return rows.map((row) => ({
      vote: row.vote,
      epoch: row.epoch,
      commissionBps: row.commissionBps,
      mevCommissionBps: row.mevCommissionBps,
      activeStakeLamports: row.activeStakeLamports,
      credits: row.credits,
    }));
  }
}
