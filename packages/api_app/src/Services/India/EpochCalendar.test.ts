import { financialYear } from '../../Lib/IndianFy';
import stakewiz from './__fixtures__/stakewiz-epochs.recorded.json';
import { buildEpochSpans, EpochCalendar, epochsEndingIn } from './EpochCalendar';

const ist = (ms: number): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 19);

describe('EpochCalendar (recorded Stakewiz epochs, 3 Oct 2026)', () => {
  const spans = buildEpochSpans(stakewiz.body, 1048);

  it('ends an epoch when the next one starts, and leaves out the current one', () => {
    expect(spans.has(1048)).toBe(false);
    // Epoch 948 ended at 949's start, 31 Mar 2026 04:43 IST (Stakewiz's own end for 948 says 04:42:05).
    expect(ist(spans.get(948)?.endMs ?? 0)).toBe('2026-03-31T04:43:01');
    expect(ist(spans.get(949)?.endMs ?? 0)).toBe('2026-04-02T03:41:01');
    expect(ist(spans.get(1047)?.endMs ?? 0)).toBe('2026-10-03T03:20:01');
    // 952's successor is not in the list: Stakewiz's `end` is used.
    expect(spans.get(952)?.endMs).toBe(Date.parse('2026-04-07T21:34:07+02:00'));
  });

  it('puts each epoch in the financial year its end falls in (IST)', () => {
    const fy2526 = financialYear(2025);
    const fy2627 = financialYear(2026);
    expect(epochsEndingIn(spans, fy2526.startMs, fy2526.endMs).map((s) => s.epoch)).toEqual([944, 945, 946, 947, 948]);
    expect(epochsEndingIn(spans, fy2627.startMs, fy2627.endMs).map((s) => s.epoch)).toEqual([
      949, 950, 951, 952, 1043, 1044, 1045, 1046, 1047,
    ]);
  });

  it('re-reads Stakewiz once a new epoch has started', async () => {
    let now = Date.parse('2026-10-03T13:00:00Z');
    let current = 1048;
    const getEpochHistory = jest.fn(async () => stakewiz.body);
    const calendar = new EpochCalendar(
      { getEpochHistory },
      async () => current,
      () => now,
    );
    expect((await calendar.spans()).has(1047)).toBe(true);
    current = 1049;
    now += 30_000;
    await calendar.spans();
    expect(getEpochHistory).toHaveBeenCalledTimes(1);
    now += 60_000;
    expect((await calendar.spans()).has(1048)).toBe(true);
    expect(getEpochHistory).toHaveBeenCalledTimes(2);
  });
});
