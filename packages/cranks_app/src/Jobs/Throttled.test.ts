import { type Job } from './Job';
import { Throttled } from './Throttled';

describe('Throttled', () => {
  it('runs the job at most once per interval, the first time one interval after it was built', async () => {
    let now = 1_000;
    const runs: bigint[] = [];
    const job: Job = { name: 'UpdateScoreJob', run: async (epoch) => (runs.push(epoch), 'retry') };
    const throttled = new Throttled(job, 30 * 60_000, () => now);
    expect(throttled.name).toBe('UpdateScoreJob (every 30 min)');

    await expect(throttled.run(1n)).resolves.toBe('done');
    now += 30 * 60_000;
    await expect(throttled.run(2n)).resolves.toBe('retry');
    now += 60_000;
    await expect(throttled.run(3n)).resolves.toBe('done');
    now += 30 * 60_000;
    await throttled.run(4n);
    expect(runs).toEqual([2n, 4n]);
  });
});
