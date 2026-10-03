import { ACCOUNT_SIZES, bpsOf, type FeeQuoteAccount, postQuote, withdrawQuote } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { type ChainClock, describeFailure, type PublisherChain } from '../Chain/PublisherChain';
import { type PublisherStep } from './PublisherStep';

const logger = Logger.create('QuoteMaker');

/** Kept on top of each quote's collateral and rent for transaction fees. */
const FEE_MARGIN_LAMPORTS = 10_000_000n;

export interface QuoteMakerOptions {
  /** QUOTE_MAX_NOTIONAL_SOL in lamports. */
  maxNotional: bigint;
  /** QUOTE_MAX_MOVE_BPS: payoff clip; collateral = max notional × max move. */
  maxMoveBps: number;
  /** QUOTE_EPOCHS_AHEAD: quote program epochs current+1 … current+N. */
  epochsAhead: number;
  /** QUOTE_SPREAD_BPS: fixed rate = last final value × (10,000 + spread) / 10,000. */
  spreadBps: number;
}

/** The quote's fixed rate from the last final Fee Index value: never below 1 (`post_quote` rejects 0). */
export function fixedRateFor(lastFinalValue: bigint, spreadBps: number): bigint {
  const rate = (lastFinalValue * BigInt(10_000 + spreadBps)) / 10_000n;
  return rate > 0n ? rate : 1n;
}

/** A quote can be withdrawn once its epoch has started or its expiry slot has passed (`withdraw_quote`). */
export const quoteFinished = (quote: FeeQuoteAccount, clock: ChainClock): boolean =>
  clock.epoch >= quote.epoch || clock.slot >= quote.expirySlot;

/**
 * Epoch's seeded market maker (ADR 0004, decision 21), signing with the MAKER key. Each tick:
 *
 * - `withdraw_quote` for every one of its quotes whose epoch has started (or whose expiry slot passed) once no swap is
 *   open against it (cranks_app settles them); the account closes and the collateral comes back;
 * - `post_quote` for every program epoch current+1 … current+N without a quote: fixed rate = the last final Fee Index
 *   value (± QUOTE_SPREAD_BPS), max notional, max move, expiry = the first slot of that epoch (trading closes when the
 *   epoch starts). The program requires the epoch to be after both the cluster's epoch and the last final index
 *   epoch, and the pool not paused; quotes start once there is a final value to anchor them.
 */
export class QuoteMaker implements PublisherStep {
  readonly name = 'QuoteMaker';
  private lastNotice?: string;

  constructor(
    private readonly chain: PublisherChain,
    private readonly options: QuoteMakerOptions,
  ) {}

  async tick(): Promise<void> {
    const maker = this.chain.keyOf('maker');
    if (!maker) return;
    const [index, pool, clock, quotes] = await Promise.all([
      this.chain.feeIndex(),
      this.chain.pool(),
      this.chain.clock(),
      this.chain.quotes(maker),
    ]);
    if (!index || !pool) return this.notice('the Pool or FeeIndex is not initialized yet');

    for (const { account: quote } of quotes) {
      if (!quoteFinished(quote, clock)) continue;
      if (quote.openSwaps > 0) {
        logger.debug('finished quote waits for its swaps to settle', {
          epoch: quote.epoch.toString(),
          openSwaps: quote.openSwaps,
        });
        continue;
      }
      const result = await this.chain.execute(
        `withdraw_quote ${quote.epoch}`,
        withdrawQuote({ programId: this.chain.programId, maker, epoch: quote.epoch }),
        'maker',
      );
      if (result.status === 'failed') {
        logger.error('withdraw_quote failed', undefined, {
          epoch: quote.epoch.toString(),
          reason: describeFailure(result),
        });
      } else {
        logger.info('quote withdrawn', { epoch: quote.epoch.toString(), status: result.status });
      }
    }

    if (pool.paused) return this.notice('the pool is paused: no new quotes');
    if (index.finalizedSlot === 0n || index.value === 0n) {
      return this.notice('no final Fee Index value yet: quotes start after the first finalize_index');
    }

    const { maxNotional, maxMoveBps, epochsAhead, spreadBps } = this.options;
    const fixedRate = fixedRateFor(index.value, spreadBps);
    const collateral = bpsOf(maxNotional, maxMoveBps);
    const quoted = new Set(quotes.map((q) => q.account.epoch));
    const missing: bigint[] = [];
    for (let i = 1; i <= epochsAhead; i++) {
      const epoch = clock.epoch + BigInt(i);
      if (!quoted.has(epoch) && epoch > index.epoch) missing.push(epoch);
    }
    if (missing.length === 0) return;

    const perQuote = collateral + (await this.chain.rentExemptMinimum(ACCOUNT_SIZES.FeeQuote)) + FEE_MARGIN_LAMPORTS;
    let balance = await this.chain.balance(maker);
    for (const epoch of missing) {
      if (balance < perQuote) {
        return this.notice(
          `maker balance ${balance} lamports cannot fund the quote for epoch ${epoch} (needs ${perQuote}: ` +
            `${collateral} collateral + rent + fees); fund ${maker.toBase58()}`,
          'warn',
        );
      }
      const expirySlot = await this.chain.firstSlotOfEpoch(epoch);
      if (expirySlot <= clock.slot) continue;
      const result = await this.chain.execute(
        `post_quote ${epoch}`,
        postQuote({ programId: this.chain.programId, maker, epoch, fixedRate, maxNotional, maxMoveBps, expirySlot }),
        'maker',
      );
      const meta = {
        epoch: epoch.toString(),
        fixedRate: fixedRate.toString(),
        maxNotional: maxNotional.toString(),
        maxMoveBps,
        expirySlot: expirySlot.toString(),
      };
      if (result.status === 'failed') {
        logger.error('post_quote failed', undefined, { ...meta, reason: describeFailure(result) });
        continue;
      }
      logger.info('quote posted', { ...meta, status: result.status });
      if (result.status === 'sent') {
        balance -= perQuote;
        this.lastNotice = undefined;
      }
    }
  }

  /** Logs a reason to do nothing once, not on every tick. */
  private notice(message: string, level: 'info' | 'warn' = 'info'): void {
    if (message === this.lastNotice) return;
    this.lastNotice = message;
    logger[level](message);
  }
}
