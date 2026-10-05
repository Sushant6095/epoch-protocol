import { type SlotFeeRow } from '../Repositories/SlotFeeRepository';
import { type LeaderMedian, median, stakeWeightedMedianLeader } from './FeeProcessor';

/** Insert into an ascending array (binary search). */
function insertSorted(values: number[], value: number): void {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  values.splice(lo, 0, value);
}

export interface LeaderEpochMedian {
  leader: string;
  /** Slots the leader produced with priced transactions (slot_fees rows). */
  slots: number;
  /** Median of the leader's slot medians, µL/CU (same rule as a slot: ⌊(a + b) / 2⌋ for even counts). */
  medianCuPrice: number;
}

/** Each leader's slot medians for one epoch, kept sorted so a leader's median is read without re-sorting. */
export class LeaderSlotMedians {
  private readonly byLeader = new Map<string, number[]>();
  private readonly slots = new Set<number>();
  txCount = 0;

  get slotCount(): number {
    return this.slots.size;
  }

  get leaderCount(): number {
    return this.byLeader.size;
  }

  has(slot: number): boolean {
    return this.slots.has(slot);
  }

  /** False when the slot is already in (a replayed or gap-filled slot is never counted twice). */
  add(row: Pick<SlotFeeRow, 'slot' | 'leader' | 'medianCuPrice' | 'txCount'>): boolean {
    if (this.slots.has(row.slot)) return false;
    this.slots.add(row.slot);
    this.txCount += row.txCount;
    let values = this.byLeader.get(row.leader);
    if (!values) {
      values = [];
      this.byLeader.set(row.leader, values);
    }
    insertSorted(values, row.medianCuPrice);
    return true;
  }

  medians(): LeaderEpochMedian[] {
    return [...this.byLeader].map(([leader, values]) => ({
      leader,
      slots: values.length,
      medianCuPrice: median(values),
    }));
  }
}

export interface IndexComputation {
  /** µL/CU; null when no leader with slot medians has stake. */
  value: number | null;
  /** The leader whose median is the index. */
  setter: string | null;
  leaders: number;
  stakedLeaders: number;
  slots: number;
  txCount: number;
}

/**
 * The epoch rollup: per-leader medians over the leaders' slot medians, weighted by each leader identity's stake, then
 * the stake-weighted median (FeeProcessor). Leaders missing from the stake snapshot weigh nothing.
 */
export function computeIndex(medians: LeaderSlotMedians, stakes: ReadonlyMap<string, bigint>): IndexComputation {
  const leaders: LeaderMedian[] = medians
    .medians()
    .map((m) => ({ leader: m.leader, medianCuPrice: m.medianCuPrice, stake: stakes.get(m.leader) ?? 0n }));
  const setter = stakeWeightedMedianLeader(leaders);
  return {
    value: setter ? setter.medianCuPrice : null,
    setter: setter?.leader ?? null,
    leaders: leaders.length,
    stakedLeaders: leaders.filter((l) => l.stake > 0n).length,
    slots: medians.slotCount,
    txCount: medians.txCount,
  };
}

/** The same rollup from stored rows (an epoch's slot_fees): what goes to epoch_index. */
export function rollupRows(rows: readonly SlotFeeRow[], stakes: ReadonlyMap<string, bigint>): IndexComputation {
  const medians = new LeaderSlotMedians();
  for (const row of rows) medians.add(row);
  return computeIndex(medians, stakes);
}

/**
 * The running Fee Index of the epoch in progress, updated slot by slot: adding a slot is a sorted insert into its
 * leader's list, and the estimate is a stake-weighted median over ~1,500 leaders, cheap enough to recompute every few
 * seconds. Holds one epoch at a time; earlier epochs are rolled up from Postgres.
 */
export class EpochTracker {
  private current?: { epoch: number; medians: LeaderSlotMedians };

  get epoch(): number | undefined {
    return this.current?.epoch;
  }

  get medians(): LeaderSlotMedians | undefined {
    return this.current?.medians;
  }

  /** Starts tracking `epoch` (dropping the previous one), preloaded with rows already stored for it. */
  begin(epoch: number, rows: readonly SlotFeeRow[] = []): void {
    const medians = new LeaderSlotMedians();
    for (const row of rows) medians.add(row);
    this.current = { epoch, medians };
  }

  /** Adds a slot of the tracked epoch; false for another epoch or a slot already counted. */
  add(row: SlotFeeRow): boolean {
    if (!this.current || row.epoch !== this.current.epoch) return false;
    return this.current.medians.add(row);
  }

  estimate(stakes: ReadonlyMap<string, bigint>): (IndexComputation & { epoch: number }) | null {
    if (!this.current) return null;
    return { epoch: this.current.epoch, ...computeIndex(this.current.medians, stakes) };
  }
}
