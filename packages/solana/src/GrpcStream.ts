import { sleep } from '@epoch/common';
import { Logger } from '@epoch/logger';
import Client, { type SubscribeRequest, type SubscribeUpdate } from '@triton-one/yellowstone-grpc';

export interface GrpcEndpoint {
  name: string;
  url: string;
  token?: string;
}

const logger = Logger.create('GrpcStream');

/**
 * Yellowstone gRPC subscription with reconnect and endpoint failover
 * (Solami primary, RPC Fast secondary). The caller builds the request, e.g. from a saved slot.
 */
export class GrpcStream {
  private stopped = false;

  constructor(private readonly endpoints: GrpcEndpoint[]) {}

  async run(buildRequest: () => SubscribeRequest, onUpdate: (update: SubscribeUpdate) => Promise<void>): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const endpoint = this.endpoints[attempt % this.endpoints.length];
      try {
        logger.info('connecting', { endpoint: endpoint.name });
        const client = new Client(endpoint.url, endpoint.token, undefined);
        const stream = await client.subscribe();
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (update: SubscribeUpdate) => {
            onUpdate(update).catch((error) => stream.destroy(error as Error));
          });
          stream.on('error', reject);
          stream.on('end', resolve);
          stream.write(buildRequest(), (error: Error | null | undefined) => (error ? reject(error) : undefined));
        });
        attempt = 0;
      } catch (error) {
        attempt++;
        logger.error('stream failed, reconnecting', error, { endpoint: endpoint.name, attempt });
        await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
