import { Logger } from '@epoch/logger';
import { type GrpcStream } from '@epoch/solana';

const logger = Logger.create('SlotStream');

/**
 * Subscribes to confirmed blocks and hands each one to the processors.
 * TODO(F4): build the SubscribeRequest from the saved cursor; decode blocks; write slot_fees,
 * validator_epochs and program_events; advance the cursor.
 */
export class SlotStream {
  constructor(private readonly stream: GrpcStream) {}

  async run(): Promise<void> {
    logger.info('slot stream not implemented yet (F4)');
    void this.stream;
  }
}
