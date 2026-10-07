import { type FeeIndexAccount, finalizeIndex, indexBallotStatus, submitIndexBallot } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type PublicKey } from '@solana/web3.js';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('FinalizeIndexJob');

/** Program errors that mean "someone else got there first", not a fault. */
const BENIGN_SUBMIT = new Set(['DisputeWindowOpen', 'BallotAlreadyProposed', 'IndexEpochNotNewer']);

/**
 * Moves the Fee Index from agreed to final. Anyone may call these instructions; nothing else does, so the minute
 * poller runs this every tick:
 *
 * - `finalize_index` as soon as a pending proposal's dispute window has passed
 *   (`slot >= proposed_slot + dispute_window_slots`, `instructions/market/index.rs`);
 * - with no proposal pending, `submit_index_ballot` for the lowest operator-consensus ballot that reached its
 *   threshold while the FeeIndex could not take it (an earlier proposal in its window, or a move above
 *   `max_move_bps`): status `queued`, `instructions/market/index_ballot.rs`;
 * - otherwise it waits, logging the progress of a ballot that is still voting (agreeing weight against the threshold),
 *   once per change.
 */
export class FinalizeIndexJob implements Job {
  readonly name = 'FinalizeIndexJob';
  private waitingFor?: bigint;
  private lastNotice?: string;

  constructor(private readonly chain: EpochChain) {}

  async run(_epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const index = await this.chain.feeIndex();
    if (!index) return 'done';
    if (!index.account.hasProposal) return this.submitQueued(index.account, cranker);
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

  /** No proposal pending: submit the lowest queued consensus, or report the ballot still voting. */
  private async submitQueued(index: FeeIndexAccount, cranker: PublicKey): Promise<JobOutcome> {
    const open = (await this.chain.indexBallots())
      .map(({ account }) => ({ ballot: account, status: indexBallotStatus(account, index) }))
      .filter(({ status }) => status !== 'settled')
      .sort((a, b) => (a.ballot.epoch < b.ballot.epoch ? -1 : 1));

    const queued = open.find(({ status }) => status === 'queued')?.ballot;
    if (!queued) {
      const voting = open.find(({ status }) => status === 'voting')?.ballot;
      if (voting) {
        this.noticeOnce('ballot voting', {
          epoch: voting.epoch.toString(),
          round: voting.round,
          votesCast: voting.votesCast,
          operators: voting.operatorCount,
          agreeingWeight: voting.agreeingWeight.toString(),
          totalWeight: voting.totalWeight.toString(),
          thresholdBps: voting.thresholdBps,
          medianValue: voting.medianValue.toString(),
        });
      }
      return 'done';
    }

    const result = await this.chain.execute(
      `submit_index_ballot ${queued.epoch}`,
      submitIndexBallot({ programId: this.chain.programId, cranker, epoch: queued.epoch }),
      'crank',
    );
    const meta = { epoch: queued.epoch.toString(), value: queued.consensusValue.toString() };
    if (result.status === 'failed') {
      const name = result.error?.name;
      if (name && BENIGN_SUBMIT.has(name)) {
        logger.info('submit_index_ballot not needed', { ...meta, error: name });
      } else if (name === 'IndexMoveTooLarge') {
        // Deterministic until the admin widens max_move_bps (configure_index) or vetoes and re-runs the ballot.
        this.noticeOnce('agreed value moves more than max_move_bps: the admin decides', meta, 'error');
      } else {
        logger.error('submit_index_ballot failed', undefined, { ...meta, reason: describeFailure(result) });
      }
      return result.transient ? 'retry' : 'done';
    }
    this.lastNotice = undefined;
    logger.info('queued Fee Index consensus proposed', { ...meta, status: result.status });
    return 'done';
  }

  private noticeOnce(message: string, meta: Record<string, unknown>, level: 'info' | 'error' = 'info'): void {
    const key = `${message}:${JSON.stringify(meta)}`;
    if (key === this.lastNotice) return;
    this.lastNotice = key;
    if (level === 'error') logger.error(message, undefined, meta);
    else logger.info(message, meta);
  }
}
