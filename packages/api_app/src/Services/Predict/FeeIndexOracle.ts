import { type FeeIndexAccount, feeIndexValueFor } from '@epoch/epoch-sdk';
import { EpochException, ServiceUnavailableException } from '@epoch/exceptions';
import { epochIndex, type EpochDb } from '@epoch/pg_models';
import { desc, eq } from 'drizzle-orm';

import { type EpochProgramSource } from '../../Sources/EpochProgramSource';
import { type MarketData } from '../MarketData';

/** A final Fee Index value (µL/CU) and the epoch it answers. */
export interface IndexValue {
  epoch: number;
  value: number;
}

/**
 * Where Predict reads "index epochs" and Fee Index values. One small interface so the source can be swapped when the
 * epoch numbering is reconciled (the program cluster's epochs vs mainnet's).
 */
export interface FeeIndexOracle {
  /** Which epochs the markets count in (shown in the snapshot note). */
  readonly epochSource: string;
  /** The current index epoch: calls close when a market's epoch starts. */
  currentEpoch(): Promise<number>;
  /** The newest final value, or null before the first one. New markets use it for their threshold. */
  latestFinal(): Promise<IndexValue | null>;
  /** The final value of `epoch` (after its dispute window), or null when not final (yet, or vetoed). */
  finalValue(epoch: number): Promise<number | null>;
  /** The value proposed for `epoch` and still in its dispute window, or null. */
  proposedValue(epoch: number): Promise<number | null>;
}

const asEpochError = (error: unknown): EpochException =>
  error instanceof EpochException
    ? error
    : new ServiceUnavailableException('The index epoch is unavailable right now', 'INDEX_EPOCH_UNAVAILABLE', {
        error: String(error),
      });

/**
 * The live oracle. With the Epoch program configured (EPOCH_PROGRAM_ID): the program cluster's epoch and the FeeIndex
 * account (its final value plus the 16-epoch history, `feeIndexValueFor`). Without it: the mainnet epoch, and final
 * values from the indexer's epoch_index table only when PREDICT_RESOLVE_FROM_DB=true (otherwise none, so no market is
 * opened or settled).
 */
export class LiveFeeIndexOracle implements FeeIndexOracle {
  constructor(
    private readonly program: EpochProgramSource,
    private readonly market: MarketData,
    private readonly db: () => EpochDb,
    private readonly resolveFromDb: boolean,
  ) {}

  get epochSource(): string {
    return this.program.configured ? `the Epoch program's cluster (${this.program.cluster})` : 'mainnet';
  }

  async currentEpoch(): Promise<number> {
    try {
      return this.program.configured
        ? (await this.program.epochInfo()).epoch
        : (await this.market.epochInfo.get()).epoch;
    } catch (error) {
      throw asEpochError(error);
    }
  }

  async latestFinal(): Promise<IndexValue | null> {
    if (this.program.configured) {
      const index = await this.feeIndex();
      if (!index || index.finalizedSlot === 0n) return null;
      return { epoch: Number(index.epoch), value: Number(index.value) };
    }
    if (!this.resolveFromDb) return null;
    const [row] = await this.db().select().from(epochIndex).orderBy(desc(epochIndex.epoch)).limit(1);
    return row ? { epoch: row.epoch, value: row.value } : null;
  }

  async finalValue(epoch: number): Promise<number | null> {
    if (this.program.configured) {
      const index = await this.feeIndex();
      const value = index ? feeIndexValueFor(index, BigInt(epoch)) : null;
      return value === null ? null : Number(value);
    }
    if (!this.resolveFromDb) return null;
    const [row] = await this.db().select().from(epochIndex).where(eq(epochIndex.epoch, epoch));
    return row ? row.value : null;
  }

  async proposedValue(epoch: number): Promise<number | null> {
    if (!this.program.configured) return null;
    const index = await this.feeIndex();
    return index && index.hasProposal && index.proposedEpoch === BigInt(epoch) ? Number(index.proposedValue) : null;
  }

  private async feeIndex(): Promise<FeeIndexAccount | null> {
    return (await this.program.feeIndex())?.account ?? null;
  }
}
