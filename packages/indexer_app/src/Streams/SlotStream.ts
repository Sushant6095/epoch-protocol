import { sleep } from '@epoch/common';
import { Logger } from '@epoch/logger';
import { type LiveIndexPayload, type LiveSlotPayload } from '@epoch/pg_models';
import {
  explainSolamiError,
  type GrpcEndpoint,
  GrpcStream,
  type GrpcStreamOptions,
  type GrpcStreamState,
  SlotStatus,
  type SolamiUsage,
  solamiUsage,
  type SubscribeContext,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@epoch/solana';

import { blockFees, type DecodedBlock } from '../Blocks/BlockFees';
import { GrpcBlockAssembler } from '../Blocks/GrpcBlockAssembler';
import { LeaderResolver, LeaderSchedule } from '../Chain/LeaderSchedule';
import { fetchStakeSnapshot, type StakeSnapshot } from '../Chain/StakeSnapshots';
import { EpochTracker, rollupRows } from '../Processors/EpochTracker';
import { type IndexerCursor, type IndexerStore, type SlotRecord, type SlotSource } from '../Repositories/IndexerStore';
import { type RpcEpochSchedule, type SolanaRpc } from '../Rpc/SolanaRpc';
import { BlockFetcher, type FetchResult, RateLimiter } from './BlockFetcher';
import {
  isAuthRefused,
  isFirehoseRefused,
  isRequestRefused,
  replayFrom,
  slotStreamRequest,
  type StreamKind,
} from './SlotRequest';
import { SlotWatermark } from './SlotWatermark';

const logger = Logger.create('SlotStream');

export type SlotSourceMode = 'auto' | 'grpc' | 'hybrid' | 'rpc';
type LiveMode = 'grpc' | 'hybrid' | 'rpc';
export type StreamStatus = 'connecting' | 'streaming' | 'reconnecting' | 'polling' | 'stopped';

/** A slot the live source should have delivered this long ago is the gap filler's (≈ 60 s). */
const GAP_GRACE_SLOTS = 150;
/** After this many failed fetches a slot is given up on (logged; treated like a skipped slot). */
const MAX_SLOT_ATTEMPTS = 20;
/** Hybrid fetches queued before the stream waits for them (backpressure on the meta stream). */
const MAX_HYBRID_QUEUE = 64;
/** Live blocks (hybrid, rpc) have their own RPC budget, so a long gap fill never delays them (~2.4 blocks/s). */
const LIVE_FETCH_RPS = 20;
const LIVE_FETCH_CONCURRENCY = 8;
const FLUSH_MS = 500;
const PRUNE_MS = 300_000;
/** slot_fee_mix epochs kept when the options do not say (epoch_fee_mix keeps the totals). */
const DEFAULT_FEE_MIX_KEEP_EPOCHS = 3;
/** How often lag and the running estimate are logged at info level. */
const STATUS_LOG_MS = 60_000;
/** How often this process's Solami usage is written to solami_usage. */
const USAGE_WRITE_MS = 10_000;

export type IndexerRpc = Pick<
  SolanaRpc,
  'getSlot' | 'getEpochInfo' | 'getEpochSchedule' | 'getBlock' | 'getSlotLeaders' | 'getVoteAccounts' | 'host'
>;

export interface GrpcStreamLike {
  run(
    build: (context: SubscribeContext) => SubscribeRequest,
    onUpdate: (update: SubscribeUpdate) => Promise<void> | void,
  ): Promise<void>;
  stop(): void;
}

export interface SlotStreamOptions {
  mode: SlotSourceMode;
  /** Solami first; empty when there is no gRPC key. */
  endpoints: GrpcEndpoint[];
  compression?: 'zstd' | 'gzip';
  backfillEpoch: boolean;
  gapFillRps: number;
  gapFillConcurrency: number;
  gapFillMaxSlots: number;
  rpcPollMs: number;
  /** rpc mode only: process one slot in N (no cursor, gap fill or final value). */
  stride: number;
  liveIntervalMs: number;
  liveSlotsKeep: number;
  /** Epochs of slot_fee_mix rows kept. Default 3. */
  feeMixKeepEpochs?: number;
  /** Flush and gap-fill ticks (tests shorten them). Default 500 ms. */
  tickMs?: number;
}

export interface SlotStreamDeps {
  rpc: IndexerRpc;
  store: IndexerStore;
  createGrpcStream?: (endpoints: GrpcEndpoint[], options: GrpcStreamOptions) => GrpcStreamLike;
  /** Solami usage counters (gRPC, and the RPC client's own). Default: this process's `solamiUsage`. */
  usage?: SolamiUsage;
  now?: () => number;
}

/** What the stream exposes for logs, the heartbeat and the check script. */
export interface SlotStreamStats {
  source: LiveMode | null;
  status: StreamStatus;
  endpoint: string | null;
  tipSlot: number | null;
  processedSlot: number | null;
  watermark: number | null;
  lagSlots: number | null;
  gapSlots: number;
  lostSlots: number;
  lateTransactions: number;
  leaderFromRewards: number;
}

class EpochMath {
  constructor(private readonly schedule: RpcEpochSchedule) {}

  epochOf(slot: number): number {
    const { slotsPerEpoch, firstNormalSlot, firstNormalEpoch } = this.schedule;
    if (slot < firstNormalSlot) throw new Error('warm-up epochs are not supported (mainnet has none)');
    return firstNormalEpoch + Math.floor((slot - firstNormalSlot) / slotsPerEpoch);
  }

  firstSlot(epoch: number): number {
    const { slotsPerEpoch, firstNormalSlot, firstNormalEpoch } = this.schedule;
    return firstNormalSlot + (epoch - firstNormalEpoch) * slotsPerEpoch;
  }

  lastSlot(epoch: number): number {
    return this.firstSlot(epoch + 1) - 1;
  }
}

/**
 * The live Fee Index pipeline (plan feature F4):
 *
 *   Solami gRPC (or RPC) → blocks → per-slot median (BlockFees) → slot_fees + live_slots + NOTIFY (one transaction)
 *                                  → EpochTracker (running estimate → fee_index_live every LIVE_INDEX_INTERVAL_MS)
 *   watermark crosses an epoch end, epoch fully covered → rollup from slot_fees → epoch_index (→ publisher_app)
 *
 * Sources: `grpc` (firehose of non-vote transactions + block meta), `hybrid` (block meta over gRPC, each block via RPC),
 * `rpc` (polling). A reconnect resumes with `fromSlot` inside the endpoint's replay window; anything older, and any
 * slot the source never delivered, is fetched by the gap filler over RPC (bounded, rate-limited), so every slot of a
 * covered epoch is accounted for: indexed, or confirmed to have no block.
 */
export class SlotStream {
  private readonly rpc: IndexerRpc;
  private readonly store: IndexerStore;
  private readonly now: () => number;
  private readonly schedule: LeaderSchedule;
  private readonly resolver: LeaderResolver;
  /** Gap fill (GAP_FILL_RPS). */
  private readonly fetcher: BlockFetcher;
  /** The hybrid and rpc live sources. */
  private readonly liveFetcher: BlockFetcher;
  private readonly assembler = new GrpcBlockAssembler();
  private readonly tracker = new EpochTracker();

  private epochs?: EpochMath;
  private watermark?: SlotWatermark;
  /** A new live run: it starts at the first slot the live source delivers. */
  private freshRun = false;
  private stopped = false;
  private grpc?: GrpcStreamLike;
  private mode: LiveMode | null = null;
  private status: StreamStatus = 'connecting';
  private endpoint: string | null = null;

  /** First slot the current live source is responsible for (everything below is the gap filler's). */
  private streamStart?: number;
  private streamStartPending = false;
  private lastLiveSlot?: number;
  private lastSlotAt?: number;
  private tipSlot?: number;
  /** Consecutive connections that asked for `fromSlot` and got no data: after two, subscribe live instead. */
  private replayFailures = 0;
  private triedFromSlot = false;
  private deliveredSinceBuild = false;

  private readonly stakes = new Map<number, StakeSnapshot>();
  private latestVotes: ReadonlyMap<string, string> = new Map();
  private readonly stakeLoads = new Map<number, Promise<void>>();

  private queue: SlotRecord[] = [];
  private notifyQueue: LiveSlotPayload[] = [];
  private flushing?: Promise<void>;
  private persistedWatermark?: number;
  /** Every slot being fetched (gap fill and live), so no slot is fetched twice at once. */
  private readonly inflight = new Set<number>();
  /** Live fetches only: RPC polling caps on this, never on a gap-fill batch waiting for its own limiter. */
  private liveInflight = 0;
  private readonly attempts = new Map<number, number>();
  private readonly hybridPending = new Set<Promise<void>>();
  private readonly rolledUp = new Set<number>();
  /** Epochs below this were rolled up by an earlier run (set when resuming a cursor). */
  private rollupFloor = -1;
  private readonly incompleteLogged = new Set<number>();
  private readonly lostByEpoch = new Map<number, number>();
  private rollupRunning = false;
  private timers: NodeJS.Timeout[] = [];
  private lastPublish = 0;
  private lastPrune = 0;
  private lastStatusLog = 0;

  constructor(
    private readonly options: SlotStreamOptions,
    deps: SlotStreamDeps,
  ) {
    this.rpc = deps.rpc;
    this.store = deps.store;
    this.usage = deps.usage ?? solamiUsage;
    this.now = deps.now ?? Date.now;
    this.createGrpc =
      deps.createGrpcStream ?? ((endpoints, grpcOptions) => new GrpcStream(endpoints, grpcOptions) as GrpcStreamLike);
    this.schedule = new LeaderSchedule(this.rpc, this.now);
    this.resolver = new LeaderResolver(this.schedule, () => this.latestVotes);
    this.fetcher = new BlockFetcher(
      this.rpc,
      new RateLimiter(options.gapFillRps, options.gapFillConcurrency, this.now),
    );
    this.liveFetcher = new BlockFetcher(this.rpc, new RateLimiter(LIVE_FETCH_RPS, LIVE_FETCH_CONCURRENCY, this.now));
  }

  private readonly createGrpc: (endpoints: GrpcEndpoint[], options: GrpcStreamOptions) => GrpcStreamLike;
  private readonly usage: SolamiUsage;
  private lastUsageWrite = 0;

  get stats(): SlotStreamStats {
    const processed = this.lastLiveSlot ?? null;
    return {
      source: this.mode,
      status: this.status,
      endpoint: this.endpoint,
      tipSlot: this.tipSlot ?? null,
      processedSlot: processed,
      watermark: this.watermark?.watermark ?? null,
      lagSlots: this.tipSlot !== undefined && processed !== null ? Math.max(0, this.tipSlot - processed) : null,
      gapSlots: this.watermark && processed !== null ? Math.max(0, processed - this.watermark.watermark) : 0,
      lostSlots: [...this.lostByEpoch.values()].reduce((a, b) => a + b, 0),
      lateTransactions: this.assembler.lateTransactions,
      leaderFromRewards: this.resolver.fromRewards,
    };
  }

  /** Runs until `stop()`. Rejects only when every source is refused (wrong key and no fallback). */
  async run(): Promise<void> {
    await this.init();
    const tick = this.options.tickMs ?? FLUSH_MS;
    this.timers.push(setInterval(() => void this.flush(), tick));
    this.timers.push(setInterval(() => void this.heartbeat(), this.options.liveIntervalMs));
    if (this.options.stride === 1) this.timers.push(setInterval(() => void this.fillGaps(), tick * 2));
    for (const timer of this.timers) timer.unref();
    try {
      await this.runLive();
    } finally {
      await this.shutdown();
    }
  }

  stop(): void {
    this.stopped = true;
    this.grpc?.stop();
  }

  // ── Start-up ──────────────────────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    const schedule = await this.rpc.getEpochSchedule().catch((error: unknown) => {
      logger.warn('getEpochSchedule failed; assuming mainnet (432,000 slots per epoch)', { error: String(error) });
      return { slotsPerEpoch: 432_000, firstNormalEpoch: 0, firstNormalSlot: 0 };
    });
    this.epochs = new EpochMath(schedule);
    const info = await this.rpc.getEpochInfo();
    this.tipSlot = info.absoluteSlot;
    const epoch = info.epoch;

    if (this.options.stride === 1) {
      const cursor = await this.store.readCursor();
      this.watermark = this.startRun(cursor, info.absoluteSlot);
      this.freshRun = this.watermark === undefined;
      this.persistedWatermark = cursor?.watermark;
      // A resumed run already rolled up everything before the epoch its cursor ended in (that one is retried).
      if (cursor && this.watermark?.runStart === cursor.runStart) {
        this.rollupFloor = this.epochs.epochOf(cursor.watermark + 1) - 1;
      }
    }
    // The epoch in progress: what is already stored, then its stake snapshot.
    this.tracker.begin(epoch, await this.store.epochRows(epoch));
    await this.loadStakes(epoch, true);
    this.schedule.leaderOf(info.absoluteSlot);
    logger.info('indexer ready', {
      epoch,
      tipSlot: info.absoluteSlot,
      runStart: this.watermark?.runStart ?? null,
      watermark: this.watermark?.watermark ?? null,
      storedSlotsThisEpoch: this.tracker.medians?.slotCount ?? 0,
      mode: this.options.mode,
      stride: this.options.stride,
      rpc: this.rpc.host,
    });
  }

  private startRun(cursor: IndexerCursor | null, tip: number): SlotWatermark | undefined {
    const epochs = this.epochs as EpochMath;
    if (cursor && tip - cursor.watermark <= this.options.gapFillMaxSlots) {
      logger.info('resuming from the saved cursor', { ...cursor, behindSlots: tip - cursor.watermark });
      return new SlotWatermark(cursor.runStart, cursor.watermark);
    }
    if (cursor) {
      logger.warn('saved cursor too far behind; starting a new run (that gap stays unfilled)', {
        watermark: cursor.watermark,
        behindSlots: tip - cursor.watermark,
        maxSlots: this.options.gapFillMaxSlots,
      });
    }
    if (this.options.backfillEpoch) {
      const start = epochs.firstSlot(epochs.epochOf(tip));
      logger.info('backfilling the current epoch from its first slot', { start, slots: tip - start });
      return new SlotWatermark(start);
    }
    // Live from here: the run starts at the first slot the live source delivers.
    return undefined;
  }

  // ── Live sources ──────────────────────────────────────────────────────────────────────────────

  private initialMode(): LiveMode {
    const { mode, endpoints } = this.options;
    if (mode !== 'auto') return mode;
    if (endpoints.length === 0 || !endpoints[0].token) {
      logger.warn('no SOLAMI_TOKEN: using RPC polling (set SOLAMI_TOKEN to stream over Solami gRPC)');
      return 'rpc';
    }
    return 'grpc';
  }

  private async runLive(): Promise<void> {
    let mode = this.initialMode();
    while (!this.stopped) {
      this.mode = mode;
      try {
        if (mode === 'rpc') await this.runRpcPolling();
        else await this.runGrpc(mode === 'grpc' ? 'firehose' : 'meta');
        return;
      } catch (error) {
        if (this.stopped) return;
        const { hint } = explainSolamiError('grpc', error);
        if (this.options.mode === 'auto' && mode === 'grpc' && isFirehoseRefused(error)) {
          logger.warn('Solami refused the transaction firehose on this key: switching to hybrid', { hint });
          mode = 'hybrid';
          continue;
        }
        if (this.options.mode === 'auto' && isAuthRefused(error)) {
          logger.error('the gRPC key was refused; switching to RPC polling', undefined, { hint });
          mode = 'rpc';
          continue;
        }
        logger.error('the gRPC stream was refused', undefined, { hint });
        throw error;
      }
    }
  }

  private async runGrpc(kind: StreamKind): Promise<void> {
    if (this.options.endpoints.length === 0) throw new Error('gRPC mode needs SOLAMI_GRPC_URL and SOLAMI_TOKEN');
    const stream = this.createGrpc(this.options.endpoints, {
      compression: this.options.compression,
      isFatal: isRequestRefused,
      onState: (state) => this.onGrpcState(state),
      usage: this.usage,
      subscription: kind,
    });
    this.grpc = stream;
    if (this.stopped) stream.stop();
    await stream.run(
      (context) => this.buildRequest(kind, context),
      (update) => this.onGrpcUpdate(kind, update),
    );
  }

  private buildRequest(kind: StreamKind, context: SubscribeContext): SubscribeRequest {
    // A reconnect: partial slots are replayed (or gap-filled), never half-counted.
    this.assembler.reset();
    if (this.deliveredSinceBuild) this.replayFailures = 0;
    else if (this.triedFromSlot) this.replayFailures++;
    this.deliveredSinceBuild = false;
    const want = this.resumeSlot();
    const fromSlot = this.replayFailures >= 2 ? undefined : replayFrom(want, context.firstAvailableSlot, this.tipSlot);
    this.triedFromSlot = fromSlot !== undefined;
    this.streamStart = fromSlot;
    this.streamStartPending = fromSlot === undefined;
    if (want !== undefined && fromSlot === undefined) {
      logger.info('subscribing live; older slots go to the gap filler', {
        resumeSlot: want,
        firstAvailableSlot: context.firstAvailableSlot ?? null,
      });
    }
    return slotStreamRequest(kind, fromSlot);
  }

  /** The next slot the live source should deliver; undefined on a fresh run (start live, gap-fill any start). */
  private resumeSlot(): number | undefined {
    if (this.lastLiveSlot !== undefined) return this.lastLiveSlot + 1;
    if (this.watermark && this.watermark.watermark >= this.watermark.runStart) return this.watermark.watermark + 1;
    return undefined;
  }

  private onGrpcState(state: GrpcStreamState): void {
    this.endpoint = state.endpoint;
    if (state.status !== 'stopped' || this.stopped) this.status = state.status;
  }

  private async onGrpcUpdate(kind: StreamKind, update: SubscribeUpdate): Promise<void> {
    this.deliveredSinceBuild = true;
    if (update.slot) {
      const slot = Number(update.slot.slot);
      if (update.slot.status === SlotStatus.SLOT_PROCESSED || update.slot.status === SlotStatus.SLOT_CONFIRMED) {
        if (this.tipSlot === undefined || slot > this.tipSlot) this.tipSlot = slot;
      }
      return;
    }
    if (update.transaction) {
      if (kind === 'firehose') this.assembler.addTransaction(update.transaction);
      return;
    }
    const meta = update.blockMeta;
    if (!meta) return;
    const slot = Number(meta.slot);
    this.noteStreamStart(slot);
    if (kind === 'firehose') {
      const lost = this.assembler.dropBefore(slot - GAP_GRACE_SLOTS);
      if (lost.length > 0) logger.warn('block meta never arrived; leaving these slots to the gap filler', { lost });
      await this.ingest(this.assembler.completeBlock(meta), 'grpc');
      return;
    }
    // hybrid: the stream says the block is confirmed; its transactions come from RPC.
    this.markSkippedBetween(Number(meta.parentSlot), slot);
    this.lastLiveSlot = Math.max(this.lastLiveSlot ?? 0, slot);
    if (this.hybridPending.size >= MAX_HYBRID_QUEUE) await Promise.race(this.hybridPending);
    const pending: Promise<void> = this.fetchAndIngest(slot, 'hybrid').finally(() =>
      this.hybridPending.delete(pending),
    );
    this.hybridPending.add(pending);
  }

  private noteStreamStart(slot: number): void {
    if (!this.watermark && this.freshRun) {
      this.watermark = new SlotWatermark(slot);
      logger.info('new run', { runStart: slot });
    }
    if (!this.streamStartPending) return;
    this.streamStart = slot;
    this.streamStartPending = false;
  }

  private async runRpcPolling(): Promise<void> {
    this.status = 'polling';
    this.endpoint = this.rpc.host;
    this.usage.grpc({ status: 'off', lagSlots: null });
    const { stride, rpcPollMs } = this.options;
    let next: number | undefined;
    while (!this.stopped) {
      try {
        const tip = await this.rpc.getSlot('confirmed');
        this.tipSlot = tip;
        if (next === undefined) {
          const resume = this.resumeSlot();
          next = resume !== undefined && tip - resume < GAP_GRACE_SLOTS ? resume : tip;
          if (stride > 1) next = next - (next % stride) + stride;
          this.streamStart = next;
          this.noteStreamStart(next);
        }
        while (next <= tip && this.liveInflight < LIVE_FETCH_CONCURRENCY * 2 && !this.stopped) {
          const slot = next;
          next += stride;
          if (this.watermark?.isDone(slot) && stride === 1) continue;
          void this.fetchAndIngest(slot, 'rpc');
        }
      } catch (error) {
        logger.warn('rpc poll failed', { error: String(error) });
      }
      await sleep(rpcPollMs);
    }
  }

  // ── Blocks ────────────────────────────────────────────────────────────────────────────────────

  private async fetchAndIngest(slot: number, source: SlotSource): Promise<void> {
    if (this.inflight.has(slot)) return;
    this.inflight.add(slot);
    const live = source !== 'gap-fill';
    if (live) this.liveInflight++;
    try {
      const result: FetchResult = await (source === 'gap-fill' ? this.fetcher : this.liveFetcher).fetch(slot);
      if (result.kind === 'skipped') {
        this.markDone(slot);
        if (source !== 'gap-fill') this.noteLive(slot);
      } else {
        await this.ingest(result.block, source);
      }
      this.attempts.delete(slot);
    } catch (error) {
      const attempts = (this.attempts.get(slot) ?? 0) + 1;
      this.attempts.set(slot, attempts);
      if (attempts >= MAX_SLOT_ATTEMPTS && this.options.stride === 1) {
        logger.error('giving up on a slot after repeated failures; treated as having no block', error, { slot });
        const epoch = (this.epochs as EpochMath).epochOf(slot);
        this.lostByEpoch.set(epoch, (this.lostByEpoch.get(epoch) ?? 0) + 1);
        this.attempts.delete(slot);
        this.markDone(slot);
      } else {
        logger.debug('block fetch failed; will retry', { slot, attempts, error: String(error) });
      }
    } finally {
      this.inflight.delete(slot);
      if (live) this.liveInflight--;
    }
  }

  private async ingest(block: DecodedBlock, source: SlotSource): Promise<void> {
    const { slot } = block;
    const epochs = this.epochs as EpochMath;
    if (this.options.stride === 1 && this.watermark?.isDone(slot)) {
      if (source !== 'gap-fill') this.noteLive(slot);
      return;
    }
    const leader =
      this.resolver.now(slot, block.rewardPubkey) ?? (await this.resolver.resolve(slot, block.rewardPubkey));
    if (!leader) {
      logger.warn('no leader for this slot yet (schedule and rewards both missing); retrying later', { slot });
      return;
    }
    const fees = blockFees(slot, leader, block.txs);
    const epoch = epochs.epochOf(slot);
    // The live source entering a new epoch starts its tracker before the slot is counted.
    if (source !== 'gap-fill' && epoch > (this.tracker.epoch ?? -1)) await this.beginEpoch(epoch);
    this.markSkippedBetween(block.parentSlot, slot);
    this.markDone(slot);
    if (fees.medianCuPrice !== null) {
      this.tracker.add({ slot, epoch, leader, medianCuPrice: fees.medianCuPrice, txCount: fees.pricedTxs });
    }
    this.queue.push({ fees, epoch, blockTime: block.blockTime, source, feeMix: block.feeMix });
    if (source !== 'gap-fill') {
      this.noteLive(slot);
      this.notifyQueue.push({
        t: 'slot',
        slot,
        epoch,
        leader,
        medianCuPrice: fees.medianCuPrice,
        p25CuPrice: fees.p25CuPrice,
        p75CuPrice: fees.p75CuPrice,
        p90CuPrice: fees.p90CuPrice,
        pricedTxs: fees.pricedTxs,
        unpricedTxs: fees.unpricedTxs,
        leaderPaidTxs: fees.leaderPaidTxs,
        failedTxs: fees.failedTxs,
        blockTime: block.blockTime,
        source,
        fees: {
          baseLamports: Number(block.feeMix.baseLamports),
          priorityLamports: Number(block.feeMix.priorityLamports),
          tipsLamports: Number(block.feeMix.tipLamports),
          tipTxs: block.feeMix.tipTxs,
          rewardLamports: block.feeMix.feeRewardLamports === null ? null : Number(block.feeMix.feeRewardLamports),
          basis: block.feeMix.baseFeeBasis,
        },
      });
    }
  }

  private noteLive(slot: number): void {
    if (this.lastLiveSlot === undefined || slot > this.lastLiveSlot) this.lastLiveSlot = slot;
    this.lastSlotAt = this.now();
  }

  private markDone(slot: number): void {
    this.watermark?.markDone(slot);
  }

  /** Slots between a block and its parent have no block on the confirmed chain. */
  private markSkippedBetween(parentSlot: number, slot: number): void {
    if (this.watermark && slot - parentSlot > 1) this.watermark.markRange(parentSlot + 1, slot - 1);
  }

  // ── Epochs and stakes ─────────────────────────────────────────────────────────────────────────

  private async beginEpoch(epoch: number): Promise<void> {
    logger.info('new epoch', { epoch, previous: this.tracker.epoch ?? null });
    this.tracker.begin(epoch, await this.store.epochRows(epoch).catch(() => []));
    void this.loadStakes(epoch, true);
  }

  /** The stake snapshot of `epoch`: from Postgres, else getVoteAccounts (only valid while `epoch` is current). */
  private loadStakes(epoch: number, fetchIfMissing: boolean): Promise<void> {
    const running = this.stakeLoads.get(epoch);
    if (running) return running;
    const load = (async () => {
      for (let attempt = 0; !this.stopped; attempt++) {
        try {
          const stored = await this.store.stakesFor(epoch);
          if (stored && stored.epoch === epoch) {
            this.stakes.set(epoch, { epoch, byIdentity: stored.stakes, voteToIdentity: new Map() });
          }
          if (fetchIfMissing) {
            const snapshot = await fetchStakeSnapshot(this.rpc, epoch);
            this.latestVotes = snapshot.voteToIdentity;
            if (!stored || stored.epoch !== epoch) {
              await this.store.saveStakes(epoch, snapshot.byIdentity);
              logger.info('stake snapshot saved', { epoch, identities: snapshot.byIdentity.size });
            }
            this.stakes.set(epoch, this.stakes.get(epoch) ?? snapshot);
          }
          return;
        } catch (error) {
          logger.warn('stake snapshot failed; retrying', { epoch, attempt, error: String(error) });
          await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        }
      }
    })().finally(() => this.stakeLoads.delete(epoch));
    this.stakeLoads.set(epoch, load);
    return load;
  }

  /** After a committed batch: roll up every finished epoch the run covers completely. */
  private async checkRollups(committed: number): Promise<void> {
    if (this.rollupRunning || !this.watermark || this.options.stride !== 1) return;
    const epochs = this.epochs as EpochMath;
    const first = Math.max(epochs.epochOf(this.watermark.runStart), this.rollupFloor);
    const lastFinished = epochs.epochOf(committed + 1) - 1;
    this.rollupRunning = true;
    try {
      for (let epoch = first; epoch <= lastFinished; epoch++) {
        if (this.rolledUp.has(epoch)) continue;
        if (!this.watermark.covers(epochs.firstSlot(epoch), epochs.lastSlot(epoch))) {
          if (!this.incompleteLogged.has(epoch)) {
            this.incompleteLogged.add(epoch);
            logger.warn('epoch only partly indexed (the run started inside it): no epoch_index value', {
              epoch,
              runStart: this.watermark.runStart,
              epochFirstSlot: epochs.firstSlot(epoch),
            });
          }
          this.rolledUp.add(epoch);
          continue;
        }
        await this.rollup(epoch);
        this.rolledUp.add(epoch);
      }
    } catch (error) {
      logger.error('epoch rollup failed; retrying after the next batch', error);
    } finally {
      this.rollupRunning = false;
    }
  }

  private async rollup(epoch: number): Promise<void> {
    const rows = await this.store.epochRows(epoch);
    let stakes = await this.store.stakesFor(epoch);
    if (!stakes) {
      // Nothing from this epoch or later is stored: today's distribution is the closest there is.
      const current = (await this.rpc.getEpochInfo()).epoch;
      const snapshot = await fetchStakeSnapshot(this.rpc, current);
      await this.store.saveStakes(current, snapshot.byIdentity);
      stakes = { epoch: current, stakes: snapshot.byIdentity };
    }
    if (stakes.epoch !== epoch) {
      logger.warn('no stake snapshot from inside this epoch; weighting with a later one', {
        epoch,
        stakeEpoch: stakes.epoch,
      });
    }
    const result = rollupRows(rows, stakes.stakes);
    if (result.value === null) {
      logger.error('epoch has no priced slots with staked leaders: no index value', undefined, { epoch });
      return;
    }
    const outcome = await this.store.writeEpochIndex(epoch, result.value);
    logger.info('epoch rolled up', {
      epoch,
      value: result.value,
      setter: result.setter,
      leaders: result.leaders,
      stakedLeaders: result.stakedLeaders,
      slots: result.slots,
      pricedTxs: result.txCount,
      stakeEpoch: stakes.epoch,
      lostSlots: this.lostByEpoch.get(epoch) ?? 0,
      epochIndex: outcome,
    });
  }

  // ── Gap fill ──────────────────────────────────────────────────────────────────────────────────

  private gapFilling = false;

  private async fillGaps(): Promise<void> {
    const watermark = this.watermark;
    if (this.gapFilling || this.stopped || !watermark) return;
    const ceilings: number[] = [];
    if (this.streamStart !== undefined) ceilings.push(this.streamStart - 1);
    if (watermark.highestDone > watermark.watermark) ceilings.push(watermark.highestDone - GAP_GRACE_SLOTS);
    if (ceilings.length === 0) return;
    const ceiling = Math.max(...ceilings);
    const slots = watermark
      .missing(ceiling, this.options.gapFillConcurrency * 8)
      .filter((slot) => !this.inflight.has(slot));
    if (slots.length === 0) return;
    this.gapFilling = true;
    try {
      await Promise.all(slots.map((slot) => this.fetchAndIngest(slot, 'gap-fill')));
    } finally {
      this.gapFilling = false;
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────────────────────────

  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const records = this.queue.splice(0);
    const notify = this.notifyQueue.splice(0);
    const cursor =
      this.watermark && this.options.stride === 1 && this.watermark.watermark >= this.watermark.runStart
        ? { watermark: this.watermark.watermark, runStart: this.watermark.runStart }
        : undefined;
    const cursorMoved = cursor !== undefined && cursor.watermark !== this.persistedWatermark;
    if (records.length === 0 && !cursorMoved) return;
    try {
      await this.store.writeBatch({ records, notify, cursor: cursorMoved ? cursor : undefined });
      if (cursorMoved) {
        this.persistedWatermark = cursor.watermark;
        await this.checkRollups(cursor.watermark);
      }
    } catch (error) {
      logger.error('database write failed; keeping the batch for the next flush', error, { slots: records.length });
      this.queue.unshift(...records);
      // Late notifications are worse than none: a retried batch is not re-announced.
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.now() - this.lastPublish < this.options.liveIntervalMs / 2) return;
    this.lastPublish = this.now();
    const live = this.livePayload();
    try {
      await this.store.writeLive(live);
    } catch (error) {
      logger.warn('fee_index_live write failed', { error: String(error) });
    }
    if (this.now() - this.lastStatusLog >= STATUS_LOG_MS) {
      this.lastStatusLog = this.now();
      const stats = this.stats;
      logger.info('status', {
        source: stats.source,
        status: stats.status,
        endpoint: stats.endpoint,
        tipSlot: stats.tipSlot,
        processedSlot: stats.processedSlot,
        lagSlots: stats.lagSlots,
        gapSlots: stats.gapSlots,
        epoch: live.epoch,
        estimate: live.estimate,
        slotsWithFees: live.slotsWithFees,
        lostSlots: stats.lostSlots,
      });
    }
    if (this.mode && this.mode !== 'rpc') this.usage.grpc({ lagSlots: this.stats.lagSlots });
    if (this.now() - this.lastUsageWrite >= USAGE_WRITE_MS) {
      this.lastUsageWrite = this.now();
      this.store.writeUsage(this.usage.report()).catch((error: unknown) => {
        logger.debug('solami_usage write failed', { error: String(error) });
      });
    }
    if (this.now() - this.lastPrune > PRUNE_MS) {
      this.lastPrune = this.now();
      this.store.pruneLiveSlots(this.options.liveSlotsKeep).catch((error: unknown) => {
        logger.warn('live_slots prune failed', { error: String(error) });
      });
      this.store.pruneFeeMix(this.options.feeMixKeepEpochs ?? DEFAULT_FEE_MIX_KEEP_EPOCHS).catch((error: unknown) => {
        logger.warn('slot_fee_mix prune failed', { error: String(error) });
      });
    }
  }

  livePayload(): LiveIndexPayload {
    const epochs = this.epochs as EpochMath;
    const epoch = this.tracker.epoch ?? (this.tipSlot !== undefined ? epochs.epochOf(this.tipSlot) : 0);
    const snapshot = this.stakes.get(epoch) ?? [...this.stakes.values()].sort((a, b) => b.epoch - a.epoch)[0];
    const estimate = snapshot ? this.tracker.estimate(snapshot.byIdentity) : null;
    const stats = this.stats;
    // Coverage starts at the run start (or, sampling, at the first polled slot), never before the epoch.
    const start = this.watermark?.runStart ?? this.streamStart;
    const firstSlot = start !== undefined ? Math.max(start, epochs.firstSlot(epoch)) : null;
    return {
      t: 'index',
      epoch,
      estimate: estimate?.value ?? null,
      leaders: estimate?.stakedLeaders ?? 0,
      slotsWithFees: this.tracker.medians?.slotCount ?? 0,
      pricedTxs: this.tracker.medians?.txCount ?? 0,
      firstSlot,
      processedSlot: stats.processedSlot,
      watermarkSlot: stats.watermark,
      tipSlot: stats.tipSlot,
      stakeEpoch: snapshot?.epoch ?? null,
      source: this.mode ?? 'rpc',
      endpoint: this.endpoint,
      status: this.status,
      stride: this.options.stride,
      lastSlotAt: this.lastSlotAt ?? null,
    };
  }

  private async shutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.allSettled([...this.hybridPending]);
    await this.flush();
    this.status = 'stopped';
    if (this.epochs) await this.store.writeLive(this.livePayload()).catch(() => undefined);
    await this.store.writeUsage(this.usage.report()).catch(() => undefined);
    logger.info('slot stream stopped', { ...this.stats });
  }
}
