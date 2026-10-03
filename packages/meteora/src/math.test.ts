import {
  averageRevenueSol,
  backingRatio,
  curveBand,
  dammSeedSol,
  endEpochOf,
  epochsLeft,
  impliedYieldPctPerEpoch,
  launchBand,
  marketCapSol,
  shareRevenuePerEpochSol,
  shareValueSol,
  upfrontToValidatorSol,
} from './math';

// The Launch spec's fixture numbers (handover pages/launch.md, launches.sample.json), current epoch 1044.
const CURRENT_EPOCH = 1044;
const SUPPLY = 100_000;

describe('band and value per token', () => {
  it('reproduces rKEST: 5% of 20.8 SOL for 100 epochs over 100,000 tokens', () => {
    const band = launchBand({ avgRevenueSol: 20.8, shareBps: 500, termEpochs: 100, supply: SUPPLY });
    expect(band.shareRevenuePerEpochSol).toBeCloseTo(1.04, 12);
    expect(band.shareValueSol).toBeCloseTo(104, 10);
    expect(band.valuePerTokenSol).toBeCloseTo(0.00104, 15);
    expect(band.bandLowSol).toBeCloseTo(0.000624, 15);
    expect(band.bandHighSol).toBeCloseTo(0.000988, 15);
  });

  it('reproduces rSALT and rTIDE', () => {
    const salt = launchBand({ avgRevenueSol: 29.4, shareBps: 1000, termEpochs: 80, supply: SUPPLY });
    expect(salt.bandLowSol).toBeCloseTo(0.001411, 6);
    expect(salt.bandHighSol).toBeCloseTo(0.002234, 6);
    const tide = launchBand({ avgRevenueSol: 8, shareBps: 1500, termEpochs: 60, supply: SUPPLY });
    expect(tide.shareRevenuePerEpochSol).toBeCloseTo(1.2, 12);
    expect(tide.bandLowSol).toBeCloseTo(0.000432, 15);
    expect(tide.bandHighSol).toBeCloseTo(0.000684, 15);
  });

  it('keeps the band at 60% and 95% of the value', () => {
    expect(curveBand(1)).toEqual({ valuePerTokenSol: 1, bandLowSol: 0.6, bandHighSol: 0.95 });
    expect(shareRevenuePerEpochSol(10, 2_500)).toBe(2.5);
    expect(shareValueSol({ avgRevenueSol: 10, shareBps: 2_500, termEpochs: 4 })).toBe(10);
    expect(() => launchBand({ avgRevenueSol: 1, shareBps: 1, termEpochs: 1, supply: 0 })).toThrow(RangeError);
  });
});

describe('term', () => {
  it('ends after term epochs and counts the current epoch as left', () => {
    expect(endEpochOf(1043, 100)).toBe(1142);
    expect(epochsLeft({ startEpoch: 1043, termEpochs: 100, currentEpoch: CURRENT_EPOCH })).toBe(99);
    expect(epochsLeft({ startEpoch: 1030, termEpochs: 80, currentEpoch: CURRENT_EPOCH })).toBe(66);
  });

  it('clamps to the term before it starts and to zero after it ends', () => {
    expect(epochsLeft({ startEpoch: 1046, termEpochs: 60, currentEpoch: CURRENT_EPOCH })).toBe(60);
    expect(epochsLeft({ startEpoch: 1000, termEpochs: 10, currentEpoch: CURRENT_EPOCH })).toBe(0);
    expect(epochsLeft({ startEpoch: 1000, termEpochs: 45, currentEpoch: CURRENT_EPOCH })).toBe(1);
  });
});

describe('market cap, implied yield and backing', () => {
  it('reproduces rKEST: 83.4 SOL fully diluted, 1.25% per epoch, backing 1.23×', () => {
    const cap = marketCapSol(0.000846, SUPPLY, 1_430);
    expect(cap).toBeCloseTo(83.39, 2);
    expect(impliedYieldPctPerEpoch(1.04, cap)).toBeCloseTo(1.25, 2);
    expect(backingRatio(1.04, 99, cap)).toBeCloseTo(1.23, 2);
  });

  it('reproduces rSALT: 1.43% per epoch, backing 0.94×', () => {
    const cap = marketCapSol(0.00215, SUPPLY, 4_140);
    expect(cap).toBeCloseTo(206.1, 1);
    expect(impliedYieldPctPerEpoch(2.94, cap)).toBeCloseTo(1.43, 2);
    expect(backingRatio(2.94, 66, cap)).toBeCloseTo(0.94, 2);
  });

  it('has no market cap, yield or backing without a price', () => {
    expect(marketCapSol(null, SUPPLY, 0)).toBeNull();
    expect(impliedYieldPctPerEpoch(1.2, null)).toBeNull();
    expect(backingRatio(1.2, 60, null)).toBeNull();
    expect(impliedYieldPctPerEpoch(1.2, 0)).toBeNull();
    expect(marketCapSol(0.001, 10, 20)).toBe(0);
  });
});

describe('graduation and revenue', () => {
  it('pays the validator 70% of the raise and seeds DAMM v2 with the rest', () => {
    expect(upfrontToValidatorSol(5)).toBeCloseTo(3.5, 12);
    expect(dammSeedSol(5)).toBeCloseTo(1.5, 12);
  });

  it('averages per-epoch revenue in lamports, a missing epoch counting as zero', () => {
    expect(averageRevenueSol([2_000_000_000, null, 4_000_000_000n])).toBeCloseTo(2, 12);
    expect(averageRevenueSol([])).toBe(0);
  });
});
