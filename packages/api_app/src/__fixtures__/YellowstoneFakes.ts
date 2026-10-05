import { readFileSync } from 'fs';
import { join } from 'path';

import { type GrpcStreamOptions, type GrpcStreamStatus, type SubscribeRequest, SubscribeUpdate } from '@epoch/solana';

import { type GrpcStreamLike } from '../Sources/SolamiStream';

/** Real Yellowstone wire bytes for api_app's subscription (see the file's `source`). */
export const YELLOWSTONE_PROGRAM = JSON.parse(readFileSync(join(__dirname, 'yellowstone-program.json'), 'utf8')) as {
  source: string;
  program: string;
  updates: { label: string; signature?: string; base64: string }[];
};

/** Decodes one fixture update with the real protobuf codec, as the native client does. */
export const fixtureUpdate = (index: number): SubscribeUpdate =>
  SubscribeUpdate.decode(Buffer.from(YELLOWSTONE_PROGRAM.updates[index].base64, 'base64'));

/** A stand-in for GrpcStream that the test drives: state changes, updates, a refusal. */
export class FakeGrpc implements GrpcStreamLike {
  request?: SubscribeRequest;
  stopped = false;
  private onUpdate?: (update: SubscribeUpdate) => Promise<void> | void;
  private finish!: (error?: Error) => void;
  private readonly done = new Promise<void>((resolve, reject) => {
    this.finish = (error) => (error ? reject(error) : resolve());
  });

  constructor(readonly options: GrpcStreamOptions) {}

  async run(build: () => SubscribeRequest, onUpdate: (update: SubscribeUpdate) => Promise<void> | void) {
    this.request = build();
    this.onUpdate = onUpdate;
    return this.done;
  }

  stop(): void {
    this.stopped = true;
    this.finish();
  }

  status(status: GrpcStreamStatus): void {
    this.options.onState?.({ status, endpoint: 'solami', reconnects: 0 });
  }

  async deliver(update: SubscribeUpdate): Promise<void> {
    await this.onUpdate?.(update);
  }

  /** The server refused the stream (run() rejects, as GrpcStream does for a fatal error). */
  refuse(error: Error): void {
    this.finish(error);
  }
}
