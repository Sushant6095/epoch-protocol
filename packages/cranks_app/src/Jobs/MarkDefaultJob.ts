import { markDefault, PROGRAM_CONSTANTS } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('MarkDefaultJob');

/**
 * `mark_default` for every open advance the program would accept (`instructions/credit/mark_default.rs`): the
 * position's open advance, still `Open`, and either `late_epochs >= 3` (DEFAULT_AFTER_LATE_EPOCHS) or
 * `epoch >= opened_epoch + max_advance_epochs`. Runs after the sweeps, so this epoch's late count is in, and before
 * accrual and withdrawals, so nobody exits at a price that ignores a known loss. Every candidate is simulated first
 * and sent only if the simulation passes.
 */
export class MarkDefaultJob implements Job {
  readonly name = 'MarkDefaultJob';

  constructor(private readonly chain: EpochChain) {}

  async run(epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const pool = await this.chain.pool();
    if (!pool) return 'done';
    const maxAdvanceEpochs = BigInt(pool.account.params.maxAdvanceEpochs);

    let retry = false;
    for (const { account: position } of await this.chain.positions()) {
      if (!position.openAdvance || (position.status !== 'active' && position.status !== 'late')) continue;
      const advance = await this.chain.advance(position.openAdvance);
      if (!advance || advance.state !== 'open') continue;

      const tooLate = position.lateEpochs >= PROGRAM_CONSTANTS.DEFAULT_AFTER_LATE_EPOCHS;
      const tooOld = epoch >= advance.openedEpoch + maxAdvanceEpochs;
      if (!tooLate && !tooOld) continue;

      const vote = position.vote.toBase58();
      const instructions = markDefault({
        programId: this.chain.programId,
        cranker,
        vote: position.vote,
        advance: position.openAdvance,
      });
      const meta = {
        vote,
        lateEpochs: position.lateEpochs,
        openedEpoch: advance.openedEpoch.toString(),
        tooLate,
        tooOld,
      };
      const simulation = await this.chain.simulate(`mark_default ${vote}`, instructions, 'crank');
      if (simulation.status === 'failed') {
        logger.warn('mark_default simulation failed; not sent', { ...meta, error: describeFailure(simulation) });
        if (simulation.transient) retry = true;
        continue;
      }
      if (this.chain.dryRun) {
        logger.info('DRY_RUN: would mark the advance defaulted', meta);
        continue;
      }
      const result = await this.chain.execute(`mark_default ${vote}`, instructions, 'crank');
      if (result.status === 'failed') {
        logger.error('mark_default failed', undefined, { ...meta, reason: describeFailure(result) });
        if (result.transient) retry = true;
      } else {
        logger.warn('advance marked defaulted', { ...meta, status: result.status });
      }
    }
    return retry ? 'retry' : 'done';
  }
}
