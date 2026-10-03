import { accrue } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('AccrueJob');

/**
 * `accrue` once per epoch, after the sweeps (and defaults) so this epoch's income is in it: protocol fee, then the
 * senior coupon, junior keeps the rest. The program allows it once per epoch (`pool.last_accrued_epoch < epoch`).
 */
export class AccrueJob implements Job {
  readonly name = 'AccrueJob';

  constructor(private readonly chain: EpochChain) {}

  async run(epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const pool = await this.chain.pool();
    if (!pool) {
      logger.warn('the Pool is not initialized yet; nothing to accrue');
      return 'done';
    }
    if (pool.account.lastAccruedEpoch >= epoch) return 'done';

    const result = await this.chain.execute(
      `accrue ${epoch}`,
      accrue({ programId: this.chain.programId, cranker, treasury: pool.account.treasury }),
      'crank',
    );
    if (result.status !== 'failed') {
      logger.info('accrued', {
        epoch: epoch.toString(),
        income: pool.account.incomeUnallocated.toString(),
        status: result.status,
      });
      return 'done';
    }
    if (result.error?.name === 'AlreadyAccrued') return 'done';
    if (result.transient) {
      logger.warn('accrue failed; retrying next tick', { error: describeFailure(result) });
      return 'retry';
    }
    logger.error('accrue rejected by the program', undefined, { reason: describeFailure(result) });
    return 'done';
  }
}
