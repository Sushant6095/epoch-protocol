import { type EpochDb, epochIndex, slotFees } from '@epoch/pg_models';
import { and, asc, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';

import { InputsHasher } from '../Index/InputsHash';

/** One `epoch_index` row: a finished MAINNET epoch's Fee Index value. */
export interface EpochIndexRow {
  epoch: number;
  value: number;
  postedSignature: string | null;
}

/** What the index publisher needs from Postgres. */
export interface IndexStore {
  /** The posted row with the highest epoch; null before the first post. */
  latestPosted(): Promise<EpochIndexRow | null>;
  /** Rows not posted yet with `epoch > after` (every unposted row when null), oldest first. */
  unposted(after: number | null): Promise<EpochIndexRow[]>;
  /** Records a post_index signature on a row that has none. False when the row was already marked (or is missing). */
  markPosted(epoch: number, signature: string): Promise<boolean>;
  /** The epoch's canonical inputs hash over its slot_fees rows, and how many slots went in. */
  inputsHash(epoch: number): Promise<{ hash: Uint8Array; slots: number }>;
}

/** slot_fees rows per query while hashing an epoch (an epoch has up to 432,000). */
const SLOT_PAGE = 20_000;
const UNPOSTED_LIMIT = 1_000;

export class PgIndexStore implements IndexStore {
  constructor(private readonly db: EpochDb) {}

  async latestPosted(): Promise<EpochIndexRow | null> {
    const rows = await this.db
      .select()
      .from(epochIndex)
      .where(isNotNull(epochIndex.postedSignature))
      .orderBy(desc(epochIndex.epoch))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async unposted(after: number | null): Promise<EpochIndexRow[]> {
    const rows = await this.db
      .select()
      .from(epochIndex)
      .where(
        after === null
          ? isNull(epochIndex.postedSignature)
          : and(isNull(epochIndex.postedSignature), gt(epochIndex.epoch, after)),
      )
      .orderBy(asc(epochIndex.epoch))
      .limit(UNPOSTED_LIMIT);
    return rows.map(toRow);
  }

  async markPosted(epoch: number, signature: string): Promise<boolean> {
    const updated = await this.db
      .update(epochIndex)
      .set({ postedSignature: signature })
      .where(and(eq(epochIndex.epoch, epoch), isNull(epochIndex.postedSignature)))
      .returning({ epoch: epochIndex.epoch });
    return updated.length > 0;
  }

  async inputsHash(epoch: number): Promise<{ hash: Uint8Array; slots: number }> {
    const hasher = new InputsHasher(epoch);
    let after = -1;
    for (;;) {
      const page = await this.db
        .select({
          slot: slotFees.slot,
          leader: slotFees.leader,
          medianCuPrice: slotFees.medianCuPrice,
          txCount: slotFees.txCount,
        })
        .from(slotFees)
        .where(and(eq(slotFees.epoch, epoch), gt(slotFees.slot, after)))
        .orderBy(asc(slotFees.slot))
        .limit(SLOT_PAGE);
      if (page.length === 0) break;
      hasher.update(page);
      after = page[page.length - 1].slot;
      if (page.length < SLOT_PAGE) break;
    }
    return hasher.digest();
  }
}

const toRow = (row: typeof epochIndex.$inferSelect): EpochIndexRow => ({
  epoch: row.epoch,
  value: row.value,
  postedSignature: row.postedSignature,
});
