import {
  crowdForecast,
  historySigma,
  impliedProbability,
  nonIncreasingFit,
  normCdf,
  normInv,
  type StrikeQuote,
} from './CrowdForecast';

/** Quotes priced exactly from a lognormal(μ, σ). */
function lognormalQuotes(median: number, sigma: number, strikes: number[]): StrikeQuote[] {
  return strikes.map((strike) => {
    const yes = 1 - normCdf((Math.log(strike) - Math.log(median)) / sigma);
    return { strike, yesPrice: yes, noPrice: 1 - yes, volumeUsdc: 100 };
  });
}

describe('CrowdForecast', () => {
  it('reads a probability from YES and NO prices', () => {
    expect(impliedProbability(0.52, 0.48)).toBeCloseTo(0.52, 10);
    expect(impliedProbability(0.6, 0.5)).toBeCloseTo(0.5455, 4);
    expect(impliedProbability(0.3, null)).toBe(0.3);
    expect(impliedProbability(null, 0.4)).toBeNull();
    expect(impliedProbability(1.2, 0.1)).toBeNull();
    expect(impliedProbability(0, 0)).toBe(0);
  });

  it('pools strikes whose prices break monotonicity', () => {
    expect(nonIncreasingFit([0.7, 0.75, 0.3], [1, 1, 1])).toEqual([0.725, 0.725, 0.3]);
    expect(nonIncreasingFit([0.8, 0.5, 0.2], [1, 1, 1])).toEqual([0.8, 0.5, 0.2]);
    const [a, b] = nonIncreasingFit([0.2, 0.6], [3, 1]);
    expect([a, b].map((value) => Math.round(value * 1e9) / 1e9)).toEqual([0.3, 0.3]);
  });

  it('has an accurate normal quantile and CDF', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 9);
    expect(normInv(0.9)).toBeCloseTo(1.2815515655446004, 8);
    expect(normInv(0.01)).toBeCloseTo(-2.3263478740408408, 8);
    expect(normCdf(1.2815515655446004)).toBeCloseTo(0.9, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it('recovers a lognormal from a three-strike ladder', () => {
    const forecast = crowdForecast(lognormalQuotes(1_200, 0.25, [1_000, 1_200, 1_500]), []);
    expect(forecast.fit?.method).toBe('lognormal-fit');
    expect(forecast.fit?.sigma).toBeCloseTo(0.25, 3);
    expect(forecast.median).toBe(1_200);
    expect(forecast.mean).toBe(1_238); // 1,200 × e^(0.25² / 2)
    expect(forecast.band).toEqual({ low: 871, high: 1_653, coverage: 0.8 });
    expect(forecast.points.map((point) => point.fitted)).toEqual(forecast.points.map((point) => point.implied));
    expect(forecast.points[1]).toMatchObject({ strike: 1_200, implied: 0.5, curve: 0.5 });
  });

  it('takes σ from the index history when only one strike trades', () => {
    const history = [1_300, 1_250, 1_400, 1_200, 1_300];
    const forecast = crowdForecast([{ strike: 1_300, yesPrice: 0.5, noPrice: 0.5, volumeUsdc: 0 }], history);
    expect(forecast.fit).toMatchObject({ method: 'lognormal-history-sigma', strikesUsed: 1 });
    expect(forecast.median).toBe(1_300);
    expect(forecast.fit?.sigma).toBeCloseTo(historySigma(history), 6);
    expect(forecast.band?.low).toBeLessThan(1_300);
    expect(forecast.band?.high).toBeGreaterThan(1_300);
    // A YES price above one half moves the median above the strike.
    const bullish = crowdForecast([{ strike: 1_300, yesPrice: 0.7, noPrice: 0.3, volumeUsdc: 0 }], history);
    expect(bullish.median).toBeGreaterThan(1_300);
  });

  it('falls back to the history σ when the pooled prices are flat', () => {
    const forecast = crowdForecast(
      [
        { strike: 1_000, yesPrice: 0.4, noPrice: 0.6, volumeUsdc: 10 },
        { strike: 1_200, yesPrice: 0.6, noPrice: 0.4, volumeUsdc: 10 },
      ],
      [],
    );
    expect(forecast.points.map((point) => point.fitted)).toEqual([0.5, 0.5]);
    expect(forecast.fit?.method).toBe('lognormal-history-sigma');
    expect(forecast.median).toBe(1_095); // √(1,000 × 1,200)
  });

  it('says why there is no forecast', () => {
    expect(crowdForecast([], [])).toMatchObject({ median: null, reason: 'no markets on this epoch yet' });
    const unpriced = crowdForecast([{ strike: 1_300, yesPrice: null, noPrice: null, volumeUsdc: 0 }], []);
    expect(unpriced).toMatchObject({ median: null, band: null, fit: null, reason: 'no live prices yet' });
    expect(unpriced.points).toEqual([{ strike: 1_300, implied: null, fitted: null, curve: null }]);
  });

  it('measures σ from log changes, scaled by the horizon', () => {
    expect(historySigma([1_000, 1_000, 1_000, 1_000, 1_000])).toBe(0.05);
    expect(historySigma([1_000, 1_100])).toBe(0.35);
    const sigma = historySigma([1_300, 1_250, 1_400, 1_200, 1_300]);
    expect(historySigma([1_300, 1_250, 1_400, 1_200, 1_300], 4)).toBeCloseTo(sigma * 2, 10);
  });
});
