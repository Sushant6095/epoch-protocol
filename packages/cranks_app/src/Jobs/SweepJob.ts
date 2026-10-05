import { sweepPosition } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('SweepJob');

/**
 * `sweep` once per epoch for every Active, Late or Defaulted position not yet swept this epoch, after the cluster
 * has finished paying stake rewards (the program refuses with RewardsInProgress until then). Sweeping also records
 * the epoch's revenue and the late-epoch count, so positions without an advance are swept too. Released positions
 * are never swept. A position with a revenue token gets its token and buyback escrow passed (`sweepPosition`): the
 * program refuses the sweep without them, so the share always reaches the escrow.
 */
export class SweepJob implements Job {
  readonly name = 'SweepJob';

  constructor(private readonly chain: EpochChain) {}

  async run(epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    if (await this.chain.epochRewardsActive()) {
      logger.info('epoch rewards are still being distributed; sweeping after they finish', {
        epoch: epoch.toString(),
      });
      return 'retry';
    }

    const due = (await this.chain.positions()).filter(
      (p) => p.account.status !== 'released' && p.account.lastSweptEpoch < epoch,
    );
    let retry = false;
    for (const { account: position } of due) {
      const vote = position.vote.toBase58();
      const result = await this.chain.execute(
        `sweep ${vote}`,
        sweepPosition({ programId: this.chain.programId, cranker, position }),
        'crank',
      );
      if (result.status !== 'failed') continue;
      const name = result.error?.name;
      if (name === 'AlreadySweptThisEpoch') continue; // someone else swept it first
      if (result.transient || name === 'RewardsInProgress') {
        logger.warn('sweep failed; retrying next tick', { vote, error: describeFailure(result) });
        retry = true;
      } else {
        // Deterministic for this epoch (identity or authority changed outside the program, ledger guard...).
        logger.error('sweep rejected by the program', undefined, { vote, reason: describeFailure(result) });
      }
    }
    if (due.length > 0) logger.info('sweeps done', { epoch: epoch.toString(), positions: due.length, retry });
    return retry ? 'retry' : 'done';
  }
}
