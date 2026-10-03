/**
 * `done`: nothing left to do for this epoch (or nothing this job can fix). `retry`: waiting on the chain (epoch rewards
 * still paying out) or a transient failure; the runner calls the job again on its next tick.
 */
export type JobOutcome = 'done' | 'retry';

/**
 * One crank step. Every job reads the chain before acting and is safe to run any number of times in the same epoch:
 * a repeat is a no-op, or a transaction the program rejects harmlessly (already swept, already accrued...).
 */
export interface Job {
  readonly name: string;
  /** `epoch` is the Epoch program cluster's current epoch. */
  run(epoch: bigint): Promise<JobOutcome>;
}
