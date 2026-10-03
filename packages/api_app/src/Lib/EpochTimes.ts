/** When an epoch started, epoch milliseconds (Stakewiz `all_epochs_history`). */
export interface EpochStart {
  epoch: number;
  startMs: number;
}

/** The current epoch's start and length, from the slot clock: the fallback when epoch start times are missing. */
export interface EpochClock {
  epoch: number;
  startMs: number;
  msPerEpoch: number;
}

/** Stakewiz prints times as `2026-02-22 01:24:11.135988+01`; this reads them as ISO 8601. NaN when unreadable. */
export function parseStakewizTime(value: string): number {
  const iso = value
    .trim()
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(iso);
}

/**
 * The epoch a moment falls in: from the known epoch start times when they cover it, otherwise whole epochs counted
 * back from the current one (accurate to an epoch over the last few dozen; older epochs were longer).
 */
export function epochAt(timeMs: number, starts: readonly EpochStart[], clock: EpochClock): number {
  let containing: EpochStart | undefined;
  for (const start of starts) {
    if (start.startMs <= timeMs && (!containing || start.startMs > containing.startMs)) containing = start;
  }
  if (containing) return Math.min(containing.epoch, clock.epoch);
  if (timeMs >= clock.startMs) return clock.epoch;
  return clock.epoch - Math.ceil((clock.startMs - timeMs) / clock.msPerEpoch);
}

/** When `epoch` ended (the next epoch's start); for the current epoch, an estimate. */
export function epochEndMs(epoch: number, starts: readonly EpochStart[], clock: EpochClock): number {
  const next = starts.find((start) => start.epoch === epoch + 1);
  if (next) return next.startMs;
  return clock.startMs + (epoch + 1 - clock.epoch) * clock.msPerEpoch;
}
