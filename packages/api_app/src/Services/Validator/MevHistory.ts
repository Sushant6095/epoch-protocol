import { GracefulShutdown } from '@epoch/common';
import { Logger } from '@epoch/logger';
import { type EpochDb, validatorMevEpochs } from '@epoch/pg_models';
import { asc, gte } from 'drizzle-orm';

import { round } from '../../Lib/Stats';
import { type KobeEpochRewards } from '../../Sources/ExternalSources';
import { type MevClaimStatus, type MevHistoryRow } from '../../types/Wallet.types';

const logger = Logger.create('MevHistory');

/** Epochs of validator_mev_epochs kept in memory (≈ 650 TDAs per epoch). */
export const MEV_HISTORY_EPOCHS = 20;
const LAMPORTS_PER_SOL = 1_000_000_000;
const REFRESH_MS = 10 * 60_000;

/** One validator's Jito figures for one mainnet epoch, as indexer_app's MEV scan stored them. */
export interface MevEpochRecord {
  epoch: number;
  /** Null when the validator had only a PriorityFeeDistributionAccount that epoch. */
  commissionBps: number | null;
  /** The root's total once uploaded, else the tips so far (TDA balance less rent). */
  tipsLamports: bigint | null;
  rootUploaded: boolean | null;
  validatorShareLamports: bigint | null;
  validatorShareEstimated: boolean | null;
  claim: MevClaimStatus | null;
  claimedSlot: number | null;
  pfCommissionBps: number | null;
  pfTransferredLamports: bigint | null;
  /** The PFDA's validator node: claimed | pending | none; null without a PFDA. */
  pfClaim: MevClaimStatus | null;
}

export interface MevSnapshot {
  /** Changes whenever a load found different rows (the validator table rebuilds on it). */
  version: number;
  /** vote → epochs, oldest first. */
  byVote: Map<string, MevEpochRecord[]>;
  newestEpoch: number | null;
}

export interface MevHistoryStore {
  /** validator_mev_epochs rows from `fromEpoch` on. */
  load(fromEpoch: number): Promise<(MevEpochRecord & { vote: string; scannedAt: Date })[]>;
}

const CLAIMS: readonly MevClaimStatus[] = ['claimed', 'pending', 'none', 'expired'];

export class PgMevHistoryStore implements MevHistoryStore {
  constructor(private readonly db: EpochDb) {}

  async load(fromEpoch: number): Promise<(MevEpochRecord & { vote: string; scannedAt: Date })[]> {
    const rows = await this.db
      .select()
      .from(validatorMevEpochs)
      .where(gte(validatorMevEpochs.epoch, fromEpoch))
      .orderBy(asc(validatorMevEpochs.epoch));
    return rows.map((r) => ({
      vote: r.vote,
      epoch: r.epoch,
      commissionBps: r.mevCommissionBps,
      tipsLamports: r.tipsLamports,
      rootUploaded: r.rootUploaded,
      validatorShareLamports: r.validatorShareLamports,
      validatorShareEstimated: r.validatorShareEstimated,
      claim: (CLAIMS as readonly string[]).includes(r.validatorClaim ?? '')
        ? (r.validatorClaim as MevClaimStatus)
        : null,
      claimedSlot: r.validatorClaimedSlot,
      pfCommissionBps: r.pfCommissionBps,
      pfTransferredLamports: r.pfTransferredLamports,
      pfClaim: (CLAIMS as readonly string[]).includes(r.pfValidatorClaim ?? '')
        ? (r.pfValidatorClaim as MevClaimStatus)
        : null,
      scannedAt: r.scannedAt,
    }));
  }
}

/**
 * Keeps the last MEV_HISTORY_EPOCHS epochs of indexer_app's MEV scan in memory for the validator table, the profile
 * and the position (reloaded every 10 minutes; the scan itself runs hourly). Undefined without Postgres or before the
 * first load, and the readers then fall back to Jito Kobe and Stakewiz.
 */
export class MevHistoryLoader {
  private snapshot?: MevSnapshot;
  private fingerprint = '';
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: MevHistoryStore | undefined,
    private readonly currentEpoch: () => Promise<number>,
  ) {}

  get latest(): MevSnapshot | undefined {
    return this.snapshot;
  }

  start(): void {
    if (!this.store) return;
    const run = () => {
      this.refresh().catch((error: unknown) => logger.warn('MEV history load failed', { error: String(error) }));
    };
    setTimeout(run, 3_000).unref();
    this.timer = setInterval(run, REFRESH_MS);
    this.timer.unref();
    GracefulShutdown.register('mev-history', async () => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  async refresh(): Promise<MevSnapshot | undefined> {
    if (!this.store) return undefined;
    const epoch = await this.currentEpoch();
    const rows = await this.store.load(epoch - MEV_HISTORY_EPOCHS + 1);
    const newestScan = rows.reduce((max, r) => Math.max(max, r.scannedAt.getTime()), 0);
    const fingerprint = `${rows.length}:${newestScan}`;
    if (this.snapshot && fingerprint === this.fingerprint) return this.snapshot;
    const byVote = new Map<string, MevEpochRecord[]>();
    for (const { vote, scannedAt: _scannedAt, ...record } of rows) {
      const list = byVote.get(vote) ?? [];
      list.push(record);
      byVote.set(vote, list);
    }
    for (const list of byVote.values()) list.sort((a, b) => a.epoch - b.epoch);
    this.fingerprint = fingerprint;
    this.snapshot = {
      version: (this.snapshot?.version ?? 0) + 1,
      byVote,
      newestEpoch: rows.length > 0 ? Math.max(...rows.map((r) => r.epoch)) : null,
    };
    return this.snapshot;
  }
}

const toSol = (lamports: bigint | null, digits = 4): number | null =>
  lamports === null ? null : round(Number(lamports) / LAMPORTS_PER_SOL, digits);

/**
 * `GET /v1/validators` fields from the chain. Commission: the newest TDA of this or the last epoch (a validator gets
 * its TDA when it first leads a slot running Jito). Tips: the newest finished epoch whose root is uploaded.
 */
export function chainMev(
  records: readonly MevEpochRecord[] | undefined,
  currentEpoch: number,
): { commissionBps: number | null; tipsSol: number | null; tipsEpoch: number | null } {
  const tdas = (records ?? []).filter((r) => r.commissionBps !== null);
  const newest = [...tdas].reverse().find((r) => r.epoch >= currentEpoch - 1 && r.epoch <= currentEpoch);
  const finished = [...tdas].reverse().find((r) => r.epoch < currentEpoch && r.rootUploaded === true);
  return {
    commissionBps: newest?.commissionBps ?? null,
    tipsSol: finished ? toSol(finished.tipsLamports, 3) : null,
    tipsEpoch: finished?.epoch ?? null,
  };
}

/**
 * The profile's MEV history, oldest first: the chain's rows (indexer_app's scan) and, for older epochs, Jito Kobe's
 * (commission and the stake's tips; Kobe has no claim data). Each row says where it came from.
 */
export function mevHistoryRows(
  records: readonly MevEpochRecord[] | undefined,
  kobe: readonly KobeEpochRewards[] | null,
): MevHistoryRow[] {
  const chain = (records ?? []).filter((r) => r.commissionBps !== null || r.pfCommissionBps !== null);
  const chainEpochs = new Set(chain.map((r) => r.epoch));
  const fromChain: MevHistoryRow[] = chain.map((r) => ({
    epoch: r.epoch,
    source: 'chain',
    commissionBps: r.commissionBps,
    tipsSol: toSol(r.tipsLamports),
    final: r.rootUploaded === true,
    validatorShareSol: toSol(r.validatorShareLamports),
    estimated: r.validatorShareEstimated ?? null,
    claimStatus: r.claim,
    claimedSlot: r.claimedSlot,
    pfCommissionBps: r.pfCommissionBps,
    pfTransferredSol: toSol(r.pfTransferredLamports),
    pfClaimStatus: r.pfClaim,
  }));
  const fromKobe: MevHistoryRow[] = (kobe ?? [])
    .filter((k) => !chainEpochs.has(k.epoch) && (k.mev_commission_bps !== null || k.mev_rewards !== null))
    .map((k) => ({
      epoch: k.epoch,
      source: 'kobe',
      commissionBps: k.mev_commission_bps,
      tipsSol: k.mev_rewards === null ? null : round(k.mev_rewards / LAMPORTS_PER_SOL, 4),
      final: true,
      validatorShareSol:
        k.mev_rewards === null || k.mev_commission_bps === null
          ? null
          : round(((k.mev_rewards / LAMPORTS_PER_SOL) * k.mev_commission_bps) / 10_000, 4),
      estimated: true,
      claimStatus: null,
      claimedSlot: null,
      pfCommissionBps: null,
      pfTransferredSol: null,
      pfClaimStatus: null,
    }));
  return [...fromKobe, ...fromChain].sort((a, b) => a.epoch - b.epoch);
}
