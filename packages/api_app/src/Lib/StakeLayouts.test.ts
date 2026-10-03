import { isDelegated, parseStakeHistory, parseStakeSlice, STAKE_SLICE, U64_MAX } from './StakeLayouts';

describe('parseStakeHistory', () => {
  it('reads entries newest first', () => {
    const buf = Buffer.alloc(8 + 2 * 32);
    buf.writeBigUInt64LE(2n, 0);
    const write = (i: number, epoch: bigint, eff: bigint, act: bigint, deact: bigint) => {
      const at = 8 + i * 32;
      buf.writeBigUInt64LE(epoch, at);
      buf.writeBigUInt64LE(eff, at + 8);
      buf.writeBigUInt64LE(act, at + 16);
      buf.writeBigUInt64LE(deact, at + 24);
    };
    write(0, 1045n, 441_250_850_144_183_900n, 1_131_229_993_919_478n, 1_888_893_791_604_993n);
    write(1, 1044n, 440_550_864_622_403_860n, 1_839_008_949_345_099n, 1_196_613_505_585_564n);
    const entries = parseStakeHistory(buf);
    expect(entries).toHaveLength(2);
    expect(entries[0].epoch).toBe(1045);
    expect(Number(entries[0].effectiveLamports) / 1e9).toBeCloseTo(441_250_850, 0);
    expect(entries[1].epoch).toBe(1044);
  });

  it('stops at the end of a truncated buffer', () => {
    const buf = Buffer.alloc(8 + 32);
    buf.writeBigUInt64LE(5n, 0);
    expect(parseStakeHistory(buf)).toHaveLength(1);
    expect(parseStakeHistory(Buffer.alloc(4))).toEqual([]);
  });
});

describe('parseStakeSlice', () => {
  it('reads withdrawer, stake and epochs from the 44..180 slice', () => {
    const slice = Buffer.alloc(STAKE_SLICE.length);
    Buffer.alloc(32, 7).copy(slice, 0); // withdrawer
    slice.writeBigUInt64LE(25_000_000_000n, 112); // 25 SOL
    slice.writeBigUInt64LE(1040n, 120);
    slice.writeBigUInt64LE(U64_MAX, 128);
    const stake = parseStakeSlice(slice);
    expect(stake?.withdrawerKey).toBe(Buffer.alloc(32, 7).toString('base64'));
    expect(stake?.stakeLamports).toBe(25_000_000_000n);
    expect(stake?.activationEpoch).toBe(1040n);
    expect(stake && isDelegated(stake)).toBe(true);
  });

  it('treats a deactivating account as no longer delegated', () => {
    const slice = Buffer.alloc(STAKE_SLICE.length);
    slice.writeBigUInt64LE(1046n, 128);
    const stake = parseStakeSlice(slice);
    expect(stake && isDelegated(stake)).toBe(false);
    expect(parseStakeSlice(Buffer.alloc(10))).toBeUndefined();
  });
});
