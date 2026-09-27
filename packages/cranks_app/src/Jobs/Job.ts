/** One step at an epoch boundary. Every job must be safe to run twice for the same epoch. */
export interface Job {
  readonly name: string;
  run(epoch: number): Promise<void>;
}
