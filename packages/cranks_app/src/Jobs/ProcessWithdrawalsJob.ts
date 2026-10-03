import {
  juniorRatioBps,
  type PoolAccount,
  processWithdrawal,
  sharesToAssets,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('ProcessWithdrawalsJob');

/** At most this many queue entries per run; the runner comes back on its next tick. */
const MAX_PER_RUN = 32;

export type HeadVerdict = 'skip-cancelled' | 'bounce' | 'pay' | 'wait-for-cash';

/**
 * What `process_withdrawal` would do with the head request (`instructions/pool/process_withdrawal.rs`): a cancelled
 * request only advances the head; a junior request that would take junior below `min_junior_bps` is bounced (shares
 * back to the lender); otherwise it is paid whole if the pool has the cash, else it waits for the next sweep.
 */
export function headVerdict(pool: PoolAccount, request: WithdrawRequestAccount): HeadVerdict {
  if (request.cancelled) return 'skip-cancelled';
  const [assets, shares] =
    request.tranche === 'senior' ? [pool.seniorAssets, pool.seniorShares] : [pool.juniorAssets, pool.juniorShares];
  const payout = sharesToAssets(request.shares, assets, shares);
  if (request.tranche === 'junior' && pool.params.minJuniorBps > 0 && pool.seniorAssets > 0n) {
    const juniorAfter = pool.juniorAssets > payout ? pool.juniorAssets - payout : 0n;
    if (juniorRatioBps(pool.seniorAssets, juniorAfter) < BigInt(pool.params.minJuniorBps)) return 'bounce';
  }
  return pool.cash >= payout ? 'pay' : 'wait-for-cash';
}

/**
 * Works the withdrawal queue from its head, strictly in order (the program only accepts the head): pays, bounces
 * or skips each request until the queue is empty or the head is not payable yet (InsufficientLiquidity: it waits for
 * the next sweep). Runs after accrual at the boundary and then on every tick, so a request is paid as soon as cash
 * arrives.
 */
export class ProcessWithdrawalsJob implements Job {
  readonly name = 'ProcessWithdrawalsJob';
  private lastWaitingSeq?: bigint;

  constructor(private readonly chain: EpochChain) {}

  async run(_epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');

    for (let processed = 0; processed < MAX_PER_RUN; processed++) {
      const pool = await this.chain.pool();
      if (!pool || pool.account.withdrawHead >= pool.account.withdrawTail) return 'done';
      const seq = pool.account.withdrawHead;
      const request = await this.chain.withdrawRequest(seq);
      if (!request) {
        logger.error('the queue head request does not exist', undefined, { seq: seq.toString() });
        return 'done';
      }
      const verdict = headVerdict(pool.account, request);
      if (verdict === 'wait-for-cash') {
        if (this.lastWaitingSeq !== seq) {
          this.lastWaitingSeq = seq;
          logger.info('queue head waits for cash', { seq: seq.toString(), cash: pool.account.cash.toString() });
        }
        return 'done';
      }

      const result = await this.chain.execute(
        `process_withdrawal #${seq}`,
        processWithdrawal({
          programId: this.chain.programId,
          cranker,
          owner: request.owner,
          tranche: request.tranche,
          seq,
        }),
        'crank',
      );
      const meta = { seq: seq.toString(), tranche: request.tranche, verdict };
      if (result.status === 'simulated') return 'done'; // DRY_RUN: the head does not move
      if (result.status === 'sent') {
        logger.info('withdrawal request processed', { ...meta, signature: result.signature });
        continue;
      }
      const name = result.error?.name;
      if (name === 'NotHeadOfQueue') continue; // someone else processed it: re-read the head
      if (name === 'InsufficientLiquidity') return 'done';
      logger.error('process_withdrawal failed', undefined, { ...meta, reason: describeFailure(result) });
      return result.transient ? 'retry' : 'done';
    }
    return 'done';
  }
}
