import { finalizeIndex } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('FinalizeIndexJob');

/**
 * `finalize_index` as soon as a pending Fee Index proposal's dispute window has passed
 * (`slot >= proposed_slot + dispute_window_slots`, `instructions/market/index.rs`). Anyone may call it; nothing else
 * does, and `post_index` refuses the next epoch while a proposal is pending, so the minute poller runs this every
 * tick.
 */
export class FinalizeIndexJob implements Job {
  readonly name = 'FinalizeIndexJob';
  private waitingFor?: bigint;

  constructor(private readonly chain: EpochChain) {}

  async run(_epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const index = await this.chain.feeIndex();
    if (!index?.account.hasProposal) return 'done';
    const { proposedEpoch, proposedSlot, disputeWindowSlots } = index.account;

    const { slot } = await this.chain.clock();
    const finalizableAt = proposedSlot + disputeWindowSlots;
    if (slot < finalizableAt) {
      if (this.waitingFor !== proposedEpoch) {
        this.waitingFor = proposedEpoch;
        logger.info('proposal in its dispute window', {
          proposedEpoch: proposedEpoch.toString(),
          finalizableAtSlot: finalizableAt.toString(),
          slotsLeft: (finalizableAt - slot).toString(),
        });
      }
      return 'done';
    }

    const result = await this.chain.execute(
      `finalize_index ${proposedEpoch}`,
      finalizeIndex({ programId: this.chain.programId, cranker }),
      'crank',
    );
    if (result.status === 'failed') {
      // NoProposal: finalized (or vetoed) in the meantime. DisputeWindowOpen: our RPC is ahead of the leader.
      const benign = result.error?.name === 'NoProposal' || result.error?.name === 'DisputeWindowOpen';
      if (benign) logger.info('finalize_index not needed', { error: result.error?.name });
      else logger.error('finalize_index failed', undefined, { reason: describeFailure(result) });
      return result.transient ? 'retry' : 'done';
    }
    logger.info('Fee Index finalized', {
      epoch: proposedEpoch.toString(),
      value: index.account.proposedValue.toString(),
      status: result.status,
    });
    return 'done';
  }
}
