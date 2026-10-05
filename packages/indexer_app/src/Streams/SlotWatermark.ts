/**
 * Which slots are done (a block indexed, or known to have no block), as one contiguous run from `runStart` up to the
 * `watermark` plus the done slots above it. Everything at or below the watermark is complete; the gaps above it are
 * what the gap filler fetches. The watermark (and run start) is what `indexer_cursors` stores, so a restart resumes at
 * `watermark + 1` and an epoch is complete exactly when the run covers it.
 */
export class SlotWatermark {
  private readonly done = new Set<number>();
  private highest: number;

  constructor(
    /** First slot of the run. */
    readonly runStart: number,
    /** Last slot of the contiguous done prefix (runStart − 1 when nothing is done yet). */
    private mark: number = runStart - 1,
  ) {
    this.highest = mark;
  }

  get watermark(): number {
    return this.mark;
  }

  /** The highest done slot (above the watermark when there are gaps). */
  get highestDone(): number {
    return this.highest;
  }

  /** Done slots above the watermark, waiting for the gaps below them. */
  get pendingAbove(): number {
    return this.done.size;
  }

  isDone(slot: number): boolean {
    return slot <= this.mark || this.done.has(slot);
  }

  /** Marks one slot done; true when the watermark moved. */
  markDone(slot: number): boolean {
    if (slot < this.runStart || slot <= this.mark) return false;
    this.done.add(slot);
    if (slot > this.highest) this.highest = slot;
    return this.advance();
  }

  /** Marks [from, to] done (skipped slots between a block and its parent). */
  markRange(from: number, to: number): boolean {
    let moved = false;
    for (let slot = Math.max(from, this.runStart, this.mark + 1); slot <= to; slot++) {
      moved = this.markDone(slot) || moved;
    }
    return moved;
  }

  /** Up to `limit` slots in (watermark, upTo] that are not done, oldest first. */
  missing(upTo: number, limit: number): number[] {
    const out: number[] = [];
    for (let slot = this.mark + 1; slot <= upTo && out.length < limit; slot++) {
      if (!this.done.has(slot)) out.push(slot);
    }
    return out;
  }

  /** True when every slot of [first, last] is done and inside the run. */
  covers(first: number, last: number): boolean {
    return this.runStart <= first && this.mark >= last;
  }

  private advance(): boolean {
    const before = this.mark;
    while (this.done.has(this.mark + 1)) {
      this.done.delete(this.mark + 1);
      this.mark++;
    }
    return this.mark !== before;
  }
}
