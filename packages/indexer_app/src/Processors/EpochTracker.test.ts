import { decodeRpcBlock } from '../Blocks/RpcBlockDecoder';
import { blockFees } from '../Blocks/BlockFees';
import { recordedBlocks } from '../__fixtures__/mainnetBlocks';
import { type SlotFeeRow } from '../Repositories/SlotFeeRepository';
import { computeIndex, EpochTracker, LeaderSlotMedians, rollupRows } from './EpochTracker';
import { stakeWeightedMedian, stakeWeightedMedianLeader } from './FeeProcessor';

const row = (slot: number, leader: string, medianCuPrice: number, txCount = 10): SlotFeeRow => ({
  slot,
  epoch: 7,
  leader,
  medianCuPrice,
  txCount,
});

describe('LeaderSlotMedians', () => {
  it('keeps each leader’s slot medians sorted and never counts a slot twice', () => {
    const medians = new LeaderSlotMedians();
    for (const [slot, value] of [
      [1, 500],
      [2, 100],
      [3, 300],
      [4, 200],
    ]) {
      medians.add(row(slot, 'L', value));
    }
    expect(medians.add(row(3, 'L', 999))).toBe(false);
    expect(medians.medians()).toEqual([{ leader: 'L', slots: 4, medianCuPrice: 250 }]);
    expect(medians.slotCount).toBe(4);
    expect(medians.txCount).toBe(40);
  });
});

describe('computeIndex', () => {
  it('is the stake-weighted median of per-leader medians, names its setter, and ignores unstaked leaders', () => {
    const medians = new LeaderSlotMedians();
    [
      row(1, 'big', 7_000),
      row(2, 'big', 7_400),
      row(3, 'mid', 8_000),
      row(4, 'small', 1_000_000),
      row(5, 'x', 1),
    ].forEach((r) => medians.add(r));
    const stakes = new Map([
      ['big', 100n],
      ['mid', 150n],
      ['small', 1n],
    ]);
    expect(computeIndex(medians, stakes)).toEqual({
      value: 8_000,
      setter: 'mid',
      leaders: 4,
      stakedLeaders: 3,
      slots: 5,
      txCount: 50,
    });
    expect(computeIndex(new LeaderSlotMedians(), stakes).value).toBeNull();
  });

  it('agrees with FeeProcessor.stakeWeightedMedian and breaks ties deterministically', () => {
    const leaders = [
      { leader: 'b', medianCuPrice: 10, stake: 5n },
      { leader: 'a', medianCuPrice: 10, stake: 5n },
      { leader: 'c', medianCuPrice: 20, stake: 9n },
    ];
    // Sorted by median then key: a (5), b (10 of 19 ≥ half) → b sets it, whatever the input order.
    expect(stakeWeightedMedianLeader(leaders)?.leader).toBe('b');
    expect(stakeWeightedMedianLeader([...leaders].reverse())?.leader).toBe('b');
    expect(stakeWeightedMedian(leaders)).toBe(10);
    expect(stakeWeightedMedian([])).toBe(0);
  });
});

describe('EpochTracker', () => {
  it('the running estimate equals the batch rollup of the same slots (real mainnet slot medians)', () => {
    // Real slot results from the recorded blocks, spread over three leaders with made-up stakes.
    const results = recordedBlocks().blocks.map((b) =>
      blockFees(b.slot, b.leader, decodeRpcBlock(b.slot, b.block).txs),
    );
    const rows: SlotFeeRow[] = [];
    results.forEach((r, i) => {
      for (let k = 0; k < 5; k++) {
        rows.push(
          row(1_000 + i * 10 + k, ['L1', 'L2', 'L3'][(i + k) % 3], (r.medianCuPrice ?? 0) + k * 13, r.pricedTxs),
        );
      }
    });
    const stakes = new Map([
      ['L1', 3n],
      ['L2', 2n],
      ['L3', 2n],
    ]);
    const tracker = new EpochTracker();
    tracker.begin(7, rows.slice(0, 4));
    for (const r of rows.slice(4)) tracker.add(r);
    expect(tracker.add(rows[0])).toBe(false);
    expect(tracker.add({ ...rows[0], slot: 99, epoch: 8 })).toBe(false);
    const estimate = tracker.estimate(stakes);
    expect(estimate).toEqual({ epoch: 7, ...rollupRows(rows, stakes) });
    expect(estimate?.value).not.toBeNull();
  });

  it('switches epochs cleanly', () => {
    const tracker = new EpochTracker();
    expect(tracker.estimate(new Map())).toBeNull();
    tracker.begin(7, [row(1, 'L', 5)]);
    tracker.begin(8);
    expect(tracker.epoch).toBe(8);
    expect(tracker.medians?.slotCount).toBe(0);
  });
});
