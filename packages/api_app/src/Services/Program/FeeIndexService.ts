import { type EventName, type FeeIndexAccount, feeIndexHistory } from '@epoch/epoch-sdk';
import { ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { type EpochDb, epochIndex } from '@epoch/pg_models';
import { and, desc, gte, lte, type SQL } from 'drizzle-orm';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import {
  type FeeIndexLatest,
  type FeeIndexPoint,
  type FeeIndexStatus,
  type FeeIndexStreamData,
} from '../../types/Activity.types';
import { type ProgramEventStore } from './ProgramEventStore';

const logger = Logger.create('FeeIndexService');

export const INDEX_EVENT_NAMES: readonly EventName[] = ['IndexProposed', 'IndexFinalized', 'IndexVetoed'];

/** Points the WS `feeIndex` channel carries. */
const STREAM_POINTS = 16;

export interface FeeIndexRange {
  /** Inclusive. */
  from?: number;
  /** Inclusive. */
  to?: number;
  limit: number;
}

/** Fee Index values the indexer computed (epoch_index); no status. */
export interface ComputedIndexSource {
  /** Newest first. */
  list(range: FeeIndexRange): Promise<{ epoch: number; value: number }[]>;
}

export class PgComputedIndexSource implements ComputedIndexSource {
  constructor(private readonly db: EpochDb) {}

  async list({ from, to, limit }: FeeIndexRange): Promise<{ epoch: number; value: number }[]> {
    const conditions: SQL[] = [];
    if (from !== undefined) conditions.push(gte(epochIndex.epoch, from));
    if (to !== undefined) conditions.push(lte(epochIndex.epoch, to));
    const rows = await this.db
      .select({ epoch: epochIndex.epoch, value: epochIndex.value })
      .from(epochIndex)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(epochIndex.epoch))
      .limit(limit);
    return rows;
  }
}

/** The program side (EpochProgramSource). */
export interface FeeIndexReader {
  readonly configured: boolean;
  /** The FeeIndex account, or null before `initialize_index`. */
  feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null>;
}

export interface FeeIndexServiceDeps {
  program: FeeIndexReader;
  events: Pick<ProgramEventStore, 'query'>;
  /** epoch_index in Postgres; null without DATABASE_URL. */
  computed: ComputedIndexSource | null;
}

/** A program point with what decides it: the slot of its newest fact and, for a proposal, its dispute window. */
interface ProgramPoint {
  epoch: number;
  value: number;
  status: FeeIndexStatus;
  slot: number;
  disputeEndsSlot: number | null;
}

/** Program points by epoch. */
type ProgramView = Map<number, ProgramPoint>;

const EVENT_STATUS: Partial<Record<EventName, FeeIndexStatus>> = {
  IndexProposed: 'proposed',
  IndexFinalized: 'final',
  IndexVetoed: 'vetoed',
};

const toPoint = ({ epoch, value, status }: ProgramPoint): FeeIndexPoint => ({ epoch, value, status });

/**
 * The Solana Fee Index per epoch with its status (request #3), merged from three sources:
 * - the FeeIndex account: the last final value and its 16-epoch history → `final`; a pending proposal → `proposed`;
 * - stored IndexProposed / IndexFinalized / IndexVetoed events: the newest event per epoch decides (finalized →
 *   `final`, proposed → `proposed`, vetoed → `vetoed`), so a vetoed proposal stays visible until a new one is posted;
 * - epoch_index rows the indexer computed: kept only for epochs the program has no value for, without a status.
 * Final is terminal (the program never re-opens a finalized epoch), and program values win over computed ones.
 */
export class FeeIndexService {
  constructor(private readonly deps: FeeIndexServiceDeps) {}

  /** True when the program or the database is configured. */
  get available(): boolean {
    return this.deps.program.configured || this.deps.computed !== null;
  }

  /** GET /v1/index: newest first. 503 PROGRAM_NOT_CONFIGURED without the program and the database. */
  async points(range: FeeIndexRange): Promise<FeeIndexPoint[]> {
    this.requireAvailable();
    return this.merge(await this.programView(), range);
  }

  /** The last final value, the pending proposal and the 8-epoch average (FeeMarketSnapshot.index, the KPIs). */
  async latest(): Promise<FeeIndexLatest> {
    this.requireAvailable();
    return this.latestOf(await this.programView());
  }

  /** The WS `feeIndex` channel: the 16 newest points and `latest()`, from one read. */
  async stream(): Promise<FeeIndexStreamData> {
    this.requireAvailable();
    const view = await this.programView();
    const points = await this.merge(view, { limit: STREAM_POINTS });
    return { points, ...this.latestOf(view) };
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'The Fee Index needs the Epoch program (EPOCH_PROGRAM_ID) or Postgres (DATABASE_URL); this API has neither',
        'PROGRAM_NOT_CONFIGURED',
      );
    }
  }

  private async merge(view: ProgramView, range: FeeIndexRange): Promise<FeeIndexPoint[]> {
    const computed = this.deps.computed ? await this.deps.computed.list(range) : [];
    const byEpoch = new Map<number, FeeIndexPoint>();
    for (const row of computed) byEpoch.set(row.epoch, { epoch: row.epoch, value: row.value });
    for (const point of view.values()) byEpoch.set(point.epoch, toPoint(point));
    return [...byEpoch.values()]
      .filter(
        (p) => (range.from === undefined || p.epoch >= range.from) && (range.to === undefined || p.epoch <= range.to),
      )
      .sort((a, b) => b.epoch - a.epoch)
      .slice(0, range.limit);
  }

  private latestOf(view: ProgramView): FeeIndexLatest {
    const newestFirst = [...view.values()].sort((a, b) => b.epoch - a.epoch);
    const finals = newestFirst.filter((p) => p.status === 'final');
    const proposed = newestFirst.find((p) => p.status === 'proposed');
    const last8 = finals.slice(0, 8);
    return {
      final: finals[0] ? { epoch: finals[0].epoch, value: finals[0].value } : null,
      proposed: proposed
        ? { epoch: proposed.epoch, value: proposed.value, disputeEndsSlot: proposed.disputeEndsSlot }
        : null,
      avg8: last8.length ? Math.round(last8.reduce((sum, p) => sum + p.value, 0) / last8.length) : null,
    };
  }

  private async programView(): Promise<ProgramView> {
    const points: ProgramView = new Map();
    if (!this.deps.program.configured) return points;
    const [account, events] = await Promise.all([
      this.readAccount(),
      this.deps.events.query({ names: INDEX_EVENT_NAMES, limit: 10_000 }), // newest first
    ]);
    const window = account ? Number(account.disputeWindowSlots) : null;

    // Oldest first, so the newest event per epoch is the one left standing; a final value is never replaced.
    for (const event of [...events].reverse()) {
      const point = fromEvent(event, window);
      if (point && points.get(point.epoch)?.status !== 'final') points.set(point.epoch, point);
    }
    if (!account) return points;

    const finals = feeIndexHistory(account).map((p) => ({ epoch: Number(p.epoch), value: Number(p.value) }));
    if (account.finalizedSlot > 0n) finals.push({ epoch: Number(account.epoch), value: Number(account.value) });
    for (const { epoch, value } of finals) {
      points.set(epoch, { epoch, value, status: 'final', slot: Number(account.finalizedSlot), disputeEndsSlot: null });
    }
    if (account.hasProposal) {
      const epoch = Number(account.proposedEpoch);
      const slot = Number(account.proposedSlot);
      const known = points.get(epoch);
      // The account wins unless an event newer than its proposal says otherwise (a veto the cached read predates).
      if (!known || (known.status !== 'final' && known.slot <= slot)) {
        points.set(epoch, {
          epoch,
          value: Number(account.proposedValue),
          status: 'proposed',
          slot,
          disputeEndsSlot: slot + Number(account.disputeWindowSlots),
        });
      }
    }
    return points;
  }

  /** The account, or null before `initialize_index`; a failed read degrades to the stored events (logged). */
  private async readAccount(): Promise<FeeIndexAccount | null> {
    try {
      return (await this.deps.program.feeIndex())?.account ?? null;
    } catch (error) {
      logger.warn('FeeIndex account read failed; using stored index events only', { error: String(error) });
      return null;
    }
  }
}

function fromEvent(event: StoredProgramEvent, window: number | null): ProgramPoint | null {
  const status = EVENT_STATUS[event.name];
  const epoch = Number(event.data.epoch);
  const value = Number(event.data.value);
  if (!status || !Number.isFinite(epoch) || !Number.isFinite(value)) return null;
  // IndexProposed carries the proposal's slot; its window ends `dispute_window_slots` later.
  const proposalSlot = Number(event.data.slot ?? event.slot);
  return {
    epoch,
    value,
    status,
    slot: event.slot,
    disputeEndsSlot: status === 'proposed' && window !== null ? proposalSlot + window : null,
  };
}
