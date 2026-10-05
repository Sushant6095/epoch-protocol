import { clockAt, key, NOW } from '../__fixtures__/fakes';
import { DEFAULT_SCHEDULE, firstSlotOf, marketWindow, secondsPerSlotFrom, slotTimeMs } from './EpochSchedule';
import {
  explorerUrl,
  marketDescription,
  marketQuestion,
  marketText,
  type MarketTextInput,
  marketTitle,
  resolutionRule,
  resolutionUrl,
  sourcesOfTruth,
  utcIso,
} from './MarketText';
import { byCentrality, quantile, roundThreshold, strikeLadder, strikeQuantiles } from './Thresholds';

const SEC = NOW / 1_000;

describe('EpochSchedule', () => {
  const clock = clockAt();

  it('places epochs on the slot clock', () => {
    expect(firstSlotOf(clock, 1_051)).toBe(454_032_000);
    expect(firstSlotOf(clock, 1_050)).toBe(1_050 * 432_000);
    expect(slotTimeMs(clock, clock.absoluteSlot + 1_000)).toBe(NOW + 400_000);
  });

  it('closes trading before the epoch starts and resolves after it ends, with margins', () => {
    const window = marketWindow(clock, 1_051, DEFAULT_SCHEDULE);
    // 332,000 slots (132,800 s) to the start; 2% margin (2,656 s) and one hour before it.
    expect(window).toMatchObject({
      epoch: 1_051,
      firstSlot: 454_032_000,
      lastSlot: 454_463_999,
      startTime: SEC + 3_600 + 600,
      endTime: SEC + 132_800 - 2_656 - 3_600,
      resolutionTime: SEC + 305_600 + 6_112 + 6 * 3_600,
      ok: true,
      reason: null,
    });
    expect(window.tradingSeconds).toBe(122_344);
    expect(window.estStartMs).toBe(NOW + 132_800_000);
    expect(window.startTime).toBeLessThan(window.endTime);
    expect(window.endTime).toBeLessThanOrEqual(window.resolutionTime);
  });

  it('skips an epoch that started or leaves too little trading time', () => {
    expect(marketWindow(clock, 1_050, DEFAULT_SCHEDULE)).toMatchObject({
      ok: false,
      reason: 'epoch 1050 has already started',
    });
    const late = clockAt({ slotIndex: 400_000, absoluteSlot: 1_050 * 432_000 + 400_000 });
    const window = marketWindow(late, 1_051, DEFAULT_SCHEDULE);
    expect(window.ok).toBe(false);
    expect(window.reason).toMatch(/h of trading left before epoch 1051 starts/);
    expect(marketWindow(late, 1_052, DEFAULT_SCHEDULE).ok).toBe(true);
  });

  it('measures seconds per slot from performance samples, clamped', () => {
    expect(secondsPerSlotFrom([{ numSlots: 150, samplePeriodSecs: 60 }])).toBeCloseTo(0.4);
    expect(secondsPerSlotFrom([])).toBe(0.4);
    expect(secondsPerSlotFrom([{ numSlots: 10, samplePeriodSecs: 60 }])).toBe(0.8);
    expect(secondsPerSlotFrom([{ numSlots: 1_000, samplePeriodSecs: 60 }])).toBe(0.3);
  });
});

describe('Thresholds', () => {
  it('rounds to a readable step for the size of the value', () => {
    expect(roundThreshold(1_284)).toBe(1_300);
    expect(roundThreshold(1_274)).toBe(1_250);
    expect(roundThreshold(87.4)).toBe(87);
    expect(roundThreshold(455)).toBe(460);
    expect(roundThreshold(12_345)).toBe(12_500);
    expect(roundThreshold(0)).toBe(0);
    expect(roundThreshold(Number.NaN)).toBe(0);
  });

  it('takes strikes at quantiles 20 points apart around the median of recent final values', () => {
    expect(strikeQuantiles(1)).toEqual([0.5]);
    expect(strikeQuantiles(3)).toEqual([0.3, 0.5, 0.7]);
    expect(strikeQuantiles(5)).toEqual([0.1, 0.3, 0.5, 0.7, 0.9]);
    expect(strikeQuantiles(4)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(strikeLadder([1_284, 990, 1_500], 1)).toEqual([1_300]);
    expect(strikeLadder([], 1)).toEqual([]);
    expect(strikeLadder([0, -5], 1)).toEqual([]);
    const history = Array.from({ length: 10 }, (_, i) => 1_000 + i * 20);
    // p30 = 1,054 → 1,050; p50 = 1,090 → 1,100; p70 = 1,126 → 1,150
    expect(strikeLadder(history, 3)).toEqual([1_050, 1_100, 1_150]);
    // a flat stretch still gives three distinct strikes, one rounding step apart
    expect(strikeLadder([1_000, 1_000, 1_000], 3)).toEqual([1_000, 1_050, 1_100]);
    expect(strikeLadder([40, 41, 40], 2)).toEqual([40, 41]);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('creates the middle strike first when the budget cannot pay for all', () => {
    const rows = [{ threshold: 1_150 }, { threshold: 1_050 }, { threshold: 1_100 }];
    expect(byCentrality(rows).map((row) => row.threshold)).toEqual([1_100, 1_050, 1_150]);
    const four = [1, 2, 3, 4].map((threshold) => ({ threshold }));
    expect(byCentrality(four).map((row) => row.threshold)).toEqual([2, 3, 1, 4]);
  });
});

describe('MarketText', () => {
  const window = marketWindow(clockAt(), 1_051, DEFAULT_SCHEDULE);
  const input: MarketTextInput = {
    epoch: 1_051,
    threshold: 1_300,
    window,
    publicApiUrl: 'https://api.epoch.example/',
    methodologyUrl: 'https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md',
    feeIndexAccount: { address: key(30), cluster: 'devnet' },
    graceHours: 48,
    reference: { epoch: 1_049, value: 1_284 },
  };

  it('asks a stable ASCII question per epoch and threshold', () => {
    const question = marketQuestion(1_051, 1_300);
    expect(question).toBe('Will the Solana Fee Index for epoch 1051 close above 1,300 micro-lamports per CU?');
    expect(/^[\x20-\x7e]+$/.test(question)).toBe(true);
    expect(marketTitle(1_051, 1_300)).toBe('Solana Fee Index above 1,300 µL/CU in epoch 1051');
  });

  it('writes a precise resolution rule within Panta’s limit', () => {
    const rule = resolutionRule(input);
    expect(rule.length).toBeLessThanOrEqual(2_048);
    for (const part of [
      'Solana mainnet epoch 1051 is strictly greater than 1,300',
      'A value equal to 1,300 resolves NO',
      'stake-weighted median',
      'excluding transactions whose fee payer is the slot leader',
      'https://api.epoch.example/v1/index/epochs/1051',
      'data.status "final"',
      `FeeIndex account ${key(30)} (Solana devnet)`,
      'If the value for epoch 1051 is vetoed',
      `published by ${utcIso(window.resolutionTime + 48 * 3_600)} UTC, the market resolves NO`,
      'mainnet slots 454032000 to 454463999',
    ]) {
      expect(rule).toContain(part);
    }
    expect(utcIso(0)).toBe('1970-01-01T00:00:00Z');
    // Even with huge numbers the rule fits.
    expect(resolutionRule({ ...input, epoch: 99_999_999, threshold: 9_999_999_999 }).length).toBeLessThanOrEqual(2_048);
  });

  it('lists the endpoint, the methodology and the on-chain account as sources of truth', () => {
    expect(sourcesOfTruth(input)).toEqual([
      'https://api.epoch.example/v1/index/epochs/1051',
      input.methodologyUrl,
      `https://explorer.solana.com/address/${key(30)}?cluster=devnet`,
    ]);
    expect(sourcesOfTruth({ ...input, feeIndexAccount: null })).toHaveLength(2);
    expect(explorerUrl({ address: key(30), cluster: 'mainnet' })).toBe(
      `https://explorer.solana.com/address/${key(30)}`,
    );
    expect(explorerUrl({ address: key(30), cluster: 'localnet' })).toContain('?cluster=custom');
    expect(resolutionUrl('https://api.epoch.example///', 7)).toBe('https://api.epoch.example/v1/index/epochs/7');
  });

  it('describes the market with its expected dates and the last value', () => {
    const description = marketDescription(input);
    expect(description).toContain('Will epoch 1051 (expected 2026-10-05 00:53 to 2026-10-07 00:53 UTC)');
    expect(description).toContain('Epoch 1049 closed at 1,284 µL/CU.');
    expect(marketText(input)).toMatchObject({
      question: marketQuestion(1_051, 1_300),
      title: marketTitle(1_051, 1_300),
      description,
    });
  });
});
