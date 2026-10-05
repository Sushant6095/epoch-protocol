import { SolamiUsage } from '@epoch/solana';

import { type DemoSnapshot, formatDemo, istClock } from './DemoReport';

const AT = Date.UTC(2026, 9, 5, 3, 42, 4); // 09:12:04 IST

function snapshot(patch: Partial<DemoSnapshot> = {}): DemoSnapshot {
  const usage = new SolamiUsage('demo', () => AT);
  usage.recordRpc('https://api.mainnet-beta.solana.com', 'getBlock', 120, 'ok');
  usage.recordRpc('https://api.mainnet-beta.solana.com', 'getSlot', 40, 'ok');
  return {
    at: AT,
    elapsedSeconds: 60,
    stats: {
      source: 'rpc',
      status: 'polling',
      endpoint: 'api.mainnet-beta.solana.com',
      tipSlot: 453_592_232,
      processedSlot: 453_592_230,
      watermark: null,
      lagSlots: 2,
      gapSlots: 0,
      lostSlots: 0,
      lateTransactions: 0,
      leaderFromRewards: 0,
    },
    blocks: 15,
    latest: {
      fees: {
        slot: 453_592_230,
        leader: 'BeachsideXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        medianCuPrice: 18_750,
        p25CuPrice: 1,
        p75CuPrice: 2,
        p90CuPrice: 3,
        pricedTxs: 266,
        unpricedTxs: 158,
        leaderPaidTxs: 1,
        failedTxs: 133,
      },
      epoch: 1050,
      blockTime: 1_791_171_100,
      source: 'rpc',
    },
    estimate: {
      t: 'index',
      epoch: 1050,
      estimate: 10_926,
      leaders: 237,
      slotsWithFees: 650,
      pricedTxs: 190_851,
      firstSlot: 1,
      processedSlot: 2,
      watermarkSlot: null,
      tipSlot: 3,
      stakeEpoch: 1050,
      source: 'rpc',
      endpoint: 'api.mainnet-beta.solana.com',
      status: 'polling',
      stride: 4,
      lastSlotAt: AT,
    },
    usage: usage.report(),
    stride: 4,
    ...patch,
  };
}

describe('formatDemo', () => {
  it('prints the source and lag, the newest block, the running index and the Solami usage', () => {
    expect(istClock(AT)).toBe('09:12:04');
    expect(formatDemo(snapshot())).toEqual([
      '[09:12:04 IST] rpc · polling · api.mainnet-beta.solana.com · tip 453,592,232 · processed 453,592,230 · lag 2 slots (0.8 s)',
      '  newest block 453,592,230 · leader Beachsid… · median 18,750 µL/CU · 266 priced, 158 unpriced, 1 leader-paid, 133 failed · 15 blocks (15.0/min)',
      '  epoch 1050 running Fee Index 10,926 µL/CU · 237 staked leaders · 650 slots · sampled 1 slot in 4',
      '  Solami: gRPC off (no SOLAMI_TOKEN: RPC polling) · RPC api.mainnet-beta.solana.com (not Solami) 2 calls, p50 40 ms, p95 120 ms, 0 errors',
    ]);
  });

  it('shows the gRPC stream’s bytes and a recent error', () => {
    const usage = new SolamiUsage('demo', () => AT);
    usage.grpc({ subscription: 'meta', endpoint: 'solami', status: 'streaming', compression: 'zstd' });
    usage.grpcUpdate(3 * 1024 * 1024);
    usage.recordRpc('https://rpc.solami.dev/sol?api_key=x', 'getBlock', 90, 'rate-limited', '-32005: Rate limited');
    const lines = formatDemo(snapshot({ usage: usage.report(), latest: null, estimate: null, stride: 1 }));
    expect(lines[1]).toBe('  waiting for the first block…');
    expect(lines[2]).toBe(
      '  Solami: gRPC meta streaming on solami, 3.0 MiB in 1 updates (51.2 KiB/s), zstd · RPC rpc.solami.dev 1 calls, p50 90 ms, p95 90 ms, 1 errors (1 rate-limited)',
    );
    expect(lines[3]).toBe('  last error (rpc): getBlock on rpc.solami.dev: -32005: Rate limited');
  });
});
