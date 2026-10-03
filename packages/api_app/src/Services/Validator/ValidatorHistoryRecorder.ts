import { GracefulShutdown, sleep } from '@epoch/common';
import { Logger } from '@epoch/logger';

import { type EpochClock, type EpochStart, epochEndMs, parseStakewizTime } from '../../Lib/EpochTimes';
import { type StakewizSource } from '../../Sources/ExternalSources';
import { type MarketData, optional } from '../MarketData';
import {
  buildHistorySnapshot,
  COMMISSION_HISTORY_EPOCHS,
  commissionAtEpochEnds,
  recordedStats,
  STAKE_HISTORY_EPOCHS,
  stakeStatsFromSeries,
  type ValidatorEpochStat,
  type ValidatorHistorySnapshot,
} from './ValidatorHistory';
import { type ValidatorHistoryStore } from './ValidatorHistoryStore';

const logger = Logger.create('ValidatorHistory');

const HOUR = 3_600_000;
/** The backfill gives up for this run after this many Stakewiz failures in a row. */
const MAX_FAILURES_IN_A_ROW = 10;

export interface ValidatorHistoryOptions {
  /** Fill missing commission and stake history from Stakewiz (two calls per validator). */
  backfill: boolean;
  /** Pause after each validator's two Stakewiz calls (default 500 ms: about 20 minutes for 700 validators). */
  pauseMs?: number;
  intervalMs?: number;
}

/**
 * Records every staked validator's commission, MEV commission, active stake and vote credits per epoch in
 * `validator_epoch_stats` (once at start, then hourly; the current epoch's row is refreshed each run), and keeps the
 * last 64 epochs in memory for the validator table and the profile.
 *
 * Commission history before the recorder ran comes from Stakewiz's change logs, not from `getInflationReward`:
 * mainnet vote accounts are VoteStateV4 and their rewards carry `commission: null`. The backfill reads
 * `/commission_history/<vote>` (the value in force at each epoch's end; an empty log means Stakewiz never saw a change,
 * so today's commission held) and `/validator_total_stakes/<vote>` (30 epochs of stake) for every validator missing
 * any of the last nine finished epochs, once per process. Epochs before a validator's first logged value stay unknown.
 */
export class ValidatorHistoryRecorder {
  private snapshot?: ValidatorHistorySnapshot;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private version = 0;
  /** Validators the backfill tried in this process (new ones have no older history to find). */
  private readonly backfilled = new Set<string>();

  constructor(
    private readonly market: MarketData,
    private readonly stakewiz: StakewizSource,
    private readonly store: ValidatorHistoryStore | undefined,
    private readonly options: ValidatorHistoryOptions,
  ) {}

  /** The recorded history; undefined until the first run has loaded it (and always without Postgres). */
  get latest(): ValidatorHistorySnapshot | undefined {
    return this.snapshot;
  }

  start(): void {
    if (!this.store) {
      logger.info('validator history needs DATABASE_URL; not recording');
      return;
    }
    this.stopped = false;
    const run = () => {
      this.run().catch((error: unknown) => logger.error('validator history run failed', error));
    };
    // After the validator table's warm-up has filled the shared caches.
    setTimeout(run, 5_000).unref();
    this.timer = setInterval(run, this.options.intervalMs ?? HOUR);
    this.timer.unref();
    GracefulShutdown.register('validator-history', async () => this.stop());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: record this epoch, reload the snapshot, then backfill what is missing. */
  async run(): Promise<void> {
    const store = this.store;
    if (!store || this.running) return;
    this.running = true;
    try {
      const [info, accounts] = await Promise.all([this.market.epochInfo.get(), this.market.voteAccounts.get()]);
      const [kobe, stakewiz] = await Promise.all([
        optional(this.market.kobe, new Map()),
        optional(this.market.stakewiz, new Map()),
      ]);
      const staked = [...accounts.current, ...accounts.delinquent].filter((v) => v.activatedStake > 0);
      const rows = recordedStats(
        staked,
        info.epoch,
        (vote) => kobe.get(vote)?.mev_commission_bps ?? stakewiz.get(vote)?.jito_commission_bps ?? null,
      );
      await store.upsert(rows);
      await this.reload(store, info.epoch);
      logger.info('validator history recorded', { epoch: info.epoch, validators: staked.length });
      if (this.options.backfill) {
        const secondsPerSlot = await this.market.secondsPerSlot();
        const msPerSlot = secondsPerSlot * 1_000;
        await this.backfill(
          store,
          info.epoch,
          new Map(staked.map((v) => [v.votePubkey, v.inflationRewardsCommissionBps ?? v.commission * 100])),
          {
            epoch: info.epoch,
            startMs: Date.now() - info.slotIndex * msPerSlot,
            msPerEpoch: info.slotsInEpoch * msPerSlot,
          },
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async reload(store: ValidatorHistoryStore, epoch: number): Promise<void> {
    const rows = await store.load(epoch - STAKE_HISTORY_EPOCHS + 1);
    this.version += 1;
    this.snapshot = buildHistorySnapshot(rows, epoch, this.version);
  }

  /** Stakewiz change logs and stake series for validators missing any of the last nine finished epochs. */
  private async backfill(
    store: ValidatorHistoryStore,
    epoch: number,
    /** Every staked validator and its commission now (bps). */
    votes: ReadonlyMap<string, number>,
    clock: EpochClock,
  ): Promise<void> {
    const window = Array.from(
      { length: COMMISSION_HISTORY_EPOCHS - 1 },
      (_, i) => epoch - COMMISSION_HISTORY_EPOCHS + 1 + i,
    );
    const todo = [...votes.keys()].filter((vote) => {
      if (this.backfilled.has(vote)) return false;
      const seen = new Set((this.snapshot?.commission.get(vote) ?? []).map((point) => point.epoch));
      return window.some((e) => !seen.has(e));
    });
    if (todo.length === 0) return;
    logger.info('validator history backfill from Stakewiz', { validators: todo.length, epochs: window });

    const starts = await this.epochStarts();
    const endMs = (e: number) => epochEndMs(e, starts, clock);
    const pause = this.options.pauseMs ?? 500;
    let pending: ValidatorEpochStat[] = [];
    let failures = 0;
    let done = 0;
    let reloadedAt = 0;
    for (const vote of todo) {
      if (this.stopped) break;
      try {
        const [changes, series] = await Promise.all([
          this.stakewiz.getCommissionHistory(vote),
          this.stakewiz.getTotalStakes(vote),
        ]);
        const commission = commissionAtEpochEnds(
          changes.map((change) => ({ bps: change.commission, atMs: parseStakewizTime(change.observed_at) })),
          window,
          endMs,
        );
        const stake = stakeStatsFromSeries(vote, series, epoch).filter(
          (row) => row.epoch > epoch - STAKE_HISTORY_EPOCHS,
        );
        // An empty log: Stakewiz never saw this commission change, so today's held since the validator had stake.
        const firstStaked = stake[0]?.epoch;
        if (changes.length === 0 && firstStaked !== undefined) {
          for (const e of window) if (e >= firstStaked) commission.set(e, votes.get(vote) ?? 0);
        }
        for (const [e, bps] of commission) pending.push({ vote, epoch: e, commissionBps: bps });
        pending.push(...stake);
        this.backfilled.add(vote);
        failures = 0;
        done += 1;
      } catch (error) {
        failures += 1;
        logger.warn('Stakewiz history failed for one validator', { vote, error: String(error) });
        if (failures >= MAX_FAILURES_IN_A_ROW) {
          logger.warn('Stakewiz keeps failing; the backfill continues on the next run');
          break;
        }
      }
      // Written every ~13 validators, so progress survives a restart; shown every ~100.
      if (pending.length >= 500) {
        await store.upsert(pending);
        pending = [];
        if (done - reloadedAt >= 100) {
          await this.reload(store, epoch);
          reloadedAt = done;
        }
      }
      await sleep(pause);
    }
    if (pending.length > 0) await store.upsert(pending);
    await this.reload(store, epoch);
    logger.info('validator history backfill finished', { validators: done, of: todo.length });
  }

  /** Epoch start times from Stakewiz; empty when it does not answer (the slot clock is used instead). */
  private async epochStarts(): Promise<EpochStart[]> {
    try {
      const history = await this.stakewiz.getEpochHistory();
      return history
        .map((row) => ({ epoch: row.epoch, startMs: parseStakewizTime(row.start) }))
        .filter((row) => Number.isFinite(row.startMs));
    } catch (error) {
      logger.warn('Stakewiz epoch history unavailable; using the slot clock', { error: String(error) });
      return [];
    }
  }
}
