import { parseStakewizTime } from '../../Lib/EpochTimes';
import { SnapshotCache } from '../../Lib/SnapshotCache';
import { type StakewizSource } from '../../Sources/ExternalSources';

const MINUTE = 60_000;

/** When an epoch started and ended (epoch ms). */
export interface EpochSpan {
  epoch: number;
  startMs: number;
  endMs: number;
}

/**
 * Finished epochs' start and end times from Stakewiz's `all_epochs_history` (every epoch since 2020; the newest row is
 * the current epoch, whose end is only a guess and is dropped). An epoch ends when the next one starts; Stakewiz's own
 * `end` is used only when the next epoch is missing from its list.
 */
export function buildEpochSpans(
  rows: readonly { epoch: number; start: string; end: string }[],
  currentEpoch: number,
): Map<number, EpochSpan> {
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const row of rows) {
    const start = parseStakewizTime(row.start);
    const end = parseStakewizTime(row.end);
    if (Number.isFinite(start)) starts.set(row.epoch, start);
    if (Number.isFinite(end)) ends.set(row.epoch, end);
  }
  const spans = new Map<number, EpochSpan>();
  for (const [epoch, startMs] of starts) {
    if (epoch >= currentEpoch) continue;
    const endMs = starts.get(epoch + 1) ?? ends.get(epoch);
    if (endMs !== undefined && endMs > startMs) spans.set(epoch, { epoch, startMs, endMs });
  }
  return spans;
}

/** Finished epochs whose end falls in [fromMs, toMs), oldest first. */
export function epochsEndingIn(spans: ReadonlyMap<number, EpochSpan>, fromMs: number, toMs: number): EpochSpan[] {
  return [...spans.values()].filter((s) => s.endMs >= fromMs && s.endMs < toMs).sort((a, b) => a.epoch - b.epoch);
}

/**
 * Epoch start and end times for the India page (rewards by financial year, the date of a validator's revenue epoch).
 * Re-read every 30 minutes; the last good copy is served for up to two days while Stakewiz is down.
 */
export class EpochCalendar {
  private readonly cache: SnapshotCache<{ epoch: number; start: string; end: string }[]>;

  constructor(
    stakewiz: Pick<StakewizSource, 'getEpochHistory'>,
    private readonly currentEpoch: () => Promise<number>,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = new SnapshotCache(
      'epochCalendar',
      30 * MINUTE,
      () => stakewiz.getEpochHistory(),
      48 * 60 * MINUTE,
      now,
    );
  }

  /** Finished epochs by number; throws when Stakewiz has never answered. */
  async spans(): Promise<Map<number, EpochSpan>> {
    const [cached, current] = await Promise.all([this.cache.get(), this.currentEpoch()]);
    // A new epoch started since the last read: the one that just finished only has Stakewiz's guessed end. Re-read.
    const behind = !cached.some((row) => row.epoch >= current) && this.now() - this.cache.loadedAtMs > MINUTE;
    const rows = behind ? await this.cache.refresh().catch(() => cached) : cached;
    return buildEpochSpans(rows, current);
  }
}
