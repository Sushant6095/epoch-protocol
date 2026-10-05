import { type LiveIndexPayload, type LiveSlotPayload } from '@epoch/pg_models';

import { FakeChain, FakeGrpcStream, LEADERS, waitFor } from '../__fixtures__/FakeChain';
import { MemoryIndexerStore } from '../__fixtures__/MemoryIndexerStore';
import { rollupRows } from '../Processors/EpochTracker';
import { type SlotFeeRow } from '../Repositories/SlotFeeRepository';
import { SlotStream, type SlotStreamOptions } from './SlotStream';

const OPTIONS: SlotStreamOptions = {
  mode: 'grpc',
  endpoints: [{ name: 'solami', url: 'https://grpc.solami.dev', token: 'test-token' }],
  backfillEpoch: false,
  gapFillRps: 10_000,
  gapFillConcurrency: 8,
  gapFillMaxSlots: 100_000,
  rpcPollMs: 5,
  stride: 1,
  liveIntervalMs: 40,
  liveSlotsKeep: 10_000,
  tickMs: 10,
};

/** What the store should hold for [from, to]: one slot_fees row per block with priced transactions. */
function expectedRows(chain: FakeChain, from: number, to: number): SlotFeeRow[] {
  const rows: SlotFeeRow[] = [];
  for (let slot = from; slot <= to; slot++) {
    const fees = chain.expectedFees(slot);
    if (fees && fees.medianCuPrice !== null) {
      rows.push({
        slot,
        epoch: Math.floor(slot / chain.slotsPerEpoch),
        leader: fees.leader,
        medianCuPrice: fees.medianCuPrice,
        txCount: fees.pricedTxs,
      });
    }
  }
  return rows;
}

/** Streams the current test started: stopped afterwards even when the test fails, so a failure never hangs jest. */
const running: { stream: SlotStream; run: Promise<void> }[] = [];
function start(stream: SlotStream): Promise<void> {
  const run = stream.run();
  running.push({ stream, run });
  return run;
}
afterEach(async () => {
  for (const { stream, run } of running.splice(0)) {
    stream.stop();
    await run.catch(() => undefined);
  }
});

const stakeMap = (chain: FakeChain) => new Map(LEADERS.map((l) => [l, BigInt(chain.stakes[l])]));
const slotPayloads = (store: MemoryIndexerStore) =>
  store.notifications.filter((n): n is LiveSlotPayload => n.t === 'slot');

describe('SlotStream over the Yellowstone firehose', () => {
  it('backfills the epoch over RPC, streams the rest, and rolls the finished epoch up into epoch_index', async () => {
    const chain = new FakeChain(32, (slot) => slot % 10 === 7, 70);
    const store = new MemoryIndexerStore();
    const streams: FakeGrpcStream[] = [];
    const stream = new SlotStream(
      { ...OPTIONS, backfillEpoch: true },
      {
        rpc: chain.rpc,
        store,
        createGrpcStream: () => {
          const fake = new FakeGrpcStream(async (_request, push) => {
            for (let slot = 66; slot <= 100; slot++) {
              chain.tip = slot;
              for (const update of chain.firehose(slot)) await push(update);
            }
          }, 40);
          streams.push(fake);
          return fake;
        },
      },
    );
    const run = start(stream);
    await waitFor(() => store.epochIndex.has(2), 8_000, 'the epoch 2 rollup');
    await waitFor(() => (store.cursor?.watermark ?? 0) >= 100, 8_000, 'the cursor');
    stream.stop();
    await run;

    // The firehose request: every non-vote transaction (failed included), block meta and slot statuses, confirmed.
    const request = streams[0].requests[0];
    expect(request.transactions.fees).toEqual({
      vote: false,
      accountInclude: [],
      accountExclude: [],
      accountRequired: [],
    });
    expect(Object.keys(request.blocksMeta)).toEqual(['blocks']);
    expect(request.commitment).toBe(1);
    expect(request.fromSlot).toBeUndefined();

    // Every block of epoch 2 (64–95) is stored, 64 and 65 from the gap filler, and nothing else changed.
    const epoch2 = expectedRows(chain, 64, 95);
    expect(await store.epochRows(2)).toEqual(epoch2);
    expect(chain.calls.getBlock).toEqual(expect.arrayContaining([64, 65]));
    expect(store.cursor).toEqual({ watermark: 100, runStart: 64 });

    // The rollup is the stake-weighted median of per-leader medians with the snapshot taken during epoch 2.
    expect(store.stakes.get(2)).toEqual(stakeMap(chain));
    const value = rollupRows(epoch2, stakeMap(chain)).value;
    expect(store.epochIndex.get(2)).toEqual({ value, postedSignature: null });
    expect(store.notifications).toContainEqual({ t: 'epoch', epoch: 2, value });

    // Live slots are announced, gap-filled ones are not; each payload carries what the Live page shows.
    const announced = slotPayloads(store).map((p) => p.slot);
    expect(announced).not.toContain(64);
    expect(announced).toContain(66);
    const p66 = slotPayloads(store).find((p) => p.slot === 66) as LiveSlotPayload;
    expect(p66).toMatchObject({ epoch: 2, leader: chain.leaderOf(66), source: 'grpc' });
    expect(p66.medianCuPrice).toBe(chain.expectedFees(66)?.medianCuPrice);
    expect(store.liveSlots.get(64)?.source).toBe('gap-fill');

    // The running estimate of epoch 3 (the stream reached slot 100).
    const live = store.live.get(3) as LiveIndexPayload;
    expect(live).toMatchObject({ epoch: 3, source: 'grpc', stride: 1, stakeEpoch: 3, status: 'stopped' });
    expect(live.estimate).toBe(rollupRows(expectedRows(chain, 96, 100), stakeMap(chain)).value);
    expect(stream.stats.lostSlots).toBe(0);
  });

  it('resumes from the saved cursor with fromSlot when the endpoint can replay it', async () => {
    const chain = new FakeChain(32, () => false, 90);
    const store = new MemoryIndexerStore();
    store.cursor = { watermark: 80, runStart: 64 };
    const fake = new FakeGrpcStream(async (request, push) => {
      for (let slot = Number(request.fromSlot); slot <= 92; slot++) for (const u of chain.firehose(slot)) await push(u);
    }, 50);
    const stream = new SlotStream(OPTIONS, { rpc: chain.rpc, store, createGrpcStream: () => fake });
    const run = start(stream);
    await waitFor(() => (store.cursor?.watermark ?? 0) >= 92, 8_000, 'the cursor');
    stream.stop();
    await run;
    expect(fake.requests[0].fromSlot).toBe('81');
    expect(chain.calls.getBlock).toEqual([]);
    expect([...store.slotFees.keys()].sort()).toEqual(expectedRows(chain, 81, 92).map((r) => r.slot));
  });

  it('subscribes live when the cursor is older than the replay window and gap-fills the hole over RPC', async () => {
    const chain = new FakeChain(32, () => false, 90);
    const store = new MemoryIndexerStore();
    store.cursor = { watermark: 70, runStart: 64 };
    const fake = new FakeGrpcStream(async (_request, push) => {
      for (let slot = 85; slot <= 95; slot++) for (const u of chain.firehose(slot)) await push(u);
    }, 80);
    const stream = new SlotStream(OPTIONS, { rpc: chain.rpc, store, createGrpcStream: () => fake });
    const run = start(stream);
    await waitFor(() => (store.cursor?.watermark ?? 0) >= 95, 8_000, 'the cursor');
    stream.stop();
    await run;
    expect(fake.requests[0].fromSlot).toBeUndefined();
    expect([...new Set(chain.calls.getBlock)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 14 }, (_, i) => 71 + i),
    );
    expect(await store.epochRows(2)).toEqual(expectedRows(chain, 71, 95));
  });

  it('switches to hybrid (meta over gRPC, blocks over RPC) when Solami refuses the firehose', async () => {
    const chain = new FakeChain(32, (slot) => slot % 10 === 7, 70);
    const store = new MemoryIndexerStore();
    const fakes: FakeGrpcStream[] = [];
    const stream = new SlotStream(
      { ...OPTIONS, mode: 'auto' },
      {
        rpc: chain.rpc,
        store,
        createGrpcStream: () => {
          const fake =
            fakes.length === 0
              ? new FakeGrpcStream(async () => {
                  throw new Error(
                    'status: PermissionDenied, message: "unfiltered/firehose subscriptions are not allowed on non-PAYG streams"',
                  );
                })
              : new FakeGrpcStream(async (_request, push) => {
                  for (let slot = 71; slot <= 80; slot++) {
                    chain.tip = slot;
                    for (const u of chain.meta(slot)) await push(u);
                  }
                }, 40);
          fakes.push(fake);
          return fake;
        },
      },
    );
    const run = start(stream);
    await waitFor(() => (store.cursor?.watermark ?? 0) >= 80, 8_000, 'the cursor');
    stream.stop();
    await run;
    expect(Object.keys(fakes[0].requests[0].transactions)).toEqual(['fees']);
    expect(fakes[1].requests[0].transactions).toEqual({});
    expect(Object.keys(fakes[1].requests[0].blocksMeta)).toEqual(['blocks']);
    expect(await store.epochRows(2)).toEqual(expectedRows(chain, 71, 80));
    expect(slotPayloads(store).every((p) => p.source === 'hybrid')).toBe(true);
    // Skipped slots come from the block meta's parent, not from RPC.
    expect(chain.calls.getBlock).not.toContain(77);
  });

  it('polls RPC without a gRPC key and keeps a write that failed for the next flush', async () => {
    const chain = new FakeChain(32, () => false, 50);
    const store = new MemoryIndexerStore();
    store.failNextBatch = true;
    const stream = new SlotStream({ ...OPTIONS, mode: 'auto', endpoints: [] }, { rpc: chain.rpc, store });
    const run = start(stream);
    await waitFor(() => store.slotFees.size > 0, 8_000, 'a row');
    for (let i = 0; i < 6; i++) {
      chain.tip++;
      await new Promise((r) => setTimeout(r, 15));
    }
    await waitFor(() => (store.cursor?.watermark ?? 0) >= chain.tip, 8_000, 'the cursor');
    stream.stop();
    await run;
    expect(stream.stats.source).toBe('rpc');
    expect([...store.slotFees.keys()].sort()).toEqual(expectedRows(chain, 50, chain.tip).map((r) => r.slot));
    expect(slotPayloads(store).every((p) => p.source === 'rpc')).toBe(true);
  });

  it('never rewrites an epoch_index value that was already posted on-chain', async () => {
    const chain = new FakeChain(32, () => false, 60);
    const store = new MemoryIndexerStore();
    store.cursor = { watermark: 60, runStart: 32 };
    store.epochIndex.set(1, { value: 1, postedSignature: 'sig' });
    // Slots 32–60 of epoch 1 are already stored.
    for (const row of expectedRows(chain, 32, 60)) store.slotFees.set(row.slot, row);
    const fake = new FakeGrpcStream(async (_request, push) => {
      for (let slot = 61; slot <= 66; slot++) for (const u of chain.firehose(slot)) await push(u);
    }, 50);
    const stream = new SlotStream(OPTIONS, { rpc: chain.rpc, store, createGrpcStream: () => fake });
    const run = start(stream);
    await waitFor(() => (store.cursor?.watermark ?? 0) >= 66, 8_000, 'the cursor');
    await new Promise((r) => setTimeout(r, 50));
    stream.stop();
    await run;
    expect(store.epochIndex.get(1)).toEqual({ value: 1, postedSignature: 'sig' });
    expect(store.notifications.some((n) => n.t === 'epoch')).toBe(false);
  });

  it('after a restart, checks only the epoch before the cursor’s again, not every epoch since the run began', async () => {
    const chain = new FakeChain(32, () => false, 104);
    const store = new MemoryIndexerStore();
    // An earlier run covered slots 0–100 and rolled epochs 0, 1 and 2 up.
    store.cursor = { watermark: 100, runStart: 0 };
    for (const row of expectedRows(chain, 0, 100)) store.slotFees.set(row.slot, row);
    for (const epoch of [0, 1, 2]) store.epochIndex.set(epoch, { value: 111, postedSignature: null });
    const fake = new FakeGrpcStream(async (request, push) => {
      for (let slot = Number(request.fromSlot); slot <= 110; slot++) {
        chain.tip = Math.max(chain.tip, slot);
        for (const u of chain.firehose(slot)) await push(u);
      }
    }, 50);
    const stream = new SlotStream(OPTIONS, { rpc: chain.rpc, store, createGrpcStream: () => fake });
    const run = start(stream);
    await waitFor(() => (store.cursor?.watermark ?? 0) >= 110, 8_000, 'the cursor');
    await waitFor(() => store.notifications.some((n) => n.t === 'epoch'), 8_000, 'the epoch 2 re-check');
    stream.stop();
    await run;
    expect(fake.requests[0].fromSlot).toBe('101');
    expect(store.epochIndex.get(0)).toEqual({ value: 111, postedSignature: null });
    expect(store.epochIndex.get(1)).toEqual({ value: 111, postedSignature: null });
    // Epoch 2 is recomputed (a crash may have come between its last batch and its rollup); nothing older is.
    expect(store.notifications.filter((n) => n.t === 'epoch').map((n) => n.epoch)).toEqual([2]);
    expect(store.epochIndex.get(2)?.value).toBe(rollupRows(expectedRows(chain, 64, 95), stakeMap(chain)).value);
  });

  it('keeps live RPC fetches flowing while a long gap fill waits on its own rate limit', async () => {
    // The cursor is 390 slots behind: polling starts at the tip, and the gap filler works through 11–399 at 5 blocks/s.
    const chain = new FakeChain(32, () => false, 400);
    const store = new MemoryIndexerStore();
    store.cursor = { watermark: 10, runStart: 0 };
    const stream = new SlotStream(
      { ...OPTIONS, mode: 'rpc', endpoints: [], gapFillRps: 5, gapFillConcurrency: 1 },
      { rpc: chain.rpc, store },
    );
    const run = start(stream);
    await waitFor(() => chain.calls.getBlock.includes(11), 8_000, 'the gap fill');
    chain.tip = 405;
    // A gap-fill batch takes 1.6 s here; the new slots must not wait for it.
    await waitFor(() => slotPayloads(store).some((p) => p.slot === 405), 1_000, 'live slot 405');
    stream.stop();
    await run;
    expect(slotPayloads(store).map((p) => p.slot)).toEqual(expect.arrayContaining([400, 401, 402, 403, 404, 405]));
    expect(slotPayloads(store).every((p) => p.source === 'rpc')).toBe(true);
    expect(store.cursor?.watermark ?? 0).toBeLessThan(100);
  });
});
