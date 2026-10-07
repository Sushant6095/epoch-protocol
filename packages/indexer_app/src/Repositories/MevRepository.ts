import { type EpochDb, validatorMevEpochs } from '@epoch/pg_models';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

/** One validator_mev_epochs row as the MEV scan writes it. */
export type MevEpochRow = Omit<typeof validatorMevEpochs.$inferInsert, 'scannedAt'>;

/** A validator commission node already known claimed (its ClaimStatus is not read again). */
export interface KnownClaim {
  amount: bigint;
  slot: number | null;
}

/** What the MEV scan reads and writes (Postgres in production, memory in tests). */
export interface MevRepository {
  /**
   * Epochs among `epochs` that need no further reads: every TDA's and PFDA's root is uploaded and no validator node is
   * still pending (claimed, expired or 0).
   */
  settledEpochs(epochs: number[]): Promise<Set<number>>;
  /** Votes whose commission node in `epoch` is known claimed. */
  claimedNodes(epoch: number): Promise<Map<string, KnownClaim>>;
  /** Inserts or replaces each (vote, epoch) row. */
  upsert(rows: MevEpochRow[]): Promise<void>;
  /** Pending commission nodes whose TDA expired before `currentEpoch` (closed unclaimed) become `expired`. */
  expirePending(currentEpoch: number): Promise<number>;
}

const CHUNK = 500;

export class PgMevRepository implements MevRepository {
  constructor(private readonly db: EpochDb) {}

  async settledEpochs(epochs: number[]): Promise<Set<number>> {
    if (epochs.length === 0) return new Set();
    const rows = await this.db
      .select({
        epoch: validatorMevEpochs.epoch,
        open: sql<number>`count(*) filter (where (${validatorMevEpochs.tda} is not null and (${validatorMevEpochs.rootUploaded} is not true or ${validatorMevEpochs.validatorClaim} = 'pending')) or (${validatorMevEpochs.pfda} is not null and (${validatorMevEpochs.pfRootUploaded} is not true or ${validatorMevEpochs.pfValidatorClaim} = 'pending')))::int`,
      })
      .from(validatorMevEpochs)
      .where(inArray(validatorMevEpochs.epoch, epochs))
      .groupBy(validatorMevEpochs.epoch);
    return new Set(rows.filter((r) => Number(r.open) === 0).map((r) => r.epoch));
  }

  async claimedNodes(epoch: number): Promise<Map<string, KnownClaim>> {
    const rows = await this.db
      .select({
        vote: validatorMevEpochs.vote,
        amount: validatorMevEpochs.validatorShareLamports,
        slot: validatorMevEpochs.validatorClaimedSlot,
      })
      .from(validatorMevEpochs)
      .where(and(eq(validatorMevEpochs.epoch, epoch), eq(validatorMevEpochs.validatorClaim, 'claimed')));
    return new Map(rows.map((r) => [r.vote, { amount: r.amount ?? 0n, slot: r.slot }]));
  }

  async upsert(rows: MevEpochRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db
        .insert(validatorMevEpochs)
        .values(chunk)
        .onConflictDoUpdate({
          target: [validatorMevEpochs.vote, validatorMevEpochs.epoch],
          set: {
            tda: sql`excluded.tda`,
            mevCommissionBps: sql`excluded.mev_commission_bps`,
            tipsLamports: sql`excluded.tips_lamports`,
            tdaLamports: sql`excluded.tda_lamports`,
            rootUploaded: sql`excluded.root_uploaded`,
            totalFundsClaimedLamports: sql`excluded.total_funds_claimed_lamports`,
            nodesClaimed: sql`excluded.nodes_claimed`,
            maxNodes: sql`excluded.max_nodes`,
            validatorShareLamports: sql`excluded.validator_share_lamports`,
            validatorShareEstimated: sql`excluded.validator_share_estimated`,
            validatorClaim: sql`excluded.validator_claim`,
            validatorClaimedSlot: sql`excluded.validator_claimed_slot`,
            expiresAt: sql`excluded.expires_at`,
            uploadAuthority: sql`excluded.upload_authority`,
            pfda: sql`excluded.pfda`,
            pfCommissionBps: sql`excluded.pf_commission_bps`,
            pfTransferredLamports: sql`excluded.pf_transferred_lamports`,
            pfTotalClaimLamports: sql`excluded.pf_total_claim_lamports`,
            pfRootUploaded: sql`excluded.pf_root_uploaded`,
            pfValidatorClaim: sql`excluded.pf_validator_claim`,
            scannedAt: sql`now()`,
          },
        });
    }
  }

  async expirePending(currentEpoch: number): Promise<number> {
    const rows = await this.db
      .update(validatorMevEpochs)
      .set({ validatorClaim: 'expired' })
      .where(and(eq(validatorMevEpochs.validatorClaim, 'pending'), lt(validatorMevEpochs.expiresAt, currentEpoch)))
      .returning({ vote: validatorMevEpochs.vote });
    return rows.length;
  }
}

/** The same rules in memory (tests, demos). */
export class MemoryMevRepository implements MevRepository {
  readonly rows = new Map<string, MevEpochRow>();

  private static key(vote: string, epoch: number): string {
    return `${epoch}:${vote}`;
  }

  async settledEpochs(epochs: number[]): Promise<Set<number>> {
    const settled = new Set<number>();
    for (const epoch of epochs) {
      const rows = [...this.rows.values()].filter((r) => r.epoch === epoch);
      const open = rows.some(
        (r) =>
          ((r.tda ?? null) !== null && (r.rootUploaded !== true || r.validatorClaim === 'pending')) ||
          ((r.pfda ?? null) !== null && (r.pfRootUploaded !== true || r.pfValidatorClaim === 'pending')),
      );
      if (rows.length > 0 && !open) settled.add(epoch);
    }
    return settled;
  }

  async claimedNodes(epoch: number): Promise<Map<string, KnownClaim>> {
    return new Map(
      [...this.rows.values()]
        .filter((r) => r.epoch === epoch && r.validatorClaim === 'claimed')
        .map((r) => [r.vote, { amount: r.validatorShareLamports ?? 0n, slot: r.validatorClaimedSlot ?? null }]),
    );
  }

  async upsert(rows: MevEpochRow[]): Promise<void> {
    for (const row of rows) this.rows.set(MemoryMevRepository.key(row.vote, row.epoch), { ...row });
  }

  async expirePending(currentEpoch: number): Promise<number> {
    let changed = 0;
    for (const row of this.rows.values()) {
      if (
        row.validatorClaim === 'pending' &&
        (row.expiresAt ?? null) !== null &&
        (row.expiresAt as number) < currentEpoch
      ) {
        row.validatorClaim = 'expired';
        changed++;
      }
    }
    return changed;
  }
}
