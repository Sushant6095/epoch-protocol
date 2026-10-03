import { type Job, type JobOutcome } from './Job';

/**
 * Runs `job` at most once per `intervalMs`, counting from construction (so a job that also runs at the boundary is
 * not repeated in the same tick). Between runs it answers `done` without calling the job.
 */
export class Throttled implements Job {
  readonly name: string;
  private lastRun: number;

  constructor(
    private readonly job: Job,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.name = `${job.name} (every ${Math.round(intervalMs / 60_000)} min)`;
    this.lastRun = now();
  }

  async run(epoch: bigint): Promise<JobOutcome> {
    if (this.now() - this.lastRun < this.intervalMs) return 'done';
    this.lastRun = this.now();
    return this.job.run(epoch);
  }
}
