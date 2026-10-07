import {
  type EventName,
  type FeeIndexAccount,
  feeIndexHistory,
  type IndexBallotAccount,
  indexBallotStatus,
} from '@epoch/epoch-sdk';
import { ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { type EpochDb, epochIndex } from '@epoch/pg_models';
import { and, desc, gte, isNotNull, lte, type SQL } from 'drizzle-orm';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import {
  type FeeIndexBallotView,
  type FeeIndexLatest,
  type FeeIndexPoint,
  type FeeIndexStatus,
  type FeeIndexStreamData,
} from '../../types/Activity.types';
import { ballotFromAccount } from './FeeIndexBallotView';
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

/** A post publisher_app recorded: mainnet epoch M (epoch_index) and the program epoch P its value went under. */
export interface PostedEpoch {
  mainnetEpoch: number;
  clusterEpoch: number;
}

/** The recorded posts, whatever the offset was when they were made. */
export interface PostedEpochSource {
  pairs(): Promise<PostedEpoch[]>;
}

/**
 * Each epoch_index row's `posted_signature` (publisher_app writes it: the `post_index` transaction, or under operator
 * consensus the first `cast_index_vote`) leads to its IndexProposed / IndexVoteCast event and so to the program
 * epoch, whatever the offset was. A post older than the newest 10,000 such events is not found (the offset applies).
 * ponytail: two reads per call (epoch_index posts, index events), uncached; cache them if they show in profiles.
 */
export class PgPostedEpochSource implements PostedEpochSource {
  constructor(
    private readonly db: EpochDb,
    private readonly events: Pick<ProgramEventStore, 'query'>,
  ) {}

  async pairs(): Promise<PostedEpoch[]> {
    const rows = await this.db
      .select({ epoch: epochIndex.epoch, signature: epochIndex.postedSignature })
      .from(epochIndex)
      .where(isNotNull(epochIndex.postedSignature));
    if (!rows.length) return [];
    const posts = await this.events.query({ names: ['IndexProposed', 'IndexVoteCast'], limit: 10_000 });
    const programEpoch = new Map(posts.map((event) => [event.signature, Number(event.data.epoch)]));
    return rows.flatMap(({ epoch, signature }) => {
      const clusterEpoch = signature ? programEpoch.get(signature) : undefined;
      return clusterEpoch === undefined ? [] : [{ mainnetEpoch: epoch, clusterEpoch }];
    });
  }
}

/**
 * Mainnet epoch ↔ program-cluster epoch, the way publisher_app maps them (Index/EpochMapping.ts): a recorded post
 * first, then `P = M + offset`; with `auto` only recorded posts are known.
 */
export class EpochMap {
  private readonly clusterOf = new Map<number, number>();
  private readonly mainnetOf = new Map<number, number>();

  constructor(
    private readonly offset: number | 'auto',
    posts: readonly PostedEpoch[] = [],
  ) {
    for (const { mainnetEpoch, clusterEpoch } of posts) {
      this.clusterOf.set(mainnetEpoch, clusterEpoch);
      this.mainnetOf.set(clusterEpoch, mainnetEpoch);
    }
  }

  cluster(mainnetEpoch: number): number | null {
    return this.clusterOf.get(mainnetEpoch) ?? (this.offset === 'auto' ? null : mainnetEpoch + this.offset);
  }

  mainnet(clusterEpoch: number): number | null {
    return this.mainnetOf.get(clusterEpoch) ?? (this.offset === 'auto' ? null : clusterEpoch - this.offset);
  }
}

/** The program side (EpochProgramSource). */
export interface FeeIndexReader {
  readonly configured: boolean;
  /** The FeeIndex account, or null before `initialize_index`. */
  feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null>;
  /** The FeeIndex's open IndexBallot accounts (operator consensus); absent or empty without consensus. */
  indexBallots?(): Promise<ProgramAccount<IndexBallotAccount>[]>;
}

export interface FeeIndexServiceDeps {
  program: FeeIndexReader;
  events: Pick<ProgramEventStore, 'query'>;
  /** epoch_index in Postgres; null without DATABASE_URL. */
  computed: ComputedIndexSource | null;
  /** FEE_INDEX_EPOCH_OFFSET: how mainnet epochs map to the program's (0 on mainnet and localnet, `auto` on devnet). */
  epochOffset?: number | 'auto';
  /** The recorded posts, which win over the offset; absent without Postgres. */
  posted?: PostedEpochSource | null;
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

/**
 * The Solana Fee Index per epoch with its status (request #3), merged from three sources:
 * - the FeeIndex account: the last final value and its 16-epoch history → `final`; a pending proposal → `proposed`;
 * - stored IndexProposed / IndexFinalized / IndexVetoed events: the newest event per epoch decides (finalized →
 *   `final`, proposed → `proposed`, vetoed → `vetoed`), so a vetoed proposal stays visible until a new one is posted;
 * - open IndexBallot accounts (operator consensus): an epoch still voting, or agreed and queued, with no newer program
 *   fact → `voting` (value: the agreed value once reached, else the current weighted median); a ballot reopened after
 *   a veto replaces the vetoed point;
 * - epoch_index rows the indexer computed: kept only for epochs the program has no value for, without a status.
 * Final is terminal (the program never re-opens a finalized epoch), and program values win over computed ones.
 *
 * The program numbers its points by its own cluster's epochs, epoch_index by mainnet's; the points are put on mainnet
 * numbering through `EpochMap` (`clusterEpoch` beside). A program value whose mainnet epoch is unknown (the `auto`
 * offset and no recorded post, e.g. posted by hand) is left out. `latest()` and the stream's `final` and `proposed`
 * stay in program epochs, like the quotes and swaps they are read with.
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
    const [{ points }, map] = await Promise.all([this.programView(), this.epochMap()]);
    return this.merge(points, range, map);
  }

  /** The last final value, the pending proposal and the 8-epoch average (FeeMarketSnapshot.index, the KPIs). */
  async latest(): Promise<FeeIndexLatest> {
    this.requireAvailable();
    return this.latestOf((await this.programView()).points);
  }

  /** The WS `feeIndex` channel: the 16 newest points, `latest()` and the open ballot's progress, from one read. */
  async stream(): Promise<FeeIndexStreamData> {
    this.requireAvailable();
    const [{ points: view, account, ballots }, map] = await Promise.all([this.programView(), this.epochMap()]);
    const points = await this.merge(view, { limit: STREAM_POINTS }, map);
    const open = ballots
      .filter(({ account: b }) => !account || indexBallotStatus(b, account) !== 'settled')
      .sort((a, b) => (a.account.epoch < b.account.epoch ? 1 : -1))[0];
    const ballot: FeeIndexBallotView | null = open ? ballotFromAccount(open.address, open.account, account) : null;
    return { points, ...this.latestOf(view), ballot };
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'The Fee Index needs the Epoch program (EPOCH_PROGRAM_ID) or Postgres (DATABASE_URL); this API has neither',
        'PROGRAM_NOT_CONFIGURED',
      );
    }
  }

  /** The recorded posts and the offset; a failed read degrades to the offset alone (logged). */
  private async epochMap(): Promise<EpochMap> {
    const offset = this.deps.epochOffset ?? 0;
    if (!this.deps.posted) return new EpochMap(offset);
    try {
      return new EpochMap(offset, await this.deps.posted.pairs());
    } catch (error) {
      logger.warn('recorded Fee Index posts could not be read; numbering by the offset alone', {
        error: String(error),
      });
      return new EpochMap(offset);
    }
  }

  private async merge(view: ProgramView, range: FeeIndexRange, map: EpochMap): Promise<FeeIndexPoint[]> {
    const computed = this.deps.computed ? await this.deps.computed.list(range) : [];
    const byEpoch = new Map<number, FeeIndexPoint>();
    for (const row of computed) {
      byEpoch.set(row.epoch, {
        epoch: row.epoch,
        value: row.value,
        mainnetEpoch: row.epoch,
        clusterEpoch: map.cluster(row.epoch),
      });
    }
    for (const point of view.values()) {
      const epoch = map.mainnet(point.epoch);
      if (epoch === null) continue;
      byEpoch.set(epoch, {
        epoch,
        value: point.value,
        status: point.status,
        mainnetEpoch: epoch,
        clusterEpoch: point.epoch,
      });
    }
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

  private async programView(): Promise<{
    points: ProgramView;
    account: FeeIndexAccount | null;
    ballots: ProgramAccount<IndexBallotAccount>[];
  }> {
    const points: ProgramView = new Map();
    if (!this.deps.program.configured) return { points, account: null, ballots: [] };
    const [account, events, ballots] = await Promise.all([
      this.readAccount(),
      this.deps.events.query({ names: INDEX_EVENT_NAMES, limit: 10_000 }), // newest first
      this.readBallots(),
    ]);
    const window = account ? Number(account.disputeWindowSlots) : null;

    // Oldest first, so the newest event per epoch is the one left standing; a final value is never replaced.
    for (const event of [...events].reverse()) {
      const point = fromEvent(event, window);
      if (point && points.get(point.epoch)?.status !== 'final') points.set(point.epoch, point);
    }
    if (!account) return { points, account, ballots };

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
    for (const { account: ballot } of ballots) {
      const status = indexBallotStatus(ballot, account);
      if ((status !== 'voting' && status !== 'queued') || ballot.votesCast === 0) continue;
      const epoch = Number(ballot.epoch);
      const opened = Number(ballot.openedSlot);
      const known = points.get(epoch);
      // Only a vetoed point older than this round gives way (the round reopened after the veto).
      if (known && !(known.status === 'vetoed' && known.slot <= opened)) continue;
      const consensus = ballot.consensusSlot > 0n;
      points.set(epoch, {
        epoch,
        value: Number(consensus ? ballot.consensusValue : ballot.medianValue),
        status: 'voting',
        slot: opened,
        disputeEndsSlot: null,
      });
    }
    return { points, account, ballots };
  }

  /** The open ballots, or none without consensus; a failed read degrades to no voting points (logged). */
  private async readBallots(): Promise<ProgramAccount<IndexBallotAccount>[]> {
    if (!this.deps.program.indexBallots) return [];
    try {
      return await this.deps.program.indexBallots();
    } catch (error) {
      logger.warn('IndexBallot accounts read failed; no voting points', { error: String(error) });
      return [];
    }
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
