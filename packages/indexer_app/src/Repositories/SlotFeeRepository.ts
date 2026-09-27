import { PostgresConnectionManager, slotFees } from '@epoch/pg_models';

export interface SlotFeeRow {
  slot: number;
  epoch: number;
  leader: string;
  medianCuPrice: number;
  txCount: number;
}

export class SlotFeeRepository {
  static async upsert(rows: SlotFeeRow[]): Promise<void> {
    if (rows.length === 0) return;
    await PostgresConnectionManager.getDb().insert(slotFees).values(rows).onConflictDoNothing();
  }
}
