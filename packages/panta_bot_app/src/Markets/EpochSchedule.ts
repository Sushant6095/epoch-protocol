/**
 * When a Fee Index market may trade and resolve, from the MAINNET slot clock. Pure: the clock snapshot is an input.
 *
 * An epoch's Fee Index is known only after the epoch ends, and its priority fees are public while it runs. So a market
 * on epoch N closes BEFORE N starts (the same rule as Epoch's fee swaps and points-mode Predict): nobody can trade on
 * N while watching N's fees. It resolves after N ends, once the value is posted on chain and its dispute window has
 * passed. Slot times drift a little (~0.4 s on mainnet, measured from recent performance samples), so every estimate
 * carries a margin that grows with how far ahead it is: trading closes early rather than late, and resolution is set
 * late rather than early.
 */

export interface ClockSnapshot {
  /** Mainnet epoch now. */
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
  /** Measured from recent performance samples (clamped), else 0.4. */
  secondsPerSlot: number;
  /** When the snapshot was read, epoch ms. */
  nowMs: number;
}

export interface ScheduleOptions {
  /** Panta's on-chain `minimumStartDelay` for standard markets (docs: typically 3,600 s). */
  minimumStartDelaySec: number;
  /** Extra room for quote → build → sign → broadcast → confirm before Panta checks `startTime`. */
  startSlackSec: number;
  /** Trading closes this long before epoch N's (early) start estimate. */
  closeBeforeEpochSec: number;
  /** Relative error allowed on a slot-time estimate, e.g. 0.02 = ±2% of the time until the slot. */
  uncertainty: number;
  /** Shorter trading windows are not worth a creation fee: the epoch is skipped. */
  minTradingSec: number;
  /** After N's (late) end estimate: computing, posting on chain, the dispute window and finalization. */
  resolutionBufferSec: number;
}

export const DEFAULT_SCHEDULE: ScheduleOptions = {
  minimumStartDelaySec: 3_600,
  startSlackSec: 600,
  closeBeforeEpochSec: 3_600,
  uncertainty: 0.02,
  minTradingSec: 6 * 3_600,
  resolutionBufferSec: 6 * 3_600,
};

export interface MarketWindow {
  epoch: number;
  /** Mainnet slots of the epoch, inclusive. */
  firstSlot: number;
  lastSlot: number;
  /** Central estimates, epoch ms. */
  estStartMs: number;
  estEndMs: number;
  /** What the market is created with: unix seconds, startTime < endTime ≤ resolutionTime. */
  startTime: number;
  endTime: number;
  resolutionTime: number;
  tradingSeconds: number;
  /** False when the epoch cannot get a market now; `reason` says why. */
  ok: boolean;
  reason: string | null;
}

/** First slot of `epoch` (mainnet epochs all have `slotsInEpoch` slots). */
export const firstSlotOf = (clock: ClockSnapshot, epoch: number): number =>
  clock.absoluteSlot - clock.slotIndex + (epoch - clock.epoch) * clock.slotsInEpoch;

/** Estimated wall time of `slot`, epoch ms. */
export const slotTimeMs = (clock: ClockSnapshot, slot: number): number =>
  clock.nowMs + (slot - clock.absoluteSlot) * clock.secondsPerSlot * 1_000;

/** Seconds per slot from `getRecentPerformanceSamples`, clamped to [0.3, 0.8]; 0.4 without usable samples. */
export function secondsPerSlotFrom(samples: readonly { numSlots: number; samplePeriodSecs: number }[]): number {
  const slots = samples.reduce((sum, s) => sum + s.numSlots, 0);
  const seconds = samples.reduce((sum, s) => sum + s.samplePeriodSecs, 0);
  if (slots <= 0 || seconds <= 0) return 0.4;
  return Math.min(0.8, Math.max(0.3, seconds / slots));
}

/** The trading and resolution times a market on `epoch` gets if it is created now. */
export function marketWindow(clock: ClockSnapshot, epoch: number, options: ScheduleOptions): MarketWindow {
  const firstSlot = firstSlotOf(clock, epoch);
  const nextFirstSlot = firstSlotOf(clock, epoch + 1);
  const estStartMs = slotTimeMs(clock, firstSlot);
  const estEndMs = slotTimeMs(clock, nextFirstSlot);
  const margin = (atMs: number) => Math.max(0, atMs - clock.nowMs) * options.uncertainty;

  const startTime = Math.ceil(clock.nowMs / 1_000) + options.minimumStartDelaySec + options.startSlackSec;
  const endTime = Math.floor((estStartMs - margin(estStartMs)) / 1_000) - options.closeBeforeEpochSec;
  const resolutionTime = Math.ceil((estEndMs + margin(estEndMs)) / 1_000) + options.resolutionBufferSec;
  const tradingSeconds = endTime - startTime;

  let reason: string | null = null;
  if (epoch <= clock.epoch) reason = `epoch ${epoch} has already started`;
  else if (tradingSeconds < options.minTradingSec) {
    reason = `only ${Math.max(0, tradingSeconds / 3_600).toFixed(1)} h of trading left before epoch ${epoch} starts`;
  }
  return {
    epoch,
    firstSlot,
    lastSlot: nextFirstSlot - 1,
    estStartMs,
    estEndMs,
    startTime,
    endTime,
    resolutionTime,
    tradingSeconds,
    ok: reason === null,
    reason,
  };
}
