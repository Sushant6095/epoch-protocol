import { type LiveSlotPayload } from '@epoch/pg_models';
import { type SolamiUsageReport, solamiUsage } from '@epoch/solana';

import { KeyedSnapshotCache } from '../../Lib/KeyedSnapshotCache';
import { isoIst, LAMPORTS_PER_SOL, round } from '../../Lib/Stats';
import { type EpochInfo } from '../../Sources/SolanaDataSource';
import {
  type FeeDistribution,
  type LiveEstimate,
  type LiveLeader,
  type LiveLeaders,
  type LiveSlot,
  type LiveSlots,
  type LiveSource,
  type LiveStreamStatus,
  type LiveSummary,
  type SolamiBeamUsage,
  type SolamiGrpcUsage,
  type SolamiRpcUsage,
  type SolamiUsageResponse,
} from '../../types/Live.types';
import { EMPTY_NAMES, type NameIndex } from '../Activity/ValidatorNames';
import { type FeeIndexLiveRow, type LeaderStat, type LiveRepository, type LiveSlotRow } from './LiveRepository';

const SLOT_SECONDS = 0.4;
/** A watermark this far behind the processed slot means gap fill or a backfill is running. */
const CATCHING_UP_SLOTS = 150;
const BUCKETS_PER_DECADE = 4;
const SOURCE_LABEL: Record<LiveSource, string> = {
  grpc: 'Solami gRPC (Yellowstone)',
  hybrid: 'Solami gRPC (block meta) + Solami RPC (blocks)',
  rpc: 'RPC polling',
};

export interface LiveServiceDeps {
  repo: LiveRepository;
  /** Mainnet epoch info (MarketData's cached getEpochInfo) and when it was read (ms); null when the RPC is down. */
  epochInfo: () => Promise<(EpochInfo & { readAt?: number }) | null>;
  names: () => Promise<NameIndex>;
  /** LIVE_STALE_AFTER_SECONDS × 1000. */
  staleAfterMs: number;
  /** This process's own Solami counters (the slot and program stream, its RPC calls). Default: `solamiUsage`. */
  apiUsage?: () => SolamiUsageReport;
  /** SOLAMI_USAGE_STALE_SECONDS × 1000: a component's counters older than this are shown as stale. Default 120 s. */
  usageStaleMs?: number;
  now?: () => number;
}

/** Stake-weighted median of leader medians (same rule as indexer_app's FeeProcessor, ties broken by key). */
export function weightedMedian(entries: { leader: string; medianCuPrice: number; stake: bigint }[]) {
  const staked = entries
    .filter((e) => e.stake > 0n)
    .sort((a, b) => a.medianCuPrice - b.medianCuPrice || (a.leader < b.leader ? -1 : a.leader > b.leader ? 1 : 0));
  const total = staked.reduce((sum, e) => sum + e.stake, 0n);
  let running = 0n;
  for (const entry of staked) {
    running += entry.stake;
    if (running * 2n >= total) return entry;
  }
  return null;
}

const toNumber = (value: number | null | undefined): number | null => (value === undefined ? null : value);
const ist = (date: Date | null | undefined): string | null => (date ? isoIst(date) : null);

/**
 * The Live page's data: what the indexer streams into Postgres (fee_index_live, live_slots, slot_fees, epoch_index,
 * epoch_stakes), read here and labelled honestly. `live` is true only while the indexer is processing slots; otherwise
 * every endpoint still answers, with the last known state, `live: false` and `asOf` set to when it was written.
 */
export class LiveService {
  private readonly now: () => number;
  private readonly leaderCache: KeyedSnapshotCache<LeaderStat[]>;
  private readonly distributionCache: KeyedSnapshotCache<Awaited<ReturnType<LiveRepository['distribution']>>>;

  constructor(private readonly deps: LiveServiceDeps) {
    this.now = deps.now ?? Date.now;
    // Aggregates over up to 432,000 slot_fees rows: shared and cached briefly (finished epochs barely change).
    this.leaderCache = new KeyedSnapshotCache('liveLeaders', 16, 10_000, (key) => deps.repo.leaderStats(Number(key)));
    this.distributionCache = new KeyedSnapshotCache('liveDistribution', 16, 10_000, (key) =>
      deps.repo.distribution(Number(key)),
    );
  }

  /** True when the row shows a slot processed within the staleness window. */
  isLive(row: Pick<FeeIndexLiveRow, 'updatedAt' | 'lastSlotAt'> | null): boolean {
    if (!row?.lastSlotAt) return false;
    const now = this.now();
    return (
      now - row.updatedAt.getTime() <= this.deps.staleAfterMs &&
      now - row.lastSlotAt.getTime() <= this.deps.staleAfterMs
    );
  }

  async summary(): Promise<LiveSummary> {
    const [row, info] = await Promise.all([this.deps.repo.latestLive(), this.deps.epochInfo().catch(() => null)]);
    const live = this.isLive(row);
    const currentEpoch = info?.epoch ?? row?.epoch ?? null;
    const lastFinal = currentEpoch !== null ? await this.deps.repo.lastFinal(currentEpoch) : null;
    // A cached read is moved forward by the time since it was taken (slots are 400 ms), so a stalled indexer shows
    // its lag growing instead of a frozen tip.
    const rpcTip = info
      ? info.absoluteSlot + Math.max(0, Math.floor((this.now() - (info.readAt ?? this.now())) / 400))
      : 0;
    const tipSlot = Math.max(rpcTip, live ? (row?.tipSlot ?? 0) : 0) || null;
    const processedSlot = row?.processedSlot ?? null;
    const lagSlots = tipSlot !== null && processedSlot !== null ? Math.max(0, tipSlot - processedSlot) : null;
    const slotsInEpoch = info?.slotsInEpoch ?? 432_000;
    const epoch =
      info !== null
        ? {
            number: info.epoch,
            firstSlot: info.absoluteSlot - info.slotIndex,
            slotIndex: info.slotIndex,
            slotsInEpoch,
            progressPct: round((info.slotIndex / slotsInEpoch) * 100, 2),
          }
        : null;
    const source = (row?.source ?? null) as LiveSource | null;
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(row?.updatedAt ?? new Date(this.now())),
      source: 'indexer_app via Postgres (fee_index_live, epoch_index)',
      live,
      dataSource: this.dataSourceLabel(source, row?.endpoint ?? null),
      stream: this.stream(row, live),
      tipSlot,
      processedSlot,
      lagSlots,
      lagSeconds: lagSlots !== null ? round(lagSlots * SLOT_SECONDS, 1) : null,
      epoch,
      estimate: row ? this.estimate(row, epoch) : null,
      lastFinal: lastFinal
        ? {
            epoch: lastFinal.epoch,
            value: lastFinal.value,
            postedSignature: lastFinal.postedSignature,
            computedAt: isoIst(lastFinal.computedAt),
          }
        : null,
      unit: 'µL/CU',
      ...(row ? {} : { note: 'The indexer has not written anything yet: start indexer_app (see its README).' }),
    };
  }

  async slots(limit: number): Promise<LiveSlots> {
    const [rows, row, names] = await Promise.all([
      this.deps.repo.recentSlots(limit),
      this.deps.repo.latestLive(),
      this.names(),
    ]);
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(row?.updatedAt ?? rows[0]?.recordedAt ?? new Date(this.now())),
      source: 'indexer_app via Postgres (live_slots)',
      live: this.isLive(row),
      slots: rows.map((r) => this.slotFromRow(r, names)),
    };
  }

  async leaders(epochArg: number | undefined, limit: number): Promise<LiveLeaders> {
    const row = await this.deps.repo.latestLive();
    const info = await this.deps.epochInfo().catch(() => null);
    const current = info?.epoch ?? row?.epoch ?? 0;
    const epoch = epochArg ?? current;
    const [stats, stakeRow, final, names] = await Promise.all([
      this.leaderCache.get(String(epoch)),
      this.deps.repo.stakes(epoch),
      this.deps.repo.finalFor(epoch),
      this.names(),
    ]);
    const stakes = stakeRow?.stakes ?? new Map<string, bigint>();
    const entries = stats.map((s) => ({ ...s, stake: stakes.get(s.leader) ?? 0n }));
    const setter = weightedMedian(entries);
    const totalLamports = entries.reduce((sum, e) => sum + e.stake, 0n);
    const sorted = [...entries].sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : b.slots - a.slots));
    const leaders: LiveLeader[] = sorted.slice(0, limit).map((e, i) => ({
      rank: i + 1,
      identity: e.leader,
      name: names.byIdentity.get(e.leader) ?? null,
      slots: e.slots,
      medianCuPrice: e.medianCuPrice,
      pricedTxs: e.pricedTxs,
      stakeSol: e.stake > 0n ? round(Number(e.stake) / LAMPORTS_PER_SOL, 0) : null,
      weightPct: totalLamports > 0n ? round((Number(e.stake) / Number(totalLamports)) * 100, 3) : 0,
      setsIndex: setter?.leader === e.leader,
    }));
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(row?.updatedAt ?? new Date(this.now())),
      source: 'indexer_app via Postgres (slot_fees, epoch_stakes)',
      live: epoch === current && this.isLive(row),
      epoch,
      final: final !== null,
      value: final?.value ?? setter?.medianCuPrice ?? null,
      setter: setter?.leader ?? null,
      stakeEpoch: stakeRow?.epoch ?? null,
      totalStakeSol: round(Number(totalLamports) / LAMPORTS_PER_SOL, 0),
      leaders,
      leaderCount: entries.length,
      unit: 'µL/CU',
    };
  }

  async distribution(epoch: number): Promise<FeeDistribution> {
    const [rows, final, row, live] = await Promise.all([
      this.distributionCache.get(String(epoch)),
      this.deps.repo.finalFor(epoch),
      this.deps.repo.latestLive(),
      this.deps.repo.liveFor(epoch),
    ]);
    const buckets: FeeDistribution['buckets'] = [];
    if (rows.buckets.length > 0) {
      const counts = new Map(rows.buckets.map((b) => [b.bucket, b.slots]));
      const first = rows.buckets[0].bucket;
      const last = rows.buckets[rows.buckets.length - 1].bucket;
      for (let b = first; b <= last; b++) {
        buckets.push({
          fromCuPrice: Math.round(10 ** (b / BUCKETS_PER_DECADE)),
          toCuPrice: Math.round(10 ** ((b + 1) / BUCKETS_PER_DECADE)),
          slots: counts.get(b) ?? 0,
        });
      }
    }
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(live?.updatedAt ?? final?.computedAt ?? new Date(this.now())),
      source: 'indexer_app via Postgres (slot_fees)',
      live: live !== null && live.epoch === row?.epoch && this.isLive(live),
      epoch,
      final: final !== null,
      slots: rows.slots,
      buckets,
      percentiles: rows.percentiles,
      indexValue: final?.value ?? live?.estimate ?? null,
      unit: 'µL/CU',
    };
  }

  /**
   * GET /v1/live/solami: what Epoch uses of Solami, per component: gRPC streams (status, bytes, lag), RPC calls by
   * method (p50/p95, errors), Beam sends (landed, tips spent) and the last error. Built from the counters each process
   * writes to solami_usage, plus this API's own.
   */
  async solami(): Promise<SolamiUsageResponse> {
    const now = this.now();
    const staleMs = this.deps.usageStaleMs ?? 120_000;
    const rows = await this.deps.repo.usageReports();
    const own = { ...(this.deps.apiUsage ?? (() => solamiUsage.report()))(), component: 'api' };
    const entries = [
      ...rows
        .filter((row) => row.component !== 'api')
        .map((row) => ({ report: row.report as unknown as SolamiUsageReport, updatedAt: row.updatedAt.getTime() })),
      { report: own, updatedAt: now },
    ].map((entry) => ({ ...entry, name: entry.report.component, stale: now - entry.updatedAt > staleMs }));

    const grpc: SolamiGrpcUsage[] = entries
      .filter((e) => e.report.grpc)
      .map(({ name, stale, report }) => {
        const g = report.grpc as NonNullable<SolamiUsageReport['grpc']>;
        return {
          component: name,
          subscription: g.subscription ?? null,
          endpoint: g.endpoint ?? null,
          status: stale ? 'offline' : g.status,
          compression: g.compression ?? null,
          bytes: g.bytes ?? 0,
          updates: g.updates ?? 0,
          reconnects: g.reconnects ?? 0,
          lastUpdateAt: g.lastUpdateAt ? isoIst(new Date(g.lastUpdateAt)) : null,
          lagSlots: g.lagSlots ?? null,
        };
      });
    // Fields in a fixed order (jsonb reorders keys when the components store their reports).
    const rpc: SolamiRpcUsage[] = entries.flatMap(({ name, report }) =>
      (report.rpc ?? []).map((r) => ({
        component: name,
        host: r.host,
        solami: r.solami,
        calls: r.calls,
        errors: r.errors,
        rateLimited: r.rateLimited,
        p50Ms: r.p50Ms,
        p95Ms: r.p95Ms,
        methods: (r.methods ?? []).map((m) => ({
          method: m.method,
          calls: m.calls,
          errors: m.errors,
          rateLimited: m.rateLimited,
          p50Ms: m.p50Ms,
          p95Ms: m.p95Ms,
        })),
      })),
    );
    const beam: SolamiBeamUsage[] = entries
      .filter((e) => e.report.beam)
      .map(({ name, report }) => {
        const b = report.beam as NonNullable<SolamiUsageReport['beam']>;
        return {
          component: name,
          sends: b.sends,
          landed: b.landed,
          failed: b.failed,
          fallbacks: b.fallbacks,
          tipLamports: b.tipLamports,
          tipsSpentLamports: b.tipsSpentLamports,
          tipsSpentSol: round(b.tipsSpentLamports / LAMPORTS_PER_SOL, 6),
          tipSource: b.tipSource,
          lastSignature: b.lastSignature,
          lastLandedAt: b.lastLandedAt ? isoIst(new Date(b.lastLandedAt)) : null,
        };
      });
    const sum = (pick: (b: SolamiBeamUsage) => number) => beam.reduce((total, b) => total + pick(b), 0);
    const tipsSpentLamports = sum((b) => b.tipsSpentLamports);
    const lastError = entries
      .filter((e) => e.report.lastError)
      .map(({ name, report }) => ({
        component: name,
        ...(report.lastError as NonNullable<SolamiUsageReport['lastError']>),
      }))
      .sort((a, b) => b.at - a.at)[0];

    const fresh = entries.filter((e) => !e.stale);
    const inUse = [
      fresh.some((e) => e.report.grpc && e.report.grpc.status !== 'off') ? 'grpc' : null,
      fresh.some((e) => (e.report.rpc ?? []).some((r) => r.solami && r.calls > 0)) ? 'rpc' : null,
      fresh.some((e) => (e.report.beam?.sends ?? 0) > 0) ? 'beam' : null,
    ].filter((product): product is string => product !== null);

    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(new Date(now)),
      source: 'solami_usage (indexer_app, publisher_app, cranks_app) + api_app’s own counters',
      inUse,
      components: entries.map(({ name, updatedAt, stale, report }) => ({
        name,
        updatedAt: isoIst(new Date(updatedAt)),
        stale,
        startedAt: isoIst(new Date(report.startedAt)),
      })),
      grpc,
      rpc,
      beam,
      beamTotals: {
        sends: sum((b) => b.sends),
        landed: sum((b) => b.landed),
        failed: sum((b) => b.failed),
        tipsSpentLamports,
        tipsSpentSol: round(tipsSpentLamports / LAMPORTS_PER_SOL, 6),
      },
      lastError: lastError
        ? {
            component: lastError.component,
            product: lastError.product,
            message: lastError.message,
            at: isoIst(new Date(lastError.at)),
          }
        : null,
      ...(rows.length === 0
        ? { note: 'No component has written solami_usage yet: start indexer_app (and publisher_app / cranks_app).' }
        : {}),
    };
  }

  /** A WS `slots` frame from the indexer's NOTIFY payload. */
  async slotFromPayload(payload: LiveSlotPayload): Promise<LiveSlot> {
    const names = await this.names();
    return {
      slot: payload.slot,
      epoch: payload.epoch,
      leader: payload.leader,
      leaderName: names.byIdentity.get(payload.leader) ?? null,
      medianCuPrice: payload.medianCuPrice,
      p25CuPrice: payload.p25CuPrice,
      p75CuPrice: payload.p75CuPrice,
      p90CuPrice: payload.p90CuPrice,
      pricedTxs: payload.pricedTxs,
      unpricedTxs: payload.unpricedTxs,
      leaderPaidTxs: payload.leaderPaidTxs,
      failedTxs: payload.failedTxs,
      time: payload.blockTime !== null ? isoIst(new Date(payload.blockTime * 1000)) : null,
      source: payload.source,
    };
  }

  private names(): Promise<NameIndex> {
    return this.deps.names().catch(() => EMPTY_NAMES);
  }

  private slotFromRow(r: LiveSlotRow, names: NameIndex): LiveSlot {
    return {
      slot: r.slot,
      epoch: r.epoch,
      leader: r.leader,
      leaderName: names.byIdentity.get(r.leader) ?? null,
      medianCuPrice: toNumber(r.medianCuPrice),
      p25CuPrice: toNumber(r.p25CuPrice),
      p75CuPrice: toNumber(r.p75CuPrice),
      p90CuPrice: toNumber(r.p90CuPrice),
      pricedTxs: r.pricedTxs,
      unpricedTxs: r.unpricedTxs,
      leaderPaidTxs: r.leaderPaidTxs,
      failedTxs: r.failedTxs,
      time: ist(r.blockTime),
      source: r.source,
    };
  }

  private dataSourceLabel(source: LiveSource | null, endpoint: string | null): string {
    if (!source) return 'Solami gRPC (Yellowstone)';
    if (source === 'rpc') return `${SOURCE_LABEL.rpc}${endpoint ? ` (${endpoint})` : ''}`;
    if (endpoint === 'rpc-fast') return 'RPC Fast gRPC (failover)';
    return SOURCE_LABEL[source];
  }

  private stream(row: FeeIndexLiveRow | null, live: boolean): LiveSummary['stream'] {
    if (!row) {
      return {
        source: null,
        endpoint: null,
        status: 'offline',
        lastSlotAt: null,
        secondsSinceLastSlot: null,
        indexerSeenAt: null,
        gapSlots: 0,
        catchingUp: false,
      };
    }
    const fresh = this.now() - row.updatedAt.getTime() <= this.deps.staleAfterMs;
    const gapSlots =
      row.processedSlot !== null && row.watermarkSlot !== null ? Math.max(0, row.processedSlot - row.watermarkSlot) : 0;
    return {
      source: row.source as LiveSource,
      endpoint: row.endpoint,
      status: fresh ? (row.status as LiveStreamStatus) : 'offline',
      lastSlotAt: ist(row.lastSlotAt),
      secondsSinceLastSlot: row.lastSlotAt ? Math.round((this.now() - row.lastSlotAt.getTime()) / 1000) : null,
      indexerSeenAt: ist(row.updatedAt),
      gapSlots,
      catchingUp: live && gapSlots > CATCHING_UP_SLOTS,
    };
  }

  private estimate(row: FeeIndexLiveRow, epoch: LiveSummary['epoch']): LiveEstimate {
    let coveragePct: number | null = null;
    if (epoch && row.epoch === epoch.number && row.firstSlot !== null && row.processedSlot !== null) {
      const covered = Math.min(row.processedSlot, epoch.firstSlot + epoch.slotsInEpoch - 1) - row.firstSlot + 1;
      coveragePct = round(Math.max(0, Math.min(100, (covered / (epoch.slotIndex + 1)) * 100)), 1);
    }
    return {
      epoch: row.epoch,
      value: row.estimate,
      leaders: row.leaders,
      slotsWithFees: row.slotsWithFees,
      pricedTxs: row.pricedTxs,
      coverageFromSlot: row.firstSlot,
      coveragePct,
      stakeEpoch: row.stakeEpoch,
      sampled: row.stride > 1,
    };
  }
}
