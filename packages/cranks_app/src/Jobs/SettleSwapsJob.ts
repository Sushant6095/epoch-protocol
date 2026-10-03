import { type FeeIndexAccount, feeIndexValueFor, PROGRAM_CONSTANTS, settleSwap } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('SettleSwapsJob');

/** Settle transactions per tick; the poller comes back a minute later for the rest. */
const MAX_SETTLES_PER_TICK = 20;
/** Error-log a swap whose epoch is this many finalizations or fewer from leaving the on-chain history. */
export const HISTORY_ALERT_REMAINING = 3;

/**
 * How many more `finalize_index` calls a final value for `epoch` survives. The FeeIndex keeps the current final
 * value plus the last INDEX_HISTORY (16) earlier ones (`FeeIndex::value_for`); each finalize pushes the previous value
 * into the 16-entry ring, so a value with `k` newer final values is gone once `k` reaches 17. Returns null when
 * `epoch` has no final value (not final yet, never posted, vetoed, or already evicted).
 */
export function finalizationsLeft(index: FeeIndexAccount, epoch: bigint): number | null {
  if (feeIndexValueFor(index, epoch) === null) return null;
  const newerInHistory = index.history.slice(0, index.historyCount).filter((p) => p.epoch > epoch).length;
  const newer = newerInHistory + (index.finalizedSlot > 0n && index.epoch > epoch ? 1 : 0);
  return PROGRAM_CONSTANTS.INDEX_HISTORY - newer;
}

/**
 * `settle_swap` for every open swap whose epoch has a final Fee Index value (cranker = crank key, taker = the swap's
 * taker, who receives collateral ± P&L and the rent). Runs every minute. A swap must settle while its value is still
 * in the program's 16-entry history, otherwise it can never settle and its collateral stays locked: those are logged
 * as errors (alerts), both when they get close and when it is too late.
 */
export class SettleSwapsJob implements Job {
  readonly name = 'SettleSwapsJob';
  private alerted = new Set<string>();

  constructor(private readonly chain: EpochChain) {}

  async run(_epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const index = await this.chain.feeIndex();
    if (!index) return 'done';
    const swaps = (await this.chain.swaps())
      .filter((s) => !s.account.settled)
      .sort((a, b) => (a.account.epoch < b.account.epoch ? -1 : a.account.epoch > b.account.epoch ? 1 : 0));

    let sent = 0;
    let retry = false;
    for (const { address, account: swap } of swaps) {
      const meta = { swap: address.toBase58(), epoch: swap.epoch.toString(), taker: swap.taker.toBase58() };
      const left = finalizationsLeft(index.account, swap.epoch);
      if (left === null) {
        const lastFinal = index.account.finalizedSlot > 0n ? index.account.epoch : -1n;
        if (swap.epoch <= lastFinal) {
          this.alertOnce(
            `lost ${meta.swap}`,
            'ALERT: swap can never settle on-chain: its epoch has no final value in the FeeIndex (never posted, vetoed, or older than the 16-entry history); its collateral is locked',
            meta,
          );
        }
        continue; // not final yet: the publisher posts, the finalize job finalizes
      }
      if (left <= HISTORY_ALERT_REMAINING) {
        this.alertOnce(`close ${meta.swap}`, 'ALERT: swap is about to leave the 16-entry history unsettled', {
          ...meta,
          finalizationsLeft: left,
        });
      }
      if (sent >= MAX_SETTLES_PER_TICK) continue;
      sent++;

      const result = await this.chain.execute(
        `settle_swap ${meta.swap}`,
        settleSwap({ programId: this.chain.programId, cranker, quote: swap.quote, taker: swap.taker }),
        'crank',
      );
      if (result.status === 'failed') {
        logger.error('settle_swap failed', undefined, { ...meta, reason: describeFailure(result) });
        if (result.transient) retry = true;
      } else {
        logger.info('swap settled', {
          ...meta,
          side: swap.side,
          notional: swap.notional.toString(),
          status: result.status,
        });
      }
    }
    return retry ? 'retry' : 'done';
  }

  private alertOnce(key: string, message: string, meta: Record<string, unknown>): void {
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    logger.error(message, undefined, meta);
  }
}
