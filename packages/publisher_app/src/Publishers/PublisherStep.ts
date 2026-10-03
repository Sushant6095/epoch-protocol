/** One thing the publisher loop does every interval. A step reads the chain first, so repeating it is harmless. */
export interface PublisherStep {
  readonly name: string;
  tick(): Promise<void>;
}
