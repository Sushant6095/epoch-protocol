import { type LaunchPriceSample, MemoryLaunchPriceStore } from './LaunchPriceStore';
import { LaunchPriceSampler } from './LaunchPriceSampler';

const sample = (t: number): LaunchPriceSample => ({ mint: 'mint-a', t: new Date(t), epoch: 1044, priceSol: 0.0008 });

describe('LaunchPriceSampler', () => {
  it('stores what the source reads, once per read time', async () => {
    const store = new MemoryLaunchPriceStore();
    const priceSamples = jest
      .fn()
      .mockResolvedValueOnce([sample(1_000)])
      .mockResolvedValueOnce([sample(1_000)])
      .mockResolvedValueOnce([sample(61_000)]);
    const sampler = new LaunchPriceSampler({ priceSamples }, store, 60_000);
    expect(await sampler.tick()).toBe(1);
    expect(await sampler.tick()).toBe(0);
    expect(await sampler.tick()).toBe(1);
    expect(await store.series('mint-a')).toHaveLength(2);
  });

  it('skips a pass while the previous one runs', async () => {
    let release: (value: LaunchPriceSample[]) => void = () => undefined;
    const pending = new Promise<LaunchPriceSample[]>((resolve) => {
      release = resolve;
    });
    const sampler = new LaunchPriceSampler({ priceSamples: () => pending }, new MemoryLaunchPriceStore(), 60_000);
    const first = sampler.tick();
    expect(await sampler.tick()).toBe(0);
    release([sample(1_000)]);
    expect(await first).toBe(1);
  });

  it('lets a failed read surface to the caller', async () => {
    const sampler = new LaunchPriceSampler(
      { priceSamples: () => Promise.reject(new Error('rpc down')) },
      new MemoryLaunchPriceStore(),
      60_000,
    );
    await expect(sampler.tick()).rejects.toThrow('rpc down');
    // The lock is released after a failure.
    await expect(sampler.tick()).rejects.toThrow('rpc down');
  });
});
