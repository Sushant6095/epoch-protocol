import { buildCandles, CANDLE_INTERVAL_SECONDS, fillCandles, MAX_CANDLES } from './candles';

const T0 = 1_791_034_200; // a 15-minute boundary

describe('buildCandles', () => {
  it('buckets trades into OHLC by time, open = earliest, close = latest, with volume and counts', () => {
    const candles = buildCandles(
      [
        { t: T0 + 70, priceSol: 3, volumeSol: 0.5 },
        { t: T0 + 10, priceSol: 2, volumeSol: 0.2 },
        { t: T0 + 40, priceSol: 5, volumeSol: 0.1 },
        { t: T0 + 50, priceSol: 1 }, // a price sample: no volume, not a trade
      ],
      '1m',
    );
    expect(candles).toEqual([
      { t: T0, open: 2, high: 5, low: 1, close: 1, volumeSol: 0.30000000000000004, trades: 2 },
      { t: T0 + 60, open: 3, high: 3, low: 3, close: 3, volumeSol: 0.5, trades: 1 },
    ]);
  });

  it('fills empty buckets at the previous close, and only after the first price', () => {
    const candles = buildCandles(
      [
        { t: T0 + 5, priceSol: 2, volumeSol: 1 },
        { t: T0 + 185, priceSol: 4, volumeSol: 1 },
      ],
      '1m',
      {
        from: T0 - 120,
        to: T0 + 240,
      },
    );
    expect(candles.map((c) => [c.t - T0, c.open, c.close, c.trades])).toEqual([
      [0, 2, 2, 1],
      [60, 2, 2, 0],
      [120, 2, 2, 0],
      [180, 4, 4, 1],
      [240, 4, 4, 0],
    ]);
    expect(
      buildCandles([{ t: T0 + 5, priceSol: 2 }], '1m', { from: T0 - 120, to: T0, previousClose: 1.5 })[0],
    ).toMatchObject({ t: T0 - 120, close: 1.5 });
    expect(
      buildCandles([{ t: T0 + 5, priceSol: 2 }], '1m', { fill: false, from: T0 - 120, to: T0 + 120 }),
    ).toHaveLength(1);
  });

  it('returns at most MAX_CANDLES, the newest, and drops bad points', () => {
    const points = Array.from({ length: 1_500 }, (_, i) => ({ t: T0 + i * 60, priceSol: i + 1, volumeSol: 1 }));
    const candles = buildCandles([...points, { t: NaN, priceSol: 1 }, { t: T0, priceSol: 0 }], '1m');
    expect(candles).toHaveLength(MAX_CANDLES);
    expect(candles[candles.length - 1]).toMatchObject({ t: T0 + 1_499 * 60, close: 1_500 });
    expect(buildCandles([], '1h')).toEqual([]);
    expect(CANDLE_INTERVAL_SECONDS['4h']).toBe(14_400);
  });
});

describe('fillCandles', () => {
  it('fills the gaps between sparse (SQL) candles from the previous close', () => {
    const sparse = [
      { t: T0, open: 1, high: 2, low: 1, close: 2, volumeSol: 1, trades: 2 },
      { t: T0 + 1_800, open: 3, high: 3, low: 3, close: 3, volumeSol: 1, trades: 1 },
    ];
    const filled = fillCandles(sparse, '15m', { from: T0 - 900, to: T0 + 2_700, previousClose: 0.5 });
    expect(filled.map((c) => [c.t - T0, c.close, c.trades])).toEqual([
      [-900, 0.5, 0],
      [0, 2, 2],
      [900, 2, 0],
      [1_800, 3, 1],
      [2_700, 3, 0],
    ]);
    expect(fillCandles(sparse, '15m', { from: T0 + 900, to: T0 })).toEqual([]);
  });
});
