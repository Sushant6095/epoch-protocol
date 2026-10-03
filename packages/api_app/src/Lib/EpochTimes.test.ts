import { epochAt, epochEndMs, parseStakewizTime } from './EpochTimes';

describe('parseStakewizTime', () => {
  it('reads Stakewiz timestamps with microseconds and short offsets', () => {
    expect(new Date(parseStakewizTime('2026-02-22 01:24:11.135988+01')).toISOString()).toBe('2026-02-22T00:24:11.135Z');
    expect(new Date(parseStakewizTime('2026-10-02 23:49:46+02')).toISOString()).toBe('2026-10-02T21:49:46.000Z');
    expect(parseStakewizTime('soon')).toBeNaN();
  });
});

describe('epochAt and epochEndMs', () => {
  // Real Stakewiz start times (all_epochs_history).
  const starts = [
    { epoch: 1047, startMs: parseStakewizTime('2026-10-01 15:41:02.307581+02') },
    { epoch: 1046, startMs: parseStakewizTime('2026-09-30 07:37:01.430595+02') },
    { epoch: 1045, startMs: parseStakewizTime('2026-09-28 23:30:01.609886+02') },
  ];
  const clock = { epoch: 1047, startMs: starts[0].startMs, msPerEpoch: 115_700_000 };

  it('finds the epoch that contains a moment', () => {
    expect(epochAt(parseStakewizTime('2026-09-30 07:37:01+02'), starts, clock)).toBe(1045);
    expect(epochAt(parseStakewizTime('2026-09-30 07:37:02+02'), starts, clock)).toBe(1046);
    expect(epochAt(parseStakewizTime('2026-10-02 12:00:00+02'), starts, clock)).toBe(1047);
  });

  it('counts back with the slot clock before the known start times (to within an epoch)', () => {
    expect(epochAt(starts[2].startMs - 12 * 3_600_000, starts, clock)).toBe(1044);
    expect(epochAt(starts[0].startMs - 3 * 115_700_000 - 1, [], clock)).toBe(1043);
    expect(epochAt(starts[0].startMs + 1, [], clock)).toBe(1047);
  });

  it('ends an epoch where the next one starts', () => {
    expect(epochEndMs(1045, starts, clock)).toBe(starts[1].startMs);
    expect(epochEndMs(1047, starts, clock)).toBe(starts[0].startMs + 115_700_000);
    expect(epochEndMs(1040, starts, clock)).toBe(starts[0].startMs - 6 * 115_700_000);
  });
});
